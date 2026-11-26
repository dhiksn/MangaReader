const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class CgbumSource extends BaseSource {
  constructor() {
    super('cgbum', 'CGBUM');
    this.baseUrl = 'https://cgbum.com';
    this.icon = `${this.baseUrl}/favicon.ico`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest',  name: 'Terbaru' },
      { id: 'newest',  name: 'Diperbarui' },
      { id: 'oldest',  name: 'Terlama' },
      { id: 'popular', name: 'Populer' },
    ];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _slugFromUrl(href) {
    if (!href) return null;
    const m = href.match(/\/komik\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  _chapterNumFromUrl(href) {
    if (!href) return null;
    const m = href.match(/\/chapter\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  _resolveSort(raw) {
    const map = {
      latest:  'latest',
      newest:  'newest',
      oldest:  'oldest',
      popular: 'views',
      views:   'views',
      update:  'latest',
    };
    return map[String(raw || '').toLowerCase()] || 'latest';
  }

  _parsePagination($, currentPage) {
    let maxPage = currentPage;
    // Try to find total pages from URL in next page link
    const nextHref = $('a.page-nav-next').attr('href') || '';
    const nextPageMatch = nextHref.match(/page=(\d+)/);
    if (nextPageMatch) {
      const nextPageNum = parseInt(nextPageMatch[1], 10);
      if (!isNaN(nextPageNum) && nextPageNum - 1 > maxPage) {
        maxPage = nextPageNum - 1; // We're on maxPage at minimum
      }
    }
    // Also scan numbered page buttons
    $('a.page-btn, a[href*="page="]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const pm = href.match(/page=(\d+)/);
      if (pm) {
        const n = parseInt(pm[1], 10);
        if (!isNaN(n) && n > maxPage) maxPage = n;
      }
    });
    const hasNextPage = $('a.page-nav-next').length > 0 && !$('a.page-nav-next').hasClass('disabled');
    if (hasNextPage && maxPage <= currentPage) maxPage = currentPage + 1;
    return { maxPage, hasNextPage };
  }

  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('.comic-card').each((_, el) => {
      const coverLink = $(el).find('a.comic-card-cover').first();
      const href = coverLink.attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('.comic-card-title a, .comic-card-title').first().text().trim();
      if (!title) return;

      const cover = coverLink.find('img').attr('src') || null;

      // Type from badge: badge-type-manhwa → "manhwa"
      const badgeClass = $(el).find('[class*="badge-type-"]').attr('class') || '';
      const typeMatch = badgeClass.match(/badge-type-(manga|manhwa|manhua|pornhwa|comic|novel|game)/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : null;

      // Status from badge
      const statusBadge = $(el).find('[class*="badge-status"], [class*="status-"]').first();
      const statusClass = statusBadge.attr('class') || '';
      let status = null;
      if (statusClass.includes('ongoing')) status = 'ongoing';
      else if (statusClass.includes('tamat') || statusClass.includes('completed')) status = 'completed';
      else {
        const statusText = statusBadge.text().trim().toLowerCase();
        if (statusText) status = statusText;
      }

      // Latest chapter
      const chText = $(el).find('.comic-card-chapter a').first().text().trim();
      const chMatch = chText.match(/Ch\.\s*([0-9.]+)/i);
      const latestChapter = chMatch ? chMatch[1] : chText || null;

      items.push({ title, slug, cover, type, status, latestChapter });
    });

    return items;
  }

  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { data, maxPage, hasNextPage };
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/daftar-komik?type=&status=&sort=latest&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/daftar-komik?type=&status=&sort=views&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/daftar-komik?type=&status=&sort=newest&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getOldest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/daftar-komik?type=&status=&sort=oldest&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = this._resolveSort(options.order || options.sort || 'latest');
    const params = new URLSearchParams({ type: options.type || '', status: options.status || '', sort, page: pageNum });
    const url = `${this.baseUrl}/daftar-komik?${params.toString()}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const q = encodeURIComponent(String(query || '').trim());
    const sortMap = {
      relevance: 'relevance', relevan: 'relevance',
      latest: 'latest', terbaru: 'latest',
      popular: 'popular', populer: 'popular',
      chapters: 'chapters',
    };
    const sort = sortMap[String(options.sort || options.order || '').toLowerCase()] || 'relevance';
    const url = `${this.baseUrl}/cari?q=${q}&sort=${sort}&page=${pageNum}`;
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, query: String(query || '').trim(), sort, page: pageNum, maxPage, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }
    const html = await getHtml(`${this.baseUrl}/daftar-komik?sort=latest`, {
      headers: { Referer: `${this.baseUrl}/` },
    });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    $('input[name="genres[]"]').each((_, el) => {
      const val = $(el).val()?.trim();
      if (!val || seen.has(val.toLowerCase())) return;
      seen.add(val.toLowerCase());
      const slug = val.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      genres.push({ name: val, slug });
    });

    genres.sort((a, b) => a.name.localeCompare(b.name, 'id'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const sort = this._resolveSort(options.order || options.sort || 'latest');
    const allGenres = await this.getGenres();

    // Max 3 genres
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean).slice(0, 3);
    const found = keys.map((key) => {
      const match = allGenres.find(
        (g) => g.slug === key.toLowerCase() ||
               g.name.toLowerCase() === key.toLowerCase()
      );
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di CGBUM`, 'NOT_FOUND');
      return match;
    });

    // genres[] uses the original value (case-sensitive from site)
    const genreParams = found.map((g) => `genres[]=${encodeURIComponent(g.name)}`).join('&');
    const url = `${this.baseUrl}/daftar-komik?${genreParams}&sort=${sort}&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, genre: found.map((g) => g.name).join(', '), page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua', 'pornhwa'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const sort = this._resolveSort(options.order || options.sort || 'latest');
    const url = `${this.baseUrl}/daftar-komik?type=${encodeURIComponent(cleanType)}&status=&sort=${sort}&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/komik/${cleanSlug}`;
    let html;
    try {
      html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di CGBUM`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1').first().text()
      .replace(/\s*Bahasa Indonesia\s*/gi, '').trim() || cleanSlug;

    const altTitle = $('.comic-alt-title').text().trim() || null;
    const cover = $('.comic-cover img, .comic-thumbnail img').first().attr('src') ||
                  $('img[alt]').filter((_, el) => $(el).attr('alt')?.toLowerCase().includes(title.toLowerCase().slice(0, 10))).first().attr('src') ||
                  null;

    // Synopsis
    const synopsis = $('.synopsis-content').text().trim() || null;

    // Meta: Tipe, Author, Tahun
    let type = null, author = null, status = null;
    $('.meta-row').each((_, el) => {
      const label = $(el).find('.meta-label').text().trim().toLowerCase();
      const value = $(el).find('.meta-value').text().trim();
      if (!value || value === '-') return;
      if (label === 'tipe' || label === 'type') type = value.toLowerCase();
      else if (label === 'author') author = value;
      else if (label === 'status') {
        const v = value.toLowerCase();
        if (v.includes('ongoing') || v.includes('berjalan')) status = 'ongoing';
        else if (v.includes('tamat') || v.includes('completed')) status = 'completed';
        else if (v.includes('hiatus')) status = 'hiatus';
        else status = v;
      }
    });

    // Status from badge if not found in meta
    if (!status) {
      const statusBadge = $('[class*="badge-status"], [class*="status-ongoing"], [class*="status-tamat"]').first();
      const sc = statusBadge.attr('class') || '';
      if (sc.includes('ongoing')) status = 'ongoing';
      else if (sc.includes('tamat') || sc.includes('completed')) status = 'completed';
    }

    // Genres from .comic-genres .genre-pill
    const genres = [];
    const seenG = new Set();
    $('.comic-genres .genre-pill, .genre-pill').each((_, el) => {
      const name = $(el).text().trim();
      const href = $(el).attr('href') || '';
      const gMatch = href.match(/\/genre\/([^/?#]+)/);
      const rawSlug = gMatch ? decodeURIComponent(gMatch[1]) : name;
      const genreSlug = rawSlug.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!name || seenG.has(name)) return;
      seenG.add(name);
      genres.push({ name, slug: genreSlug || name.toLowerCase().replace(/\s+/g, '-') });
    });

    // Chapters — from .chapter-grid .ch-grid-item
    const chapters = [];
    $('.ch-grid-item').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href) return;
      const chNum = this._chapterNumFromUrl(href);
      const chTitle = $(el).text().trim() || (chNum ? `Chapter ${chNum}` : null);
      if (!chTitle) return;
      chapters.push({
        title: chTitle,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
      });
    });

    // Related — "Baca Juga" section
    const related = [];
    const seenR = new Set();
    $('.section-header').each((_, hdr) => {
      if (!$(hdr).find('h2').text().trim().toLowerCase().includes('baca')) return;
      $(hdr).next('.comic-grid').find('.comic-card').each((__, card) => {
        const a = $(card).find('a.comic-card-cover').first();
        const href = a.attr('href') || '';
        const relSlug = this._slugFromUrl(href);
        const relTitle = $(card).find('.comic-card-title a, .comic-card-title').first().text().trim();
        if (!relSlug || !relTitle || seenR.has(relSlug)) return;
        seenR.add(relSlug);
        const relCover = a.find('img').attr('src') || null;
        const relTypeClass = $(card).find('[class*="badge-type-"]').attr('class') || '';
        const relTypeMatch = relTypeClass.match(/badge-type-(manga|manhwa|manhua|pornhwa|comic|novel|game)/i);
        const relType = relTypeMatch ? relTypeMatch[1].toLowerCase() : null;
        const relStatusClass = $(card).find('[class*="badge-status"]').attr('class') || '';
        let relStatus = null;
        if (relStatusClass.includes('ongoing')) relStatus = 'ongoing';
        else if (relStatusClass.includes('tamat') || relStatusClass.includes('completed')) relStatus = 'completed';
        const relCh = $(card).find('.comic-card-chapter a').first().text().trim();
        const relChMatch = relCh.match(/Ch\.\s*([0-9.]+)/i);
        related.push({
          title: relTitle,
          slug: relSlug,
          cover: relCover,
          type: relType,
          status: relStatus,
          latestChapter: relChMatch ? relChMatch[1] : relCh || null,
        });
      });
    });

    return {
      source: this.name,
      title,
      altTitle: altTitle || null,
      cover,
      synopsis,
      status,
      type,
      author: author || null,
      genres,
      totalChapters: chapters.length,
      chapters,
      related,
    };
  }

  _decodeReaderAccess(data, pageToken) {
    if (!data) return [];
    // 1. If encrypted resources exist (new CGBUM format)
    if (data.resources && typeof data.resources === 'string') {
      try {
        const value = data.resources;
        if (value.slice(0, 2) === '2.' && /\.[a-f0-9]{64}$/.test(pageToken)) {
          const signature = pageToken.slice(-64);
          const key = [];
          const encoded = value.slice(2).replace(/-/g, '+').replace(/_/g, '/');
          for (let k = 0; k < 32; k++) {
            key.push(parseInt(signature.slice(k * 2, k * 2 + 2), 16));
          }
          const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
          const binary = Buffer.from(padded, 'base64').toString('binary');
          const chunks = [];
          let chunk = '';
          for (let i = 0; i < binary.length; i++) {
            chunk += String.fromCharCode(binary.charCodeAt(i) ^ key[i % 32]);
            if (chunk.length === 8192) {
              chunks.push(chunk);
              chunk = '';
            }
          }
          chunks.push(chunk);
          const packed = JSON.parse(chunks.join(''));
          if (Array.isArray(packed) && packed.length === 3 && packed[2] === signature && Array.isArray(packed[0]) && Array.isArray(packed[1])) {
            return packed[1].map((entry) => packed[0][entry[0]] + entry[1]);
          }
        }
      } catch (_) {}
    }

    // 2. If data.images with layout gaps exists
    let urls = data.images || data.pages || data.data || [];
    if (typeof data.layout === 'string' && /^1\.[a-f0-9]{8}$/.test(data.layout) && Array.isArray(urls)) {
      try {
        const seed = parseInt(data.layout.slice(2), 16) >>> 0;
        let n = 0, k = 0;
        function amount(x) { return x < 1 ? 0 : x <= 5 ? 1 : x <= 20 ? 2 : 3 + (seed & 1); }
        for (let d = 1; d <= 4; d++) {
          const size = urls.length - d;
          if (size > 0 && amount(size) === d) { n = size; k = d; break; }
        }
        if (n > 0) {
          let state = seed || 0x9e3779b9;
          const span = n - 1;
          const gaps = [];
          function step() { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }
          for (let i = 0; i < k; i++) {
            const lo = 1 + Math.floor(i * span / k);
            const hi = Math.floor((i + 1) * span / k);
            gaps.push((n === 1 ? 1 : lo + step() % (hi - lo + 1)) + i);
          }
          urls = urls.filter((_, idx) => gaps.indexOf(idx) === -1);
        }
      } catch (_) {}
    }

    // 3. Fallback transform ONLY if URL matches old /pj/komik/ path:
    if (Array.isArray(urls) && urls.length > 0) {
      return urls.map((img, idx) => {
        const url = typeof img === 'string' ? img : (img?.url || img?.src || '');
        if (!url) return '';
        try {
          if (url.includes('/pj/komik/') && !url.includes('/auto-')) {
            const u = new URL(url);
            u.hostname = u.hostname.replace('cdn1.', 'cdn2.').replace('cdn3.', 'cdn2.');
            u.pathname = u.pathname.replace(/^(\/pj\/komik\/)(?!auto-)/, '$1auto-');
            u.pathname = u.pathname.replace(/\/\d{4}-[a-f0-9]+\.(webp|jpg|jpeg|png)$/,
              `/${String(idx + 1).padStart(3, '0')}.webp`);
            return u.toString();
          }
          return url;
        } catch (_) {
          return url;
        }
      }).filter(Boolean);
    }

    return [];
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;
    if (rawSlug.startsWith('http')) {
      chapterUrl = rawSlug;
    } else if (chapter) {
      chapterUrl = `${this.baseUrl}/baca/${rawSlug}/chapter/${chapter}`;
    } else {
      throw createBadRequest("Parameter 'chapter' wajib diisi", 'INVALID_PARAMETER');
    }

    const { withPage } = require('../../utils/browserClient');

    const pages = await withPage(async (page) => {
      let raJson = null;

      // Intercept reader-access.php second response (after PoW) for full image data
      page.on('response', async (response) => {
        const url = response.url();
        if (!url.includes('reader-access.php')) return;
        try {
          const json = await response.json();
          if (json?.challenge) return; // skip PoW challenge
          if (json?.resources || json?.images || json?.pages || json?.data) {
            raJson = json;
          }
        } catch (_) {}
      });

      await page.goto(chapterUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Grab page token for resources decryption
      const pageToken = await page.evaluate(() => window.__READER_ACCESS?.page || '');

      // Wait for PoW to solve and images to load in DOM
      await page.waitForFunction(
        () => document.querySelectorAll('.page-container img[src]:not([src=""])').length > 0,
        { timeout: 90000, polling: 1000 }
      ).catch(() => null);

      // 1. Primary: decrypt from reader-access response (has ALL real CDN URLs)
      if (raJson) {
        const decoded = this._decodeReaderAccess(raJson, pageToken);
        if (decoded && decoded.length > 0) {
          return decoded;
        }
      }

      // 2. Fallback: Scroll to bottom to trigger lazy load for all pages and collect from DOM
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 1000;
          const timer = setInterval(() => {
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= document.body.scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 150);
        });
      });

      // Wait for more images after scroll
      await new Promise((r) => setTimeout(r, 2000));

      // DOM img.src
      const domUrls = await page.evaluate(() => {
        const urls = [];
        document.querySelectorAll('.page-container').forEach((container) => {
          const img = container.querySelector('img');
          if (img) {
            const src = img.getAttribute('src') || '';
            if (src && !src.startsWith('data:')) urls.push(src);
          }
        });
        return urls;
      });

      return domUrls.filter(Boolean);
    }, { referer: `${this.baseUrl}/` });

    if (!pages.length) {
      throw createBadGateway(
        'Tidak ada gambar yang berhasil dimuat dari chapter ini di CGBUM.',
        'UPSTREAM_ERROR'
      );
    }

    const pageTitle = chapterUrl
      .replace(`${this.baseUrl}/baca/`, '')
      .replace(/\/chapter\//, ' Chapter ')
      .split('/')[0]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      // CGBUM CDN (cdn1.cgb.my.id / cdn2.cgb.my.id) blocks requests from VPS IP.
      // Client should fetch images directly with Referer: https://cgbum.com/
      noProxy: true,
      referer: `${this.baseUrl}/`,
      pages: pages.map((url, index) => ({
        page: index + 1,
        url,
        directUrl: url,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      })),
    };
  }
}

module.exports = CgbumSource;
