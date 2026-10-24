const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound } = require('../../utils/errors');
const { formatPagination } = require('../../utils/responseHelper');
const staticKomikuGenres = require('./komikuGenres.json');

class KomikuSource extends BaseSource {
  constructor() {
    super('komiku', 'Komiku');
    this.baseUrl = 'https://komiku.org';
    this.apiBaseUrl = 'https://api.komiku.org';
    this.icon = 'https://komiku.org/asset/img/ico.ico';

    // Genres cache in memory initialized with static list for instant 0ms responses
    this._cachedGenres = staticKomikuGenres;
    this._cachedGenresExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

    // Portrait covers cache in memory for horizontal image fallback
    this._portraitCoversCache = new Map();
  }

  /**
   * Parse manga list items from div.bge elements on api.komiku.org.
   * @private
   */
  _parseMangaList(html) {
    const $ = cheerio.load(html);
    const items = [];

    $('div.bge').each((_, el) => {
      const $el = $(el);
      const linkEl = $el.find('div.bgei a[href*="/manga/"], a[href*="/manga/"]').first();
      const href = linkEl.attr('href') || '';
      const slugMatch = href.match(/\/manga\/([^/]+)/);
      const slug = slugMatch ? slugMatch[1] : '';
      if (!slug) return;

      const title = $el.find('div.kan h3').text().trim() || $el.find('h3').text().trim();
      const imgEl = $el.find('div.bgei img, img').first();
      let cover = imgEl.attr('data-src') || imgEl.attr('src') || '';
      if (cover) {
        cover = cover.split('?')[0]; // Strip resize params for full resolution
      }

      const typeRaw = $el.find('div.tpe1_inf b').text().trim().toLowerCase();
      const type = typeRaw || ($el.find('.tpe1_inf').text().toLowerCase().includes('manhwa') ? 'manhwa' : ($el.find('.tpe1_inf').text().toLowerCase().includes('manhua') ? 'manhua' : 'manga'));

      // Extract latest chapter
      const latestChapterEl = $el.find('div.new1 a').last();
      const latestChapterText = latestChapterEl.text().trim();
      const latestChapterMatch = latestChapterText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = latestChapterMatch ? latestChapterMatch[1] : (latestChapterText.replace(/.*?Chapter\s*/i, '') || null);

      // Extract updated time from span.judul2 or div.kan p
      let updatedAt = null;
      const judul2 = $el.find('span.judul2').text();
      if (judul2) {
        const parts = judul2.split('|').map((s) => s.trim());
        parts.forEach((p) => {
          if (/lalu|detik|menit|jam|hari|minggu|bulan|tahun/i.test(p)) {
            updatedAt = p;
          }
        });
      }

      if (!updatedAt) {
        const kanP = $el.find('div.kan p').text().trim();
        const pMatch = kanP.match(/(?:update\s*)?([0-9.]+\s*(?:detik|menit|jam|hari|minggu|bulan|tahun)\s*lalu)/i);
        if (pMatch) {
          updatedAt = pMatch[1].trim();
        } else if (/lalu|detik|menit|jam|hari|minggu|bulan|tahun/i.test(kanP)) {
          updatedAt = kanP.replace(/^update\s+/i, '').replace(/\.+$/, '').trim();
        }
      }

      items.push({
        title,
        slug,
        cover: cover || null,
        type,
        latestChapter: latestChapter || null,
        updatedAt: updatedAt || null,
      });
    });

    return items;
  }

  /**
   * Processes manga list from HTML:
   * 1. Extracts items from div.bge.
   * 2. Resolves landscape/horizontal thumbnails to official portrait covers from manga detail page.
   * 3. Uses memory cache (_portraitCoversCache) so cached items resolve instantly (0ms).
   * @private
   */
  async _processMangaList(html) {
    const items = this._parseMangaList(html);
    return await this._enrichPortraitCovers(items);
  }

  /**
   * Resolves landscape/horizontal thumbnails from div.bge to official portrait covers from manga detail page.
   * @private
   */
  async _enrichPortraitCovers(items) {
    if (!Array.isArray(items) || items.length === 0) return items;

    // 1. Immediately apply cached portrait covers
    for (const item of items) {
      if (item.slug && this._portraitCoversCache.has(item.slug)) {
        item.cover = this._portraitCoversCache.get(item.slug);
      }
    }

    // 2. Find any items that have not yet had their official portrait resolved from detail page
    const toEnrich = items.filter(
      (item) => item.slug && !this._portraitCoversCache.has(item.slug)
    );

    if (toEnrich.length === 0) return items;

    // 3. Fetch detail page in parallel to get official portrait cover
    await Promise.all(
      toEnrich.map(async (item) => {
        try {
          const html = await getHtml(`${this.baseUrl}/manga/${item.slug}/`);
          const $ = cheerio.load(html);
          let portrait =
            $('div.ims img, section.ims img').first().attr('data-src') ||
            $('div.ims img, section.ims img').first().attr('src') ||
            '';
          if (portrait) {
            portrait = portrait.split('?')[0];
            if (this._portraitCoversCache.size > 5000) {
              const firstKey = this._portraitCoversCache.keys().next().value;
              this._portraitCoversCache.delete(firstKey);
            }
            this._portraitCoversCache.set(item.slug, portrait);
            item.cover = portrait;
          }
        } catch (_) {
          // If fetch fails, retain the existing fallback cover
        }
      })
    );

    return items;
  }

  /**
   * Extract pagination metadata from HTMX infinite scroll tags on api.komiku.org.
   * @private
   */
  _extractPagination(html, currentPage) {
    const pageNum = Math.max(1, parseInt(currentPage, 10) || 1);
    const hxMatch = html.match(/hx-get=["'][^"']*\/page\/(\d+)\//);
    const nextPage = hxMatch ? parseInt(hxMatch[1], 10) : null;
    const prevPage = pageNum > 1 ? pageNum - 1 : null;

    if (!nextPage && !prevPage) {
      return null;
    }

    return formatPagination({
      page: pageNum,
      prevPage,
      nextPage,
      hasNextPage: Boolean(nextPage),
    });
  }

  /**
   * Get latest manga list from https://komiku.org/pustaka/
   * Scrapes underlying endpoint: https://api.komiku.org/manga/page/:page/?orderby=modified
   * Supports query options: tipe (manga|manhua|manhwa), orderby, genre, status
   *
   * @param {number} [page=1] Page number
   * @param {Object} [options={}] Filter options
   */
  async getLatest(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const params = new URLSearchParams();
    params.set('orderby', options.orderby || 'modified');

    if (options.tipe) {
      params.set('tipe', options.tipe);
    }
    if (options.genre) {
      params.set('genre', options.genre);
    }
    if (options.status) {
      params.set('status', options.status);
    }

    // Cache buster to bypass LiteSpeed Cache on api.komiku.org
    params.set('_', Date.now());

    const url = `${this.apiBaseUrl}/manga/page/${pageNum}/?${params.toString()}`;
    const html = await getHtml(url, {
      headers: { Referer: `${this.baseUrl}/pustaka/` },
    });
    const data = await this._processMangaList(html);
    const pagination = this._extractPagination(html, pageNum);

    return {
      source: this.name,
      from: 'https://komiku.org/pustaka/',
      data,
      pagination,
    };
  }

  /**
   * Get complete manga list / directory from https://komiku.org/daftar-komik/
   * Supports query options:
   * - page / halaman: number (default: 1)
   * - letter / huruf: alphabet letter (e.g. 'A', 'B', '#', etc.)
   *
   * @param {number} [page=1] Page number
   * @param {Object} [options={}] Filter options (letter / huruf)
   */
  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const params = new URLSearchParams();

    // Komiku pagination parameter for daftar-komik is 'halaman'
    if (pageNum > 1) {
      params.set('halaman', pageNum);
    }

    const letter = options.letter || options.huruf;
    if (letter) {
      params.set('huruf', String(letter).toUpperCase());
    }

    const queryString = params.toString();
    const url = `${this.baseUrl}/daftar-komik/${queryString ? `?${queryString}` : ''}`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);

    const data = [];
    $('article.manga-card').each((_, el) => {
      const $el = $(el);
      const link = $el.find('h4 a, a[href*="/manga/"]').first();
      const href = link.attr('href') || '';
      const slugMatch = href.match(/\/manga\/([^/]+)/);
      const slug = slugMatch ? slugMatch[1] : '';
      if (!slug) return;

      const title = $el.find('h4').text().trim() || link.text().trim();
      const imgEl = $el.find('img').first();
      let cover = imgEl.attr('data-src') || imgEl.attr('src') || '';
      if (cover) cover = cover.split('?')[0];

      const metaText = $el.find('p.meta').text().trim();
      const lines = metaText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const firstLine = lines[0] || '';
      const metaParts = firstLine.split('•').map((p) => p.trim());
      const itemType = metaParts[0] ? metaParts[0].toLowerCase() : null;
      const genre = metaParts[1] || null;

      let status = null;
      const statusMatch = metaText.match(/status:\s*([^\r\n]+)/i);
      if (statusMatch) {
        const s = statusMatch[1].trim().toLowerCase();
        status =
          s.includes('ongoing') || s.includes('berjalan')
            ? 'ongoing'
            : s.includes('end') || s.includes('tamat') || s.includes('complete')
            ? 'completed'
            : s;
      }

      data.push({
        title,
        slug,
        cover: cover || null,
        status,
        type: itemType,
        genre,
      });
    });

    // Extract pagination metadata
    const pageInfoText = $('.page-info').text().trim();
    const maxPageMatch = pageInfoText.match(/dari\s+(\d+)/i);
    const maxPage = maxPageMatch ? parseInt(maxPageMatch[1], 10) : null;

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
        'NOT_FOUND'
      );
    }

    const prevPage = pageNum > 1 ? pageNum - 1 : null;
    const nextPage = maxPage
      ? pageNum < maxPage
        ? pageNum + 1
        : null
      : $('a:contains("Next")').length
      ? pageNum + 1
      : null;

    const pagination = formatPagination({
      page: pageNum,
      maxPage: maxPage || null,
      hasNextPage: Boolean(nextPage),
    });

    return {
      source: this.name,
      from: 'https://komiku.org/daftar-komik/',
      ...(letter ? { letter: String(letter).toUpperCase() } : {}),
      data,
      pagination,
    };
  }

  /**
   * Get popular manga list from api.komiku.org.
   * @param {number} page Page number (default: 1)
   * @param {Object} [options={}] Filter options (tipe, genre, status)
   */
  async getPopular(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const params = new URLSearchParams();
    params.set('orderby', 'meta_value_num');

    if (options.tipe) {
      params.set('tipe', options.tipe);
    }
    if (options.genre) {
      params.set('genre', options.genre);
    }
    if (options.status) {
      params.set('status', options.status);
    }

    // Cache buster to bypass LiteSpeed Cache on api.komiku.org
    params.set('_', Date.now());

    const html = await getHtml(`${this.apiBaseUrl}/manga/page/${pageNum}/?${params.toString()}`, {
      headers: { Referer: `${this.baseUrl}/pustaka/` },
    });
    const data = await this._processMangaList(html);
    const pagination = this._extractPagination(html, pageNum);

    return {
      source: this.name,
      data,
      pagination,
    };
  }

  /**
   * Search manga on api.komiku.org by title/query.
   * @param {string} query Search keyword
   * @param {number} page Page number (default: 1)
   */
  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url =
      pageNum > 1
        ? `${this.apiBaseUrl}/page/${pageNum}/?post_type=manga&s=${encodeURIComponent(query)}`
        : `${this.apiBaseUrl}/?post_type=manga&s=${encodeURIComponent(query)}`;

    let html;
    try {
      html = await getHtml(url);
    } catch (err) {
      if (err.status === 404 || err.code === 'NOT_FOUND') {
        throw createNotFound(
          `Halaman ${pageNum} tidak ditemukan untuk pencarian '${query}'`,
          'NOT_FOUND'
        );
      }
      throw err;
    }

    const data = await this._processMangaList(html);

    // If on page 1 and no results found, return empty data with no pagination
    if (data.length === 0) {
      return {
        source: this.name,
        query,
        data: [],
        pagination: null,
      };
    }

    // Komiku search displays 10 items per page when multiple pages exist
    const hasNext = data.length === 10;
    const hasPrev = pageNum > 1;

    let pagination = null;
    if (hasNext || hasPrev) {
      pagination = {
        page: pageNum,
        prevPage: hasPrev ? pageNum - 1 : null,
        nextPage: hasNext ? pageNum + 1 : null,
      };
    }

    return {
      source: this.name,
      query,
      data,
      pagination,
    };
  }

  /**
   * Get list of all available genres in Komiku (from https://komiku.org/pustaka/).
   */
  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const html = await getHtml(`${this.baseUrl}/pustaka/`);
    const optionsMatch = html.match(/<select[^>]+name="genre"[^>]*>([\s\S]*?)<\/select>/);
    const genres = [];

    if (optionsMatch) {
      const regex = /<option[^>]+value="([^"]+)"[^>]*>([^<]+)<\/option>/g;
      let match;
      while ((match = regex.exec(optionsMatch[1])) !== null) {
        const val = match[1].trim();
        const name = match[2].replace(/\s*\([\d.,]+\)/g, '').trim();
        if (val && !val.toLowerCase().includes('genre')) {
          genres.push({
            name,
            slug: val,
          });
        }
      }
    }

    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  /**
   * Resolve genre input (name or slug) to the exact slug supported by Komiku.
   * @private
   */
  async _resolveGenreSlug(inputGenre) {
    if (!inputGenre || typeof inputGenre !== 'string') return inputGenre;
    const raw = inputGenre.trim().toLowerCase();
    const cleanNoSpecial = raw.replace(/[\s\-_()]+/g, '');

    try {
      const genres = await this.getGenres();
      const match = genres.find((g) => {
        const gNameClean = g.name.toLowerCase().replace(/[\s\-_()]+/g, '');
        const gSlugClean = g.slug.toLowerCase().replace(/[\s\-_()]+/g, '');
        return (
          g.slug === raw ||
          g.name.toLowerCase() === raw ||
          gSlugClean === cleanNoSpecial ||
          gNameClean === cleanNoSpecial
        );
      });
      if (match) return match.slug;
    } catch (_) {}

    return raw;
  }

  /**
   * Get manga list filtered by genre from api.komiku.org.
   * Supports single genre or multi-genre comma-separated (e.g. 'action,comedy').
   * @param {string|string[]} genre Genre name or slug(s)
   * @param {number} page Page number (default: 1)
   */
  async getByGenre(genre, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const rawList = Array.isArray(genre)
      ? genre
      : String(genre || '')
          .split(/[,+]/)
          .map((s) => s.trim())
          .filter(Boolean);

    if (rawList.length === 0) {
      throw createNotFound("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');
    }

    // Komiku pustaka search only supports up to 2 genres: 'genre' and 'genre2'
    const resolvedGenres = await Promise.all(
      rawList.slice(0, 2).map((g) => this._resolveGenreSlug(g))
    );

    const params = new URLSearchParams();
    if (resolvedGenres[0]) params.set('genre', resolvedGenres[0]);
    if (resolvedGenres[1]) params.set('genre2', resolvedGenres[1]);

    // Cache buster to bypass LiteSpeed Cache on api.komiku.org
    params.set('_', Date.now());

    const url = `${this.apiBaseUrl}/manga/page/${pageNum}/?${params.toString()}`;
    const html = await getHtml(url, {
      headers: { Referer: `${this.baseUrl}/pustaka/` },
    });
    const data = await this._processMangaList(html);
    const pagination = this._extractPagination(html, pageNum);

    return {
      source: this.name,
      genre: resolvedGenres.join(', '),
      data,
      pagination,
    };
  }

  /**
   * Get list of supported comic types for Komiku.
   */
  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  /**
   * Get manga list filtered by type from api.komiku.org.
   * @param {string} type Type ('manga', 'manhwa', 'manhua')
   * @param {number} page Page number (default: 1)
   */
  async getByType(type, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    const url = `${this.apiBaseUrl}/manga/page/${pageNum}/?tipe=${encodeURIComponent(cleanType)}`;
    const html = await getHtml(url);
    const data = await this._processMangaList(html);
    const pagination = this._extractPagination(html, pageNum);

    return {
      source: this.name,
      type: cleanType,
      data,
      pagination,
    };
  }

  /**
   * Get full details, synopsis, author, and chapters for a manga.
   * @param {string} slug Manga slug (e.g. 'one-piece', 'solo-leveling')
   */
  async getDetails(slug) {
    const cleanSlug = slug.replace(/^\/+|\/+$/g, '').split('/')[0];
    const url = `${this.baseUrl}/manga/${cleanSlug}/`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);

    const rawTitle = $('h1[itemprop="name"]').text().trim() || $('h1').text().trim();
    const title = rawTitle.replace(/^komik\s+/i, '').trim();

    let altTitle = null;
    let author = null;
    let statusText = '';
    let typeText = '';

    $('table.inftable tr').each((_, tr) => {
      const key = $(tr).find('td').first().text().trim().toLowerCase();
      const val = $(tr).find('td').last().text().trim();
      if (!val) return;

      if (/judul alternatif|alt title/i.test(key)) {
        altTitle = val;
      } else if (/author|pengarang|penulis|komikus|mangaka/i.test(key)) {
        author = val;
      } else if (/status/i.test(key)) {
        statusText = val.toLowerCase();
      } else if (/tipe|type/i.test(key)) {
        typeText = val.toLowerCase();
      }
    });

    const status =
      statusText.includes('ongoing') || statusText.includes('berjalan')
        ? 'ongoing'
        : statusText.includes('end') || statusText.includes('tamat') || statusText.includes('complete')
        ? 'completed'
        : statusText || 'ongoing';

    const type = typeText || 'manga';

    const genres = [];
    $('ul.genre li.genre a, table.inftable a[href*="/genre/"]').each((_, a) => {
      const gName = $(a).text().trim();
      if (gName && !genres.includes(gName)) genres.push(gName);
    });

    const synopsis = $('p.desc, #Sinopsis p').first().text().trim() || null;

    let cover =
      $('div.ims img, div.ims > img').first().attr('data-src') || $('div.ims img').first().attr('src') || '';
    if (cover) {
      cover = cover.split('?')[0];
      this._portraitCoversCache.set(cleanSlug, cover);
    }

    const chapters = [];
    $('#Daftar_Chapter tr').each((_, tr) => {
      const link = $(tr).find('td.judulseries a').first();
      if (!link.length) return;
      const href = link.attr('href') || '';
      const chTitle = link.text().trim();
      const dateText = $(tr).find('td.tanggalseries').text().trim() || null;

      const cleanChapterSlug = href.replace(/^\/+|\/+$/g, '');
      const chNumMatch =
        chTitle.match(/Chapter\s+([0-9.]+)/i) || cleanChapterSlug.match(/chapter-([0-9.]+)/i);
      const chNum = chNumMatch ? chNumMatch[1] : cleanChapterSlug;

      chapters.push({
        chapter: chNum,
        slug: chNum,
        title: chTitle,
        endpoint: `/api/sources/${this.name}/chapter/${cleanSlug}/${chNum}`,
        date: dateText,
      });
    });

    // Extract Komik Serupa (similar comics)
    const similar = [];
    const similarHeading = $('h2:contains("Komik Serupa")');
    const container = similarHeading.closest('section').length
      ? similarHeading.closest('section')
      : similarHeading.parent();

    container.find('div.grd').each((_, el) => {
      const $el = $(el);
      const link = $el.find('a[href*="/manga/"]').first();
      const href = link.attr('href') || '';
      const slugMatch = href.match(/\/manga\/([^/]+)/);
      const simSlug = slugMatch ? slugMatch[1] : '';
      if (!simSlug) return;

      const simTitle =
        $el.find('div.h4').text().trim() ||
        link.attr('title')?.replace(/^baca komik\s+/i, '').trim();
      let simCover = $el.find('img').attr('data-src') || $el.find('img').attr('src') || '';
      if (simCover) simCover = simCover.split('?')[0];

      const simType = $el.find('div.tpe1_inf strong').text().trim().toLowerCase() || null;
      const simGenre =
        $el.find('div.tpe1_inf').clone().children().remove().end().text().trim() || null;
      const views = $el.find('div.vw').text().trim() || null;
      const description = $el.find('p').text().trim() || null;

      similar.push({
        title: simTitle,
        slug: simSlug,
        cover: simCover || null,
        type: simType,
        genre: simGenre,
        views,
        description,
      });
    });

    // Enrich similar comics with official portrait covers
    await this._enrichPortraitCovers(similar);

    return {
      source: this.name,
      title,
      altTitle,
      cover: cover || null,
      synopsis,
      author,
      status,
      type,
      genres,
      totalChapters: chapters.length,
      chapters,
      similar,
    };
  }

  /**
   * Get all image pages for a specific chapter.
   * @param {string} slug Manga slug
   * @param {string|number} chapter Chapter number or identifier
   */
  async getPages(slug, chapter) {
    const cleanSlug = slug.replace(/^\/+|\/+$/g, '').split('/')[0];
    const chStr = String(chapter).trim();

    // 1. Try common direct URL patterns
    const candidates = [
      `${this.baseUrl}/${cleanSlug}-chapter-${chStr}/`,
      `${this.baseUrl}/${cleanSlug}-chapter-${chStr.padStart(2, '0')}/`,
      `${this.baseUrl}/ch/${cleanSlug}-chapter-${chStr}/`,
    ];

    let html = null;
    for (const u of candidates) {
      try {
        const candidateHtml = await getHtml(u);
        if (candidateHtml && candidateHtml.includes('id="Baca_Komik"')) {
          html = candidateHtml;
          break;
        }
      } catch (_) {}
    }

    // 2. If direct URL candidate failed, fetch details to find exact chapter link
    if (!html || !html.includes('id="Baca_Komik"')) {
      const detailHtml = await getHtml(`${this.baseUrl}/manga/${cleanSlug}/`);
      const $d = cheerio.load(detailHtml);
      let targetHref = null;

      $d('#Daftar_Chapter tr').each((_, tr) => {
        const a = $d(tr).find('td.judulseries a').first();
        const text = a.text().trim();
        const href = a.attr('href') || '';
        if (
          text.toLowerCase().includes(`chapter ${chStr.toLowerCase()}`) ||
          href.toLowerCase().includes(`chapter-${chStr.toLowerCase()}/`)
        ) {
          targetHref = href;
          return false;
        }
      });

      if (targetHref) {
        const fullUrl = targetHref.startsWith('http')
          ? targetHref
          : `${this.baseUrl}${targetHref.startsWith('/') ? '' : '/'}${targetHref}`;
        html = await getHtml(fullUrl);
      }
    }

    if (!html || !html.includes('id="Baca_Komik"')) {
      throw new Error(`Chapter ${chStr} untuk manga '${cleanSlug}' tidak ditemukan`);
    }

    const $ = cheerio.load(html);
    const pages = [];

    $('#Baca_Komik img').each((_, img) => {
      const src = $(img).attr('data-src') || $(img).attr('src') || '';
      if (
        !src ||
        src.includes('komiku-promosi') ||
        src.includes('promosi') ||
        src.includes('ads') ||
        src.includes('banner')
      ) {
        return;
      }

      const cleanSrc = src.trim();
      pages.push({
        page: pages.length + 1,
        url: cleanSrc,
        directUrl: cleanSrc,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(cleanSrc)}`,
      });
    });

    // Convert slug to readable manga title (remove komik- prefix, -indo suffix, capitalize words)
    const mangaTitle = cleanSlug
      .replace(/^komik-/, '')
      .replace(/-indo$/, '')
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    return {
      source: this.name,
      title: `${mangaTitle} Chapter ${chStr}`,
      chapter: chStr,
      totalPages: pages.length,
      headers: {
        Referer: 'https://komiku.org/',
      },
      pages,
    };
  }
}

module.exports = KomikuSource;
