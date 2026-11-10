const cheerio = require('cheerio');
const crypto = require('crypto');
const BaseSource = require('../BaseSource');
const { getHtml, fetchWithHeaders } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

const PAGE_SIZE = 30;
const CHAPTER_BATCH = 5; // pages to fetch concurrently

class YuriLabSource extends BaseSource {
  constructor() {
    super('yurilab', 'YuriLab');
    this.baseUrl = 'https://yurilab.top';
    this.icon = `https://yurilab.top/wp-content/uploads/2025/02/cropped-Illustration16-scaled-1-32x32.png`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest',  name: 'Terbaru' },
      { id: 'newest',  name: 'Diperbarui' },
      { id: 'popular', name: 'Populer' },
      { id: 'az',      name: 'A-Z' },
    ];
  }

  // ─── CryptoJS AES Decrypt (OpenSSL EVP_BytesToKey) ──────────────────────────
  // Replicates CryptoJS.AES.decrypt(ciphertext, password) used by wp-manga-chapter-images-protection
  _cryptoJsDecrypt(encryptedJson, password) {
    // encryptedJson = { ct: base64, s: hex_salt, iv: hex_iv (unused for password-based) }
    const ct = Buffer.from(encryptedJson.ct, 'base64');
    const salt = Buffer.from(encryptedJson.s, 'hex');
    // Build "Salted__" + salt + ciphertext blob
    const salted = Buffer.concat([Buffer.from('Salted__'), salt, ct]);
    // Extract just the ciphertext part (skip the 16-byte Salted__ header)
    const ciphertextBuf = salted.slice(16);

    // OpenSSL EVP_BytesToKey with MD5, 1 iteration, 32-byte key + 16-byte IV
    const passBytes = Buffer.from(password, 'utf8');
    const keyLen = 32, ivLen = 16;
    const derivedBytes = [];
    let prev = Buffer.alloc(0);
    while (Buffer.concat(derivedBytes).length < keyLen + ivLen) {
      prev = crypto.createHash('md5').update(Buffer.concat([prev, passBytes, salt])).digest();
      derivedBytes.push(prev);
    }
    const derived = Buffer.concat(derivedBytes);
    const key = derived.slice(0, keyLen);
    const iv = derived.slice(keyLen, keyLen + ivLen);

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]).toString('utf8');
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _headers(extra = {}) {
    return { Referer: `${this.baseUrl}/`, ...extra };
  }

  _slugFromUrl(href) {
    if (!href) return null;
    return href.replace(/\/$/, '').split('/').pop() || null;
  }

  _fixCover(src) {
    if (!src) return null;
    return src.replace(/-\d+x\d+(?=\.\w+$)/, '');
  }

  _resolveOrderby(raw) {
    const map = {
      latest: 'latest', update: 'latest',
      popular: 'views',
      newest: 'new-manga',
      az: 'alphabet', alphabetical: 'alphabet',
    };
    return map[String(raw || '').toLowerCase()] || 'latest';
  }

  _parsePagination($, currentPage) {
    let maxPage = currentPage;
    $('.nav-links .page-numbers:not(.next):not(.prev)').each((_, el) => {
      const n = parseInt($(el).text().trim(), 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });
    const hasNextPage = $('.nav-links .next').length > 0;
    if (hasNextPage && maxPage <= currentPage) maxPage = currentPage + 1;
    return { maxPage, hasNextPage };
  }

  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('div.manga__item').each((_, el) => {
      const a = $(el).find('.post-title a').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = a.text().trim();
      if (!title) return;

      const cover = this._fixCover($(el).find('img').first().attr('src')) || null;

      const genres = [];
      $(el).find('.manga-genres a').each((__, g) => {
        genres.push($(g).text().trim());
      });

      const totalText = $(el).find('.manga-info .total').text().trim();
      const totalMatch = totalText.match(/(\d+)\s+Chapter/i);
      const totalChapters = totalMatch ? totalMatch[1] : null;

      items.push({ title, slug, cover, genres, totalChapters });
    });

    return items;
  }

  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { data, maxPage, hasNextPage };
  }

  _buildListUrl(page, orderby, extra = '') {
    const base = page > 1 ? `${this.baseUrl}/page/${page}/` : `${this.baseUrl}/`;
    return `${base}?s&post_type=wp-manga${extra}&m_orderby=${orderby}`;
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._buildListUrl(pageNum, 'latest'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._buildListUrl(pageNum, 'views'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._buildListUrl(pageNum, 'new-manga'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._buildListUrl(pageNum, 'alphabet'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const orderby = this._resolveOrderby(options.order || options.sort || 'latest');
    let extra = '';
    if (options.status) {
      const statusMap = { ongoing: 'on-going', completed: 'end', hiatus: 'on-hold', cancelled: 'canceled' };
      extra += `&status=${statusMap[options.status.toLowerCase()] || options.status}`;
    }
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._buildListUrl(pageNum, orderby, extra), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const q = encodeURIComponent(String(query || '').trim());
    const base = pageNum > 1 ? `${this.baseUrl}/page/${pageNum}/` : `${this.baseUrl}/`;
    const url = `${base}?s=${q}&post_type=wp-manga&m_orderby=relevance`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, query: String(query || '').trim(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) return this._cachedGenres;
    const html = await getHtml(`${this.baseUrl}/?s&post_type=wp-manga`, { headers: this._headers() });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();
    $('.genres-filter .dropdown-menu a[href*="genre="]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/genre=([^&/?]+)/);
      const key = m ? decodeURIComponent(m[1]) : null;
      const name = $(el).text().trim();
      if (!key || !name || seen.has(key)) return;
      seen.add(key);
      genres.push({ name, slug: key });
    });
    genres.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');
    const orderby = this._resolveOrderby(options.order || options.sort || 'latest');
    const allGenres = await this.getGenres();
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = allGenres.find((g) => g.slug === key || g.name.toLowerCase() === key);
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di YuriLab`, 'NOT_FOUND');
      return match;
    });
    const genreParams = found.map((g) => `&genre[]=${encodeURIComponent(g.slug)}`).join('');
    const url = this._buildListUrl(pageNum, orderby, genreParams);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, genre: found.map((g) => g.name).join(', '), page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const orderby = this._resolveOrderby(options.order || options.sort || 'latest');
    const { data, maxPage, hasNextPage } = await this._fetchListing(
      this._buildListUrl(pageNum, orderby, `&type=${encodeURIComponent(cleanType)}`),
      pageNum
    );
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/').pop();
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/series/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di YuriLab`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('.post-title h1').first().text().trim() ||
                  $('h1').first().text().trim() || cleanSlug;

    // Metadata from .post-content_item
    let altTitle = null, author = null, type = null, status = null, year = null;
    $('.post-content_item').each((_, el) => {
      const label = $(el).find('.summary-heading h5').text().trim().toLowerCase().replace(/:$/, '');
      const val = $(el).find('.summary-content').text().trim();
      if (!val) return;
      if (label.includes('alternative')) altTitle = val;
      else if (label.includes('author')) author = val;
      else if (label.includes('type')) type = val.toLowerCase().split(/[\s,]+/)[0];
      else if (label.includes('status') || label.includes('release status')) {
        const v = val.toLowerCase();
        if (v.includes('on-going') || v.includes('ongoing')) status = 'ongoing';
        else if (v.includes('completed') || v.includes('end')) status = 'completed';
        else if (v.includes('on-hold') || v.includes('hiatus')) status = 'hiatus';
        else if (v.includes('cancel')) status = 'cancelled';
      } else if (label.includes('release') && !label.includes('status')) {
        const m = val.match(/\d{4}/);
        if (m) year = m[0];
      }
    });

    const cover = this._fixCover(
      $('.summary_image img').first().attr('data-src') ||
      $('.summary_image img').first().attr('src') || null
    );

    const synopsis = $('.description-summary .summary__content').text().trim() ||
                     $('.description-summary').text().trim() || null;

    const ratingRaw = $('.post-rating .score').text().trim() ||
                      $('.post-total-rating .score').text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
      ? Math.round(parseFloat(ratingRaw) * 100) / 100 : null;

    // Genres — selectGenre pattern from Kotlin
    const genres = [];
    const seenG = new Set();
    $('.genres-content a[href*="genre"], .tags-content a[href*="tag"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const name = $(el).text().trim();
      const m = href.match(/genre=([^&/?]+)/) || href.match(/series-genre\/([^/?]+)/) || href.match(/series-tag\/([^/?]+)/);
      const gSlug = m ? decodeURIComponent(m[1]) : name.toLowerCase().replace(/\s+/g, '-');
      if (!name || seenG.has(name)) return;
      seenG.add(name);
      genres.push({ name, slug: gSlug });
    });

    // Chapters — paginated POST to /ajax/chapters/?t=N
    const chapters = await this._loadChapters(url.replace(/\/$/, ''), $);

    // Related — from .manga-x-slider after h3 "Related Series"
    const related = [];
    const seenR = new Set();
    $('h3, h2').each((_, hEl) => {
      if (!$(hEl).text().trim().toLowerCase().includes('related')) return;
      $(hEl).next('.manga-x-slider').find('.slider__item').each((__, item) => {
        const a = $(item).find('a[href*="/series/"]').first();
        const href = a.attr('href') || '';
        const relSlug = this._slugFromUrl(href);
        if (!relSlug || seenR.has(relSlug)) return;
        seenR.add(relSlug);
        const relTitle = $(item).find('.post-title h4 a, .post-title h3 a').first().clone().children().remove().end().text().trim() ||
                         $(item).find('.post-title a').first().contents().filter((_, n) => n.type === 'text').text().trim() || '';
        const relCover = this._fixCover(
          $(item).find('img').first().attr('src') || null
        );
        const relGenres = $(item).find('.manga-genres a').map((_, g) => $(g).text().trim()).get();
        if (!relTitle) return;
        related.push({ title: relTitle, slug: relSlug, cover: relCover, genres: relGenres });
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
      year: year || null,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
      related,
    };
  }

  async _loadChapters(mangaBaseUrl, $) {
    const ajaxUrl = `${mangaBaseUrl}/ajax/chapters/`;
    const headers = this._headers({ 'X-Requested-With': 'XMLHttpRequest', 'Content-Length': '0' });

    // Fetch pages in batches of CHAPTER_BATCH until empty or repeated
    const allItems = [];
    let page = 1;
    let previousFirstHtml = null;

    outer: while (true) {
      // Fetch CHAPTER_BATCH pages concurrently
      const pageNums = Array.from({ length: CHAPTER_BATCH }, (_, i) => page + i);
      const results = await Promise.all(pageNums.map(async (t) => {
        try {
          const res = await fetchWithHeaders(`${ajaxUrl}?t=${t}`, { method: 'POST', headers });
          const html = await res.text();
          const c$ = cheerio.load(html);
          return c$('ul.version-chap li.wp-manga-chapter').toArray().map(el => ({
            html: c$(el).html(),
            href: c$(el).find('a').first().attr('href') || '',
            title: c$(el).find('a').first().text().trim(),
            date: c$(el).find('.chapter-release-date, .release-date').first().text().trim() || null,
          }));
        } catch (_) { return []; }
      }));

      for (const pageItems of results) {
        const first = pageItems[0]?.html;
        if (!first || first === previousFirstHtml) break outer;
        previousFirstHtml = first;
        allItems.push(...pageItems);
      }
      page += CHAPTER_BATCH;
    }

    // Reverse to oldest-first, skip coin-locked (#)
    return allItems.reverse().reduce((acc, item, idx) => {
      if (!item.href || item.href === '#' || item.href.startsWith('#')) return acc;
      const chMatch = item.title.match(/Chapter\s+([0-9.]+)/i);
      acc.push({
        title: item.title,
        slug: item.href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(item.href)}`,
        date: item.date,
      });
      return acc;
    }, []);
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;
    if (rawSlug.startsWith('http')) {
      chapterUrl = rawSlug;
    } else {
      // Build chapter URL: /series/{manga-slug}/chapter-{N}/
      const chNum = String(chapter || '').replace(/^chapter-?/i, '').trim();
      try {
        const details = await this.getDetails(rawSlug);
        const target = details.chapters.find((ch) => {
          const m = ch.title.match(/Chapter\s+([0-9.]+)/i);
          return m && parseFloat(m[1]) === parseFloat(chNum);
        });
        chapterUrl = target?.slug || null;
      } catch (_) {}
      if (!chapterUrl) throw createNotFound(`Chapter '${chapter}' tidak ditemukan untuk '${rawSlug}'`, 'NOT_FOUND');
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di YuriLab', 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const images = [];

    // Check for chapter-protector-data (encrypted)
    const protectorEl = $('#chapter-protector-data');
    if (protectorEl.length) {
      const protectorHtml = protectorEl.html() || '';
      // Extract password (nonce)
      const pwMatch = protectorHtml.match(/wpmangaprotectornonce='([^']+)'/);
      if (!pwMatch) throw createBadGateway('Gagal menemukan nonce untuk decrypt chapter YuriLab', 'UPSTREAM_ERROR');
      const password = pwMatch[1];

      // Extract chapter_data JSON
      const cdMatch = protectorHtml.match(/chapter_data='([\s\S]+?)';/);
      if (!cdMatch) throw createBadGateway('Gagal menemukan chapter_data di YuriLab', 'UPSTREAM_ERROR');
      let chapterData;
      try {
        chapterData = JSON.parse(cdMatch[1].replace(/\\/g, ''));
      } catch (e) {
        throw createBadGateway(`Gagal parse chapter_data: ${e.message}`, 'UPSTREAM_ERROR');
      }

      // Decrypt
      let decrypted;
      try {
        decrypted = this._cryptoJsDecrypt(chapterData, password);
      } catch (e) {
        throw createBadGateway(`Gagal decrypt chapter images: ${e.message}`, 'UPSTREAM_ERROR');
      }

      // Result is a JSON-encoded array of image URLs (double-encoded by CryptoJS)
      let urlArray;
      try {
        const parsed = JSON.parse(decrypted);
        // If already an array, use directly; otherwise it's a JSON string needing one more parse
        urlArray = Array.isArray(parsed) ? parsed : JSON.parse(parsed);
      } catch (_) {
        // Fallback: manual parse
        urlArray = decrypted.replace(/^\[|\]$/g, '').split(',').map((s) =>
          s.trim().replace(/^["']|["']$/g, '')
        ).filter(Boolean);
      }
      images.push(...urlArray.map((u) => String(u).replace(/\\\//g, '/').trim()).filter(Boolean));

    } else {
      // Plain reader: .page-break img or .reading-content img
      $('.page-break img, .reading-content img').each((_, el) => {
        const src = $(el).attr('data-src') || $(el).attr('src') || '';
        const clean = src.trim();
        if (clean && !clean.includes('data:image')) images.push(clean);
      });
    }

    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini di YuriLab', 'UPSTREAM_ERROR');

    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*YuriLab.*$/i, '')
      .replace(/^(Baca|Read)\s+/i, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: images.length,
      pages: images.map((url, index) => ({
        page: index + 1,
        url,
        directUrl: url,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      })),
    };
  }
}

module.exports = YuriLabSource;
