const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml, fetchWithHeaders } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class KomikstationSource extends BaseSource {
  constructor() {
    super('komikstation', 'KomikStation');
    this.baseUrl = 'https://komikstation.org';
    this.icon = `https://komikstation.org/wp-content/uploads/2019/07/cropped-Favicon-1-150x150.png`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'newest', name: 'Diperbarui' },
      { id: 'popular', name: 'Populer' },
      { id: 'az', name: 'A-Z' },
      { id: 'za', name: 'Z-A' },
    ];
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  _slugFromUrl(href) {
    if (!href) return null;
    const match = href.match(/\/manga\/([^/]+)\/?$/);
    return match ? match[1] : null;
  }

  _resolveOrder(raw) {
    const map = {
      latest: 'update', update: 'update',
      popular: 'popular',
      newest: 'latest',
      az: 'title',
      za: 'titlereverse',
    };
    return map[String(raw || '').toLowerCase()] || 'update';
  }

  _parsePagination($, currentPage) {
    let maxPage = currentPage;
    // KomikStation uses .hpage with ?page=N links (no page-numbers class)
    $('a[href*="page="]').each((_, el) => {
      const m = ($(el).attr('href') || '').match(/[?&]page=(\d+)/);
      if (m) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > maxPage) maxPage = n; }
    });
    $('a.page-numbers').each((_, el) => {
      const n = parseInt($(el).text().trim(), 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });
    const hasNextPage = !!$('.hpage a[href*="page="]').filter((_, el) => {
      return $(el).text().toLowerCase().includes('next') ||
             parseInt(($(el).attr('href') || '').match(/page=(\d+)/)?.[1] || '0', 10) > currentPage;
    }).length || maxPage > currentPage;
    return { maxPage: maxPage > currentPage ? maxPage : null, hasNextPage };
  }

  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('.bsx').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('.tt').text().trim() || a.attr('title') || '';
      if (!title) return;

      // Cover — data-src (lazy loaded via data-src attribute)
      const noscriptHtml = $(el).find('noscript').last().html() || '';
      const noscriptSrcMatch = noscriptHtml.match(/src=["']([^"']+\.(?:jpg|jpeg|png|webp|gif))[^"']*/i);
      const dataSrc = $(el).find('img.ts-post-image, img[data-src*="uploads"]').first().attr('data-src') || '';
      const cover = dataSrc || (noscriptSrcMatch ? noscriptSrcMatch[1].replace(/-\d+x\d+(\.[^.]+)$/, '$1') : null);

      const latestChText = $(el).find('.epxs').text().trim();
      const latestChMatch = latestChText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = latestChMatch ? latestChMatch[1] : latestChText || null;

      // Status from .status span or data-status
      const statusRaw = $(el).find('.status').text().trim().toLowerCase() ||
                        $(el).find('[class*=status]').not('.type').first().text().trim().toLowerCase();
      let status = null;
      if (statusRaw.includes('ongoing') || statusRaw.includes('berjalan')) status = 'ongoing';
      else if (statusRaw.includes('completed') || statusRaw.includes('tamat')) status = 'completed';
      else if (statusRaw.includes('hiatus')) status = 'hiatus';

      // Type from span.type class e.g. "type Manga" or span title
      const typeClass = $(el).find('span[class*="type "]').attr('class') || '';
      const typeMatch2 = typeClass.match(/\btype\s+(\S+)/i);
      const type = typeMatch2 ? typeMatch2[1].toLowerCase() : null;

      const ratingRaw = $(el).find('.numscore').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

      items.push({ title: title.trim(), slug, cover, type, status, latestChapter, rating });
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

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=update&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=popular&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=latest&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=title&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=titlereverse&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const params = new URLSearchParams({ order, page: pageNum });
    // KomikStation returns 403 for status/type filters — only add if site supports it
    if (options.status) params.set('status', String(options.status).toLowerCase());
    if (options.type) params.set('type', String(options.type).toLowerCase());
    const url = `${this.baseUrl}/manga/?${params.toString()}`;
    try {
      const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
      return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
    } catch (err) {
      // Fallback to basic listing without filters if 403
      if (err.statusCode === 403 || (err.message && err.message.includes('403'))) {
        const fallbackUrl = `${this.baseUrl}/manga/?order=${order}&page=${pageNum}`;
        const { data, maxPage, hasNextPage } = await this._fetchListing(fallbackUrl, pageNum);
        return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
      }
      throw err;
    }
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanQuery = String(query || '').trim();
    try {
      const formParams = new URLSearchParams({
        action: 'ts_ac_do_search',
        ts_ac_query: cleanQuery,
      });
      const res = await fetchWithHeaders(`${this.baseUrl}/wp-admin/admin-ajax.php`, {
        method: 'POST',
        body: formParams.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${this.baseUrl}/`,
        },
        json: true,
      });
      const json = await res.json();
      const allItems = json.series?.[0]?.all || [];
      const limit = 30;
      const offset = (pageNum - 1) * limit;
      const slice = allItems.slice(offset, offset + limit);
      const maxPage = Math.ceil(allItems.length / limit) || 1;
      const hasNextPage = pageNum < maxPage;

      const data = slice.map((item) => {
        const link = item.post_link || '';
        const m = link.match(/\/manga\/([^/]+)\/?$/);
        const slug = m ? m[1] : link.replace(/\/+$/, '').split('/').pop();
        const rawCover = item.post_image || null;
        const cover = rawCover ? rawCover.replace(/-\d+x\d+(\.[^.]+)$/, '$1') : null;
        return {
          title: item.post_title || slug,
          slug,
          cover,
          type: item.post_type?.toLowerCase() || null,
          status: item.post_status?.toLowerCase() || null,
          latestChapter: item.post_latest || null,
        };
      });

      return { source: this.name, query: cleanQuery, page: pageNum, maxPage, hasNextPage, data };
    } catch (_) {
      const url = pageNum === 1
        ? `${this.baseUrl}/?s=${encodeURIComponent(cleanQuery)}`
        : `${this.baseUrl}/page/${pageNum}/?s=${encodeURIComponent(cleanQuery)}`;
      const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
      const $ = cheerio.load(html);
      const data = this._parseCardList($);
      const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
      return { source: this.name, query: cleanQuery, page: pageNum, maxPage, hasNextPage, data };
    }
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }
    const html = await getHtml(`${this.baseUrl}/manga/?order=update`, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    $('input[name="genre[]"]').each((_, el) => {
      const id = $(el).attr('id') || '';
      const numId = $(el).val()?.trim();
      if (!numId || seen.has(numId)) return;
      seen.add(numId);
      const label = $(`label[for="${id}"]`).text().trim() ||
                    $(el).next('label').text().trim() ||
                    $(el).closest('li').text().trim();
      if (!label) return;
      const slug = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      genres.push({ name: label, slug, id: numId });
    });

    genres.sort((a, b) => a.name.localeCompare(b.name, 'id'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const order = this._resolveOrder(options.order || options.sort || 'update');
    const genres = await this.getGenres();
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = genres.find((g) => g.slug === key || g.name.toLowerCase() === key || g.id === key);
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di KomikStation`, 'NOT_FOUND');
      return match;
    });

    const genreParams = found.map((g) => `genre%5B%5D=${g.id}`).join('&');
    const url = `${this.baseUrl}/manga/?${genreParams}&order=${order}&page=${pageNum}`;
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, genre: found.map((g) => g.name).join(', '), page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const url = `${this.baseUrl}/manga/?type=${encodeURIComponent(cleanType)}&order=${order}&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/manga/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di KomikStation`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    // Title — strip "Bahasa Indonesia" suffix
    const title = $('h1.entry-title, h1').first().text()
      .replace(/\s*Bahasa Indonesia\s*/gi, '')
      .trim() || cleanSlug;

    const cover = $('.thumb img, .thumbook img').first().attr('src') || null;

    const synopsis = $('div.entry-content.entry-content-single p').first().text().trim() ||
                     $('[itemprop="description"]').text().trim() || null;

    // Alt title from .wd-full
    let altTitle = null;
    $('.wd-full').each((_, el) => {
      const label = $(el).find('b').first().text().trim().toLowerCase();
      if (label.includes('alternatif') || label.includes('alternative')) {
        altTitle = $(el).find('span').first().text().trim() ||
                   $(el).clone().find('b').remove().end().text().replace(/Judul Alternatif/i, '').trim() || null;
      }
    });

    // Status & Type from .imptdt
    let status = null, type = null, author = null, year = null;
    $('.imptdt').each((_, el) => {
      const text = $(el).text().trim();
      const lower = text.toLowerCase();
      if (lower.startsWith('status')) {
        if (lower.includes('berjalan') || lower.includes('ongoing')) status = 'ongoing';
        else if (lower.includes('tamat') || lower.includes('completed')) status = 'completed';
        else if (lower.includes('hiatus')) status = 'hiatus';
      } else if (lower.startsWith('tipe') || lower.startsWith('type')) {
        type = $(el).find('a').text().trim().toLowerCase() ||
               text.replace(/^(tipe|type)\s*/i, '').trim().toLowerCase() || null;
      }
    });

    // Author/Year from .fmed
    $('.fmed').each((_, el) => {
      const text = $(el).text().trim();
      const lower = text.toLowerCase();
      if (lower.startsWith('penulis') || lower.startsWith('author')) {
        author = text.replace(/^(penulis|author)\s*/i, '').trim() || null;
      } else if (lower.startsWith('terbitan') || lower.startsWith('released')) {
        const m = text.match(/\d{4}/);
        if (m) year = m[0];
      }
    });

    // Rating
    const ratingRaw = $('[itemprop="ratingValue"]').attr('content') ||
                      $('[itemprop="ratingValue"]').text().trim() ||
                      $('.num[itemprop="ratingValue"]').text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

    // Genres
    const genres = [];
    const seenGenres = new Set();
    $('.mgen a, .seriestugenre a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/genres?\/([^/]+)\/?$/);
      const genreSlug = match ? match[1] : $(el).text().trim().toLowerCase().replace(/\s+/g, '-');
      const name = $(el).text().trim();
      if (!name || seenGenres.has(genreSlug)) return;
      seenGenres.add(genreSlug);
      genres.push({ name, slug: genreSlug });
    });

    // Chapters
    const chapters = [];
    $('#chapterlist ul li, .eplister li').each((_, el) => {
      const a = $(el).find('.eph-num a, a').first();
      const href = a.attr('href') || '';
      if (!href) return;
      const chTitle = $(el).find('.chapternum').text().trim() || a.text().trim();
      const date = $(el).find('.chapterdate').text().trim() || null;
      chapters.push({
        title: chTitle,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date,
      });
    });

    // Related — bixbox with "Yang Nggak Kalah Seru!" heading
    const related = [];
    $('.bixbox').each((_, el) => {
      const heading = $(el).find('h2, h3').first().text().trim().toLowerCase();
      if (!heading.includes('nggak kalah') && !heading.includes('related') && !heading.includes('serupa')) return;
      $(el).find('.bsx').each((__, card) => {
        const ca = $(card).find('a').first();
        const chref = ca.attr('href') || '';
        const relSlug = this._slugFromUrl(chref);
        const relTitle = ca.attr('title') || $(card).find('.tt').text().trim();
        if (!relSlug || !relTitle) return;
        const dataSrc = $(card).find('img[data-src*="uploads"]').first().attr('data-src') || '';
        const noscriptHtml = $(card).find('noscript').last().html() || '';
        const noscriptMatch = noscriptHtml.match(/src=["']([^"']+\.(?:jpg|jpeg|png|webp|gif))[^"']*/i);
        const relCover = dataSrc || (noscriptMatch ? noscriptMatch[1] : null);
        related.push({ title: relTitle, slug: relSlug, cover: relCover || null });
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

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;
    if (rawSlug.startsWith('http')) {
      chapterUrl = rawSlug;
    } else {
      const chNum = String(chapter || '').replace(/^chapter-?/i, '').trim();
      // Resolve from detail page chapter list
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
      html = await getHtml(chapterUrl, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di KomikStation`, 'NOT_FOUND');
      throw err;
    }

    const match = html.match(/ts_reader\.run\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;/);
    if (!match) throw createBadGateway('Gagal menemukan data gambar chapter dari KomikStation', 'UPSTREAM_ERROR');

    let tsData;
    try { tsData = JSON.parse(match[1]); } catch (err) {
      throw createBadGateway(`Gagal memproses data gambar dari KomikStation: ${err.message}`, 'UPSTREAM_ERROR');
    }

    const images = tsData.sources?.[0]?.images || [];
    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini', 'UPSTREAM_ERROR');

    const pages = images.map((imgUrl, index) => ({
      page: index + 1,
      url: imgUrl,
      directUrl: imgUrl,
      proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
    }));

    const $ = cheerio.load(html);
    const pageTitle = $('title').text()
      .replace(/\s*Bahasa Indonesia\s*/gi, '')
      .replace(/\s*[-–|]\s*KomikStation.*$/i, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = KomikstationSource;
