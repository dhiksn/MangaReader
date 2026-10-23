const express = require('express');
const { validateTargetUrl } = require('../middlewares/security');
const { createNotFound, createBadGateway } = require('../utils/errors');

const router = express.Router();

/**
 * GET /api/proxy/image?url=https://...
 * Proxies image requests with URL validation, SSRF protection,
 * correct Referer headers, and automatic CDN failover.
 */
router.get('/image', async (req, res, next) => {
  try {
    const rawUrl = req.query.url;
    // URL validation & SSRF protection
    const targetUrl = validateTargetUrl(rawUrl);

    // Auto-attach Softkomik imageToken (?id=T4Kmwztku) if missing or separated in query
    if (targetUrl.hostname.includes('komik.im') || targetUrl.hostname.includes('softkomik')) {
      if (!targetUrl.searchParams.has('id')) {
        targetUrl.searchParams.set('id', req.query.id || 'T4Kmwztku');
      }
    }

    let referer = req.query.referer;
    if (!referer) {
      if (
        targetUrl.hostname.includes('komik.im') ||
        targetUrl.hostname.includes('softkomik') ||
        targetUrl.hostname.includes('softdevices')
      ) {
        referer = 'https://softkomik.app/';
      } else if (targetUrl.hostname.includes('komiku')) {
        referer = 'https://komiku.org/';
      } else if (targetUrl.hostname.includes('hwago') || targetUrl.hostname.includes('imgsvr.my.id')) {
        referer = 'https://02.hwago.xyz/';
      } else if (
        targetUrl.hostname.includes('desu') ||
        targetUrl.hostname.includes('doujin')
      ) {
        referer = 'https://doujin.desu.xxx/';
      } else if (
        targetUrl.hostname.includes('shngm') ||
        targetUrl.hostname.includes('shinigami')
      ) {
        referer = 'https://id.shinigami.asia/';
      } else {
        referer = `${targetUrl.protocol}//${targetUrl.hostname}/`;
      }
    }

    // Ensure trailing slash on origin referers
    if (
      referer.endsWith('.app') ||
      referer.endsWith('.org') ||
      referer.endsWith('.id') ||
      referer.endsWith('.xxx') ||
      referer.endsWith('.asia')
    ) {
      referer += '/';
    }

    const fetchHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Referer: referer,
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    };

    let upstreamRes;
    try {
      upstreamRes = await fetch(targetUrl.toString(), {
        headers: fetchHeaders,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw createBadGateway(
          'Target CDN gagal diakses (waktu tunggu habis setelah 15s)',
          'UPSTREAM_TIMEOUT'
        );
      }
      throw createBadGateway(
        `Target CDN gagal diakses: ${err.message || 'Koneksi terputus'}`,
        'UPSTREAM_ERROR'
      );
    }

    // If redirected to anti-leech / block image (e.g. baca-image.jpeg), auto-fallback to alternate CDN
    if (upstreamRes.url && upstreamRes.url.includes('baca-image')) {
      let alternateUrl = targetUrl.toString();
      if (targetUrl.hostname.includes('image.komik.im')) {
        alternateUrl = targetUrl.toString().replace('https://image.komik.im/softkomik', 'https://psy1.komik.im');
      } else if (targetUrl.hostname.includes('psy1.komik.im')) {
        alternateUrl = targetUrl.toString().replace('https://psy1.komik.im', 'https://image.komik.im/softkomik');
      }

      try {
        upstreamRes = await fetch(alternateUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Referer: 'https://softkomik.app/',
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(15000),
        });
      } catch (_) {}
    }

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 404) {
        throw createNotFound('Gambar tidak ditemukan pada server target CDN', 'NOT_FOUND');
      }
      throw createBadGateway(
        `Target server CDN mengembalikan error HTTP ${upstreamRes.status}`,
        'UPSTREAM_ERROR'
      );
    }

    const contentType = upstreamRes.headers.get('content-type') || 'image/webp';
    res.setHeader('Content-Type', contentType);

    // If still blocked, do not let browser cache the error!
    if (upstreamRes.url && upstreamRes.url.includes('baca-image')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    const arrayBuffer = await upstreamRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
