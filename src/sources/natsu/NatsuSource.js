const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml, fetchWithHeaders } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class NatsuSource extends BaseSource {
  constructor() {
    super('natsu', 'Natsu');
    this.baseUrl = 'https://natsu.one';
    this.icon = `https://natsu.one/wp-content/uploads/2025/09/Logo-Natsu.png`;

    this._nonce = null;
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest',  name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'rating',  name: 'Rating' },
      { id: 'az',      name: 'A-Z' },
      { id: 'za',      name: 'Z-A' },
    ];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _headers(extra = {}) {
    return { Referer: `${this.baseUrl}/`, Origin: this.baseUrl, ...extra };
  }

  _slugFromUrl(href) {
    if (!href) return null;
    return href.replace(/\/$/, '').split('/manga/')[1]?.split('/')[0] || null;
  }

  _resolveOrderby(raw) {
    const map = {
      latest: 'updated', update: 'updated',
      popular: 'popular',
      rating: 'rating',
      az: 'title', alphabetical: 'title',
    };
    return map[String(raw || '').toLowerCase()] || 'updated';
  }

  async _getNonce() {
    if (this._nonce) return this._nonce;
    const html = await getHtml(
      `${this.baseUrl}/wp-admin/admin-ajax.php?type=search_form&action=get_nonce`,
      { headers: this._headers() }
    );
    const $ = cheerio.load(html);
    this._nonce = $('input[name=search_nonce]').attr('value') || '';
    return this._nonce;
  }

  async _postSearch(params) {
    const nonce = await this._getNonce();
    const form = new URLSearchParams();
    form.append('nonce', nonce);
    form.append('inclusion', 'OR');
    form.append('exclusion', 'OR');
    form.append('page', String(params.page || 1));
    form.append('project', '0');
    form.append('order', params.order || 'desc');
    form.append('orderby', params.orderby || 'updated');
    form.append('genre', JSON.stringify(params.genre || []));
    form.append('genre_exclude', JSON.stringify(params.genreExclude || []));
    form.append('author', '[]');
    form.append('artist', '[]');
    form.append('type', JSON.stringify(params.type || []));
    form.append('status', JSON.stringify(params.status || []));
    form.append('query', params.query || '');

    let res;
    try {
      res = await fetchWithHeaders(`${this.baseUrl}/wp-admin/admin-ajax.php?action=advanced_search`, {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: form.toString(),
      });
    } catch (err) {
      // Nonce may have expired, reset and retry once
      this._nonce = null;
      const newNonce = await this._getNonce();
      form.set('nonce', newNonce);
      res = await fetchWithHeaders(`${this.baseUrl}/wp-admin/admin-ajax.php?action=advanced_search`, {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: form.toString(),
      });
    }
    return cheerio.load(await res.text());
  }

  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('body > div').each((_, el) => {
      const a = $(el).find('a[href*="/manga/"]').first();
      const href = a.attr('href') || '';
      if (!href || href.includes('/chapter-')) return;
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('a.text-base, a.text-white').first().text().trim() ||
                    a.attr('title') || a.text().trim();
      if (!title) return;

      const cover = $(el).find('img').first().attr('src') || null;

      const ratingRaw = $(el).find('span.text-yellow-400').first().text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
        ? Math.round(parseFloat(ratingRaw) * 100) / 100 : null;

      const statusText = $(el).find('span.bg-accent').first().text().trim().toLowerCase();
      let status = null;
      if (statusText.includes('ongoing')) status = 'ongoing';
      else if (statusText.includes('completed')) status = 'completed';
      else if (statusText.includes('hiatus')) status = 'hiatus';

      const latestChText = $(el).find('a[href*="/chapter-"]').first().text().trim();
      const chMatch = latestChText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = chMatch ? chMatch[1] : latestChText || null;

      items.push({ title, slug, cover, rating, status, latestChapter });
    });

    return items;
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const $ = await this._postSearch({ page: pageNum, orderby: 'updated' });
    const data = this._parseCardList($);
    const hasNextPage = data.length >= 24;
    return { source: this.name, page: pageNum, maxPage: hasNextPage ? pageNum + 1 : pageNum, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const $ = await this._postSearch({ page: pageNum, orderby: 'popular' });
    const data = this._parseCardList($);
    const hasNextPage = data.length >= 24;
    return { source: this.name, page: pageNum, maxPage: hasNextPage ? pageNum + 1 : pageNum, hasNextPage, data };
  }

  async getRating(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const $ = await this._postSearch({ page: pageNum, orderby: 'rating' });
    const data = this._parseCardList($);
    const hasNextPage = data.length >= 24;
    return { source: this.name, page: pageNum, maxPage: hasNextPage ? pageNum + 1 : pageNum, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const $ = await this._postSearch({ page: pageNum, orderby: 'title', order: 'asc' });
    const data = this._parseCardList($);
    const hasNextPage = data.length >= 24;
    return { source: this.name, page: pageNum, maxPage: hasNextPage ? pageNum + 1 : pageNum, hasNextPage, data };
  }

  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const $ = await this._postSearch({ page: pageNum, orderby: 'title', order: 'desc' });
    const data = this._parseCardList($);
    const hasNextPage = data.length >= 24;
    return { source: this.name, page: pageNum, maxPage: hasNextPage ? pageNum + 1 : pageNum, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const rawSort = String(options.order || options.sort || '').toLowerCase();
    // 'newest' tidak didukung di Natsu — route fallback akan dapat NOT_FOUND
    if (rawSort === 'newest') {
      throw createNotFound("Sumber 'natsu' tidak menyediakan endpoint /newest", 'NOT_FOUND');
    }
    const orderby = this._resolveOrderby(rawSort || 'updated');
    const params = { page: pageNum, orderby };
    if (options.status) {
      const statusMap = { ongoing: 'ongoing', completed: 'completed', hiatus: 'on-hiatus' };
      params.status = [statusMap[options.status.toLowerCase()] || options.status];
    }
    if (options.type) params.type = [options.type.toLowerCase()];
    const $ = await this._postSearch(params);
    const data = this._parseCardList($);
    const hasNextPage = data.length >= 24;
    return { source: this.name, page: pageNum, maxPage: hasNextPage ? pageNum + 1 : pageNum, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const $ = await this._postSearch({ page: pageNum, orderby: 'updated', query: String(query || '').trim() });
    const data = this._parseCardList($);
    const hasNextPage = data.length >= 24;
    return { source: this.name, query: String(query || '').trim(), page: pageNum, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) return this._cachedGenres;
    // Use WP JSON API
    try {
      const res = await fetchWithHeaders(`${this.baseUrl}/wp-json/wp/v2/genre?per_page=100&page=1&orderby=count&order=desc`, {
        headers: this._headers(),
      });
      const json = await res.json();
      const genres = json.map((g) => ({
        name: g.name,
        slug: g.slug,
      })).filter((g) => g.name && g.slug);
      genres.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      this._cachedGenres = genres;
      this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
      return genres;
    } catch (_) {
      // Fallback: library page
      const html = await getHtml(`${this.baseUrl}/library/`, { headers: this._headers() });
      const $ = cheerio.load(html);
      const genres = [];
      const seen = new Set();
      $('button[data-genre]').each((_, el) => {
        const key = $(el).attr('data-genre');
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
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');
    const orderby = this._resolveOrderby(options.order || options.sort || 'updated');
    const allGenres = await this.getGenres();
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = allGenres.find((g) => g.slug === key || g.name.toLowerCase() === key);
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di Natsu`, 'NOT_FOUND');
      return match;
    });
    const $ = await this._postSearch({ page: pageNum, orderby, genre: found.map((g) => g.slug) });
    const data = this._parseCardList($);
    const hasNextPage = data.length >= 24;
    return { source: this.name, genre: found.map((g) => g.name).join(', '), page: pageNum, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua', 'comic', 'novel'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const orderby = this._resolveOrderby(options.order || options.sort || 'updated');
    const $ = await this._postSearch({ page: pageNum, orderby, type: [cleanType] });
    const data = this._parseCardList($);
    const hasNextPage = data.length >= 24;
    return { source: this.name, type: cleanType, page: pageNum, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/').pop();
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/manga/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Natsu`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1[itemprop=name]').text().trim() || cleanSlug;

    // Alt title — sibling after h1
    const altTitleRaw = $('h1[itemprop=name]').next().text().trim();
    const altTitle = altTitleRaw || null;

    const cover = $('div[itemprop=image] > img').attr('src') || null;

    const synopsis = $('div[itemprop=description]').first().text().trim() || null;

    // Metadata from div.space-y-2 flex rows
    let status = null, type = null, author = null, year = null;
    $('div.space-y-2 > .flex:has(h4)').each((_, el) => {
      const label = $(el).find('h4').text().trim().toLowerCase();
      const val = $(el).find('p.font-normal').text().trim();
      if (!val) return;
      if (label.includes('status')) {
        const v = val.toLowerCase();
        if (v.includes('ongoing')) status = 'ongoing';
        else if (v.includes('completed')) status = 'completed';
        else if (v.includes('hiatus')) status = 'hiatus';
        else status = v;
      } else if (label === 'type' && !type) {
        type = val.toLowerCase();
      } else if (label.includes('author') && !author) {
        author = val;
      } else if ((label.includes('released') || label.includes('release')) && !year) {
        const m = val.match(/\d{4}/);
        if (m) year = m[0];
      }
    });

    // Rating from schema JSON-LD (loaded statically unlike the HTMX rating widget)
    let rating = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      const content = $(el).html() || '';
      if (!content.includes('ratingValue')) return;
      const m = content.match(/"ratingValue"\s*:\s*"?([0-9.]+)"?/);
      if (m) {
        const v = parseFloat(m[1]);
        if (!isNaN(v)) { rating = Math.round(v * 100) / 100; return false; }
      }
    });

    // Genres
    const genres = [];
    const seenG = new Set();
    $('a[itemprop=genre]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const key = href.split('/genre/')[1]?.replace(/\/$/, '') || null;
      const name = $(el).text().trim();
      if (!name || seenG.has(name)) return;
      seenG.add(name);
      genres.push({ name, slug: key || name.toLowerCase().replace(/\s+/g, '-') });
    });

    // Manga ID for chapter loading
    const hxGet = $('[hx-get*="manga_id="]').first().attr('hx-get') || '';
    const mangaId = hxGet.split('manga_id=')[1]?.split('&')[0] ||
                    $('input#manga_id, [data-manga-id]').first().attr('value') ||
                    cleanSlug;

    // Chapters
    const chapters = await this._loadChapters(mangaId, url);

    // Related — from homepage "Judul Populer" sidebar, rotate daily/weekly/monthly every 10min
    const related = [];
    try {
      const homeHtml = await getHtml(`${this.baseUrl}/`, { headers: this._headers() });
      const h$ = cheerio.load(homeHtml);
      const periods = ['daily', 'weekly', 'monthly'];
      const activePeriod = periods[Math.floor(Date.now() / (10 * 60 * 1000)) % periods.length];
      const seenR = new Set();

      h$(`ul[data-trending-chart="${activePeriod}"] li`).each((_, el) => {
        const a = h$(el).find('a.series').first();
        const href = a.attr('href') || '';
        const relSlug = this._slugFromUrl(href);
        if (!relSlug || seenR.has(relSlug)) return;
        seenR.add(relSlug);

        const relTitle = h$(el).find('h2 a').text().trim() || '';
        if (!relTitle) return;

        const relCover = h$(el).find('img').first().attr('src') || null;
        const relGenres = h$(el).find('span a[href*="/genre/"]').map((__, g) => h$(g).text().trim()).get();
        const relRatingText = h$(el).text().match(/\b([0-9]\.[0-9]{1,2})\b/);
        const relRating = relRatingText ? Math.round(parseFloat(relRatingText[1]) * 100) / 100 : null;

        related.push({ title: relTitle, slug: relSlug, cover: relCover, genres: relGenres, rating: relRating });
      });
    } catch (_) {}

    return {
      source: this.name,
      title,
      altTitle,
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

  async _loadChapters(mangaId, mangaUrl) {
    const chapters = [];
    for (let page = 1; page <= 50; page++) {
      try {
        const html = await getHtml(
          `${this.baseUrl}/wp-admin/admin-ajax.php?manga_id=${mangaId}&page=${page}&action=chapter_list`,
          {
            headers: this._headers({
              'HX-Request': 'true',
              'HX-Target': 'chapter-list',
              'HX-Current-URL': mangaUrl,
            }),
          }
        );
        const $ = cheerio.load(html);
        const items = $('div#chapter-list > div[data-chapter-number]');
        if (!items.length) break;

        items.each((_, el) => {
          const a = $(el).find('a').first();
          const href = a.attr('href') || '';
          if (!href) return;
          const chTitle = $(el).find('div.font-medium span').text().trim();
          const date = $(el).find('time').text().trim() || null;
          chapters.push({
            title: chTitle,
            slug: href,
            endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
            date,
          });
        });
      } catch (_) { break; }
    }
    return chapters.reverse();
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;
    if (rawSlug.startsWith('http')) {
      chapterUrl = rawSlug;
    } else {
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
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di Natsu', 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);
    const images = [];
    $('main section section > img').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (src && !src.includes('data:image')) images.push(src);
    });

    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini di Natsu', 'UPSTREAM_ERROR');

    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*Natsu.*$/i, '')
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

module.exports = NatsuSource;
