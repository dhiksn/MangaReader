const BaseSource = require('../BaseSource');
const { getHtml, getJson, fetchWithHeaders } = require('../../utils/httpClient');
const { decryptCryptoJS } = require('../../utils/crypto');
const { formatRelativeTime } = require('../../utils/date');
const { formatPagination } = require('../../utils/responseHelper');
const { createNotFound } = require('../../utils/errors');

class SoftkomikSource extends BaseSource {
  constructor() {
    super('softkomik', 'Softkomik');
    this.domain = 'softkomik.app';
    this.baseUrl = `https://${this.domain}`;
    this.icon = 'https://softkomik.app/icon-192.png';
    this.coverUrl = 'https://cover.softdevices.my.id/softkomik-cover';
    this.cdnUrl = 'https://image.komik.im/softkomik';
    this.cdnServers = {
      cdn1: 'https://image.komik.im/softkomik',
      cdn2: 'https://psy1.komik.im',
      cdn3: 'https://image.komik.im/softkomik',
    };
    this.encryptionKey = 'nYTInq9MwR4pWa8yeXtu/2iO3t9nGP65WHpWEvqpEdU=';
    this.imageToken = 'T4Kmwztku';

    // Session cache for authenticated requests
    this._authCookies = null;
    this._authExpiresAt = 0;

    // Genres cache
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;

    // Recommendations cache
    this._cachedRecommendations = null;
    this._cachedRecommendationsExpiresAt = 0;
  }

  /**
   * Helper to extract and parse Next.js __NEXT_DATA__ JSON from HTML.
   */
  _extractNextData(html) {
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
    if (!match) {
      throw new Error('Failed to find __NEXT_DATA__ in page HTML');
    }
    try {
      return JSON.parse(match[1]);
    } catch (err) {
      throw new Error(`Failed to parse __NEXT_DATA__ JSON: ${err.message}`);
    }
  }

  /**
   * Helper to decrypt _stk payload if present in pageProps.
   */
  _decryptPayload(stk) {
    if (!stk) return null;
    try {
      const decryptedStr = decryptCryptoJS(stk, this.encryptionKey);
      return JSON.parse(decryptedStr);
    } catch (err) {
      console.error('[Softkomik] Decryption error:', err.message);
      return null;
    }
  }

  /**
   * Authenticate with Softkomik using credentials from .env
   */
  async login() {
    const email = process.env.SOFTKOMIK_EMAIL;
    const password = process.env.SOFTKOMIK_PASSWORD;

    if (!email || !password) {
      throw new Error(
        'Untuk mengakses kategori NSFW, harap atur SOFTKOMIK_EMAIL dan SOFTKOMIK_PASSWORD di file .env'
      );
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Referer: `${this.baseUrl}/akun/login`,
          Origin: this.baseUrl,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        body: JSON.stringify({ email, password }),
      });

      const bodyText = await res.text();
      let json = {};
      try {
        json = JSON.parse(bodyText);
      } catch (_) {}

      if (!res.ok || json.code) {
        throw new Error(json.message || `Login gagal dengan status HTTP ${res.status}`);
      }

      // Extract set-cookie headers
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const parsedCookies = setCookies.map((c) => c.split(';')[0].trim());

      // Ensure showAdultContent=true cookie is present
      parsedCookies.push('showAdultContent=true');

      this._authCookies = parsedCookies.join('; ');
      this._authExpiresAt = Date.now() + 12 * 60 * 60 * 1000; // cache for 12 hours
      console.log('[Softkomik] Login berhasil sebagai:', email);
      return this._authCookies;
    } catch (err) {
      console.error('[Softkomik Login Error]:', err.message);
      throw err;
    }
  }

  /**
   * Ensure active authentication cookies exist if required.
   */
  async _ensureAuthenticated() {
    if (!this._authCookies || Date.now() > this._authExpiresAt) {
      await this.login();
    }
    return this._authCookies;
  }

  /**
   * Get latest updated comics from https://softkomik.app/komik/update
   * Supports categories: 'all', 'normal', 'sensitive', 'nsfw'
   * When 'all' is selected (default), it merges and sorts items by newest update (updatedAt descending).
   */
  async getLatest(page = 1, category = 'all') {
    const pageNum = parseInt(page, 10) || 1;
    const cleanCategory = String(category || 'all').toLowerCase();

    if (!['all', 'normal', 'sensitive', 'nsfw'].includes(cleanCategory)) {
      throw new Error(`Kategori '${category}' tidak valid. Pilihan yang tersedia: 'all', 'normal', 'sensitive', 'nsfw'`);
    }

    if (cleanCategory === 'all') {
      const fetchTasks = [
        this._fetchLatestCategory(pageNum, 'normal'),
        this._fetchLatestCategory(pageNum, 'sensitive'),
      ];

      // If credentials exist, also include nsfw
      if (process.env.SOFTKOMIK_EMAIL && process.env.SOFTKOMIK_PASSWORD) {
        fetchTasks.push(
          this._fetchLatestCategory(pageNum, 'nsfw').catch((err) => {
            console.warn('[Softkomik] NSFW fetch skipped or failed in category=all:', err.message);
            return { data: [], maxPage: 1 };
          })
        );
      }

      const results = await Promise.all(fetchTasks);
      const combined = [];
      const seenSlugs = new Set();
      let maxPage = 1;

      for (const res of results) {
        if (res.maxPage && res.maxPage > maxPage) maxPage = res.maxPage;
        for (const item of (res.data || [])) {
          if (!seenSlugs.has(item.slug)) {
            seenSlugs.add(item.slug);
            combined.push(item);
          }
        }
      }

      if (pageNum > 1 && (pageNum > maxPage || combined.length === 0)) {
        throw createNotFound(
          `Halaman ${pageNum} tidak ditemukan (maksimal halaman ${maxPage})`,
          'NOT_FOUND'
        );
      }

      // Sort by newest update at the top using raw timestamp
      combined.sort((a, b) => {
        const timeA = a._rawUpdatedAt ? new Date(a._rawUpdatedAt).getTime() : 0;
        const timeB = b._rawUpdatedAt ? new Date(b._rawUpdatedAt).getTime() : 0;
        return timeB - timeA;
      });

      // Format updatedAt into clean relative time (e.g. '2 jam yang lalu')
      combined.forEach((item) => {
        item.updatedAt = formatRelativeTime(item._rawUpdatedAt);
        delete item._rawUpdatedAt;
      });

      return {
        source: this.name,
        category: 'all',
        data: combined,
        pagination: formatPagination({
          page: pageNum,
          maxPage,
          hasNextPage: pageNum < maxPage,
        }),
        maxPage,
        page: pageNum,
        hasNextPage: pageNum < maxPage,
      };
    }

    const singleResult = await this._fetchLatestCategory(pageNum, cleanCategory);
    singleResult.data.forEach((item) => {
      item.updatedAt = formatRelativeTime(item._rawUpdatedAt);
      delete item._rawUpdatedAt;
    });
    return singleResult;
  }

  /**
   * Fetch single category from /komik/update
   * @private
   */
  async _fetchLatestCategory(pageNum, cleanCategory) {
    const headers = {
      Referer: `${this.baseUrl}/komik/update`,
    };

    // If requesting NSFW, authenticate first and attach cookies
    if (cleanCategory === 'nsfw') {
      const cookies = await this._ensureAuthenticated();
      headers['Cookie'] = cookies;
    } else if (this._authCookies) {
      headers['Cookie'] = this._authCookies;
    }

    const url =
      cleanCategory === 'normal'
        ? `${this.baseUrl}/komik/update?page=${pageNum}`
        : `${this.baseUrl}/komik/update?category=${cleanCategory}&page=${pageNum}`;

    const html = await getHtml(url, { headers });
    const nextData = this._extractNextData(html);
    const pageProps = nextData?.props?.pageProps;
    const initialData = pageProps?.initialData || {};
    const rawList = initialData.data || [];
    const maxPage = initialData.maxPage || 1;

    if (pageNum > 1 && (pageNum > maxPage || rawList.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan (maksimal halaman ${maxPage})`,
        'NOT_FOUND'
      );
    }

    const data = rawList.map((item) => {
      const slug = item.title_slug || item._id;
      const gambar = (item.gambar || '').replace(/^\//, '');
      return {
        title: item.title,
        slug: slug,
        cover: gambar ? `${this.coverUrl}/${gambar}` : null,
        status: item.status,
        type: item.type,
        latestChapter: item.latest_chapter || item.latestChapter,
        _rawUpdatedAt: item.updated_at,
        updatedAt: item.updated_at,
        contentRating: item.contentRating || cleanCategory,
      };
    });

    return {
      source: this.name,
      category: cleanCategory,
      data,
      pagination: formatPagination({
        page: pageNum,
        maxPage,
        hasNextPage: pageNum < maxPage,
      }),
      maxPage,
      page: pageNum,
      hasNextPage: pageNum < maxPage,
    };
  }

  /**
   * Get popular manga list from library.
   */
  async getPopular(page = 1) {
    const pageNum = parseInt(page, 10) || 1;
    const url = `${this.baseUrl}/komik/library?sortBy=popular&page=${pageNum}`;
    const html = await getHtml(url, {
      headers: { Referer: `${this.baseUrl}/` },
    });
    const nextData = this._extractNextData(html);
    const libData = nextData?.props?.pageProps?.libData;
    const rawList = libData?.data || [];
    const maxPage = libData?.maxPage || 1;

    if (pageNum > 1 && (pageNum > maxPage || rawList.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan (maksimal halaman ${maxPage})`,
        'NOT_FOUND'
      );
    }

    const data = rawList.map((item) => {
      const slug = item.title_slug || item._id;
      const gambar = (item.gambar || '').replace(/^\//, '');
      return {
        title: item.title,
        slug: slug,
        cover: gambar ? `${this.coverUrl}/${gambar}` : null,
        status: item.status,
        type: item.type,
        latestChapter: item.latest_chapter || item.latestChapter,
      };
    });

    return {
      source: this.name,
      data,
      pagination: formatPagination({
        page: pageNum,
        maxPage,
        hasNextPage: pageNum < maxPage,
      }),
      maxPage,
      page: pageNum,
      hasNextPage: pageNum < maxPage,
    };
  }

  async search(query, page = 1) {
    const pageNum = parseInt(page, 10) || 1;

    const headers = {
      Referer: `${this.baseUrl}/komik/list`,
    };

    // Attach session cookies if credentials exist so Softkomik includes 18+/uncensored/adult results
    if (this._authCookies) {
      headers['Cookie'] = this._authCookies;
    } else if (process.env.SOFTKOMIK_EMAIL && process.env.SOFTKOMIK_PASSWORD) {
      try {
        const cookies = await this._ensureAuthenticated();
        if (cookies) headers['Cookie'] = cookies;
      } catch (err) {
        console.warn('[Softkomik] Auth skipped during search, proceeding as guest:', err.message);
      }
    }

    // Use full search list page (https://softkomik.app/komik/list?name=...) which includes full metadata: covers, status, chapters, and server pagination
    const url = `${this.baseUrl}/komik/list?name=${encodeURIComponent(query)}&page=${pageNum}`;
    const html = await getHtml(url, { headers });
    const nextData = this._extractNextData(html);
    const initialData = nextData?.props?.pageProps?.initialData || {};
    let rawList = initialData?.data || [];
    let maxPage = initialData?.maxPage || 1;

    // Fallback to lightweight autocomplete API if nextData was missing
    if (!rawList.length && !nextData) {
      const fallbackUrl = `${this.baseUrl}/api/content/search?name=${encodeURIComponent(query)}`;
      const json = await getJson(fallbackUrl, { headers }).catch(() => null);
      if (json?.data) {
        rawList = json.data;
        maxPage = 1;
      }
    }

    if (pageNum > 1 && (pageNum > maxPage || rawList.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk pencarian '${query}' (maksimal halaman ${maxPage})`,
        'NOT_FOUND'
      );
    }

    const data = rawList.map((item) => {
      const slug = item.title_slug || item._id;
      const gambar = (item.gambar || '').replace(/^\//, '');
      return {
        title: item.title,
        slug: slug,
        cover: gambar ? `${this.coverUrl}/${gambar}` : null,
        status: item.status || null,
        type: item.type || null,
        latestChapter: item.latest_chapter || (item.latestChapter ? String(item.latestChapter) : null),
        updatedAt: formatRelativeTime(item.updated_at),
        contentRating: item.contentRating || 'normal',
        isAdult: item.contentRating === 'adult' || item.contentRating === 'adult_plus',
      };
    });

    return {
      source: this.name,
      query,
      data,
      pagination: formatPagination({
        page: pageNum,
        maxPage,
        hasNextPage: pageNum < maxPage,
      }),
      maxPage,
      page: pageNum,
      hasNextPage: pageNum < maxPage,
    };
  }

  /**
   * Get list of all available genres in Softkomik.
   */
  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const html = await getHtml(`${this.baseUrl}/komik/library`, {
      headers: { Referer: `${this.baseUrl}/` },
    });
    const nextData = this._extractNextData(html);
    const rawGenres = nextData?.props?.pageProps?.genre || [];

    const genres = rawGenres.map((g) => ({
      name: g.label || g.name || g.value,
      slug: (g.label || g.name || '').toLowerCase().replace(/\s+/g, '-'),
      contentRating: g.contentRating || 'normal',
    }));

    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000; // cache for 24 hours
    return genres;
  }

  /**
   * Resolve and normalize genre input to match Softkomik's exact case-sensitive genre label.
   * Handles lowercase, uppercase, and kebab-case inputs (e.g. 'ecchi' -> 'Ecchi', 'martial-arts' -> 'Martial Arts').
   * @param {string} inputGenre
   * @returns {Promise<string>}
   */
  async _resolveGenreName(inputGenre) {
    if (!inputGenre || typeof inputGenre !== 'string') return inputGenre;
    const raw = inputGenre.trim();
    const cleanLower = raw.toLowerCase().replace(/[\s\-_()]+/g, '');

    try {
      const genres = await this.getGenres();
      const match = genres.find((g) => {
        const gNameClean = (g.name || '').toLowerCase().replace(/[\s\-_()]+/g, '');
        const gSlugClean = (g.slug || '').toLowerCase().replace(/[\s\-_()]+/g, '');
        return (
          gNameClean === cleanLower ||
          gSlugClean === cleanLower ||
          (g.name && g.name.toLowerCase() === raw.toLowerCase()) ||
          (g.slug && g.slug.toLowerCase() === raw.toLowerCase())
        );
      });
      if (match) {
        return match.value || match.name;
      }
    } catch (_) {}

    return raw;
  }

  /**
   * Get comics list filtered by genre from https://softkomik.app/komik/genre/:genre
   * @param {string} genre Genre name (e.g. 'Action', 'Fantasy', 'ecchi', 'martial-arts')
   * @param {number} [page=1] Page number
   */
  async getByGenre(genre, page = 1) {
    const pageNum = parseInt(page, 10) || 1;
    const rawGenre = String(genre || '').trim();
    if (!rawGenre) {
      throw new Error("Parameter 'genre' wajib diisi");
    }

    // Resolve case-sensitivity and slug mapping (e.g. 'ecchi' -> 'Ecchi', 'martial-arts' -> 'Martial Arts')
    const targetGenre = await this._resolveGenreName(rawGenre);

    const headers = { Referer: `${this.baseUrl}/` };
    if (this._authCookies) {
      headers['Cookie'] = this._authCookies;
    } else if (process.env.SOFTKOMIK_EMAIL && process.env.SOFTKOMIK_PASSWORD) {
      try {
        const cookies = await this._ensureAuthenticated();
        if (cookies) headers['Cookie'] = cookies;
      } catch (_) {}
    }

    const url = `${this.baseUrl}/komik/genre/${encodeURIComponent(targetGenre)}?page=${pageNum}`;
    const html = await getHtml(url, { headers });
    const nextData = this._extractNextData(html);
    const genreData = nextData?.props?.pageProps?.data || nextData?.props?.pageProps?.libData || {};
    const rawList = genreData?.data || [];
    const maxPage = genreData?.maxPage || 1;
    const resolvedGenre = nextData?.props?.pageProps?.genre || targetGenre;

    if (pageNum > 1 && (pageNum > maxPage || rawList.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk genre '${rawGenre}' (maksimal halaman ${maxPage})`,
        'NOT_FOUND'
      );
    }

    const data = rawList.map((item) => {
      const slug = item.title_slug || item._id;
      const gambar = (item.gambar || '').replace(/^\//, '');
      return {
        title: item.title,
        slug: slug,
        cover: gambar ? `${this.coverUrl}/${gambar}` : null,
        status: item.status,
        type: item.type,
        latestChapter: item.latest_chapter || (item.latestChapter ? String(item.latestChapter) : null),
        updatedAt: formatRelativeTime(item.updated_at),
        contentRating: item.contentRating || 'normal',
      };
    });

    return {
      source: this.name,
      genre: resolvedGenre,
      data,
      pagination: formatPagination({
        page: pageNum,
        maxPage,
        hasNextPage: pageNum < maxPage,
      }),
      maxPage,
      page: pageNum,
      hasNextPage: pageNum < maxPage,
    };
  }

  /**
   * Get comics list filtered by type from https://softkomik.app/komik/type/:type
   * @param {string} type Manga type ('manga', 'manhwa', 'manhua')
   * @param {number} [page=1] Page number
   */
  async getByType(type, page = 1) {
    const pageNum = parseInt(page, 10) || 1;
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) {
      throw new Error("Parameter 'type' wajib diisi");
    }

    const headers = { Referer: `${this.baseUrl}/` };
    if (this._authCookies) {
      headers['Cookie'] = this._authCookies;
    } else if (process.env.SOFTKOMIK_EMAIL && process.env.SOFTKOMIK_PASSWORD) {
      try {
        const cookies = await this._ensureAuthenticated();
        if (cookies) headers['Cookie'] = cookies;
      } catch (_) {}
    }

    const url = `${this.baseUrl}/komik/type/${encodeURIComponent(cleanType)}?page=${pageNum}`;
    const html = await getHtml(url, { headers });
    const nextData = this._extractNextData(html);
    const typeData = nextData?.props?.pageProps?.data || {};
    const rawList = typeData?.data || [];
    const maxPage = typeData?.maxPage || 1;
    const resolvedType = nextData?.props?.pageProps?.type || cleanType;

    if (pageNum > 1 && (pageNum > maxPage || rawList.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk tipe '${cleanType}' (maksimal halaman ${maxPage})`,
        'NOT_FOUND'
      );
    }

    const data = rawList.map((item) => {
      const slug = item.title_slug || item._id;
      const gambar = (item.gambar || '').replace(/^\//, '');
      return {
        title: item.title,
        slug: slug,
        cover: gambar ? `${this.coverUrl}/${gambar}` : null,
        status: item.status,
        type: item.type,
        latestChapter: item.latest_chapter || (item.latestChapter ? String(item.latestChapter) : null),
        updatedAt: formatRelativeTime(item.updated_at),
        contentRating: item.contentRating || 'normal',
      };
    });

    return {
      source: this.name,
      type: resolvedType,
      data,
      pagination: formatPagination({
        page: pageNum,
        maxPage,
        hasNextPage: pageNum < maxPage,
      }),
      maxPage,
      page: pageNum,
      hasNextPage: pageNum < maxPage,
    };
  }

  async getDetails(slug) {
    const cleanSlug = slug.replace(/^\/+|\/+$/g, '').split('/')[0];
    const url = `${this.baseUrl}/${cleanSlug}`;
    const html = await getHtml(url, {
      headers: { Referer: `${this.baseUrl}/` },
    });

    const nextData = this._extractNextData(html);
    const pageProps = nextData?.props?.pageProps;
    const stk = pageProps?._stk;
    const decrypted = this._decryptPayload(stk);

    const data = decrypted?.data || pageProps?.data || {};
    const chapterData = decrypted?.chapterData || {};

    const rawChapters = chapterData?.chapter || [];
    const chapters = rawChapters.map((ch) => {
      const chStr = ch.chapter || '';
      return {
        chapter: chStr,
        title: `Chapter ${chStr}`,
        slug: `${cleanSlug}/${chStr}`,
      };
    });

    const gambar = (data.gambar || '').replace(/^\//, '');
    const similar = await this._getRecommendations(cleanSlug, data.type, data.Genre);

    return {
      source: this.name,
      title: data.title,
      altTitle: data.title_alt,
      cover: gambar ? `${this.coverUrl}/${gambar}` : null,
      synopsis: data.sinopsis,
      author: data.author,
      year: data.tahun,
      status: data.status,
      type: data.type,
      genres: data.Genre || [],
      rating: data.rating ? Math.round(data.rating.value * 100) / 100 : null,
      totalChapters: chapters.length,
      chapters,
      similar,
    };
  }

  /**
   * Fetch recommended / similar comics from Softkomik.
   * Scrapes from official endpoint api.softkomik.org/komik/rekomendasi
   * and ranks them by genre and type match.
   * @private
   */
  async _getRecommendations(currentSlug, currentType, currentGenres = []) {
    try {
      if (!this._cachedRecommendations || Date.now() >= this._cachedRecommendationsExpiresAt) {
        const items = await getJson('https://api.softkomik.org/komik/rekomendasi', {
          headers: {
            Origin: 'https://softkomik.app',
            Referer: 'https://softkomik.app/',
          },
        });
        if (Array.isArray(items)) {
          this._cachedRecommendations = items;
          this._cachedRecommendationsExpiresAt = Date.now() + 10 * 60 * 1000;
        }
      }

      const list = this._cachedRecommendations || [];
      const genreSet = new Set((currentGenres || []).map((g) => String(g).toLowerCase()));
      const targetType = String(currentType || '').toLowerCase();

      return list
        .filter((item) => {
          const s = item?.title_slug || '';
          return s && s !== currentSlug && item?.title && item?.gambar;
        })
        .map((item) => {
          const gambar = (item.gambar || '').replace(/^\//, '');
          const itemType = String(item.type || '').toLowerCase();
          const itemGenres = Array.isArray(item.Genre) ? item.Genre : [];
          const matchGenres = itemGenres.filter((g) => genreSet.has(String(g).toLowerCase())).length;
          const matchType = targetType && itemType === targetType ? 1 : 0;
          const score = 3 * matchGenres + 2 * matchType;

          return {
            title: item.title,
            slug: item.title_slug,
            cover: gambar ? `${this.coverUrl}/${gambar}` : null,
            status: item.status || null,
            type: item.type || null,
            latestChapter: item.latest_chapter || null,
            contentRating: item.contentRating || 'normal',
            _score: score,
          };
        })
        .sort((a, b) => b._score - a._score)
        .map(({ _score, ...item }) => item);
    } catch {
      return [];
    }
  }

  async getPages(slug, chapter, cdn = 'cdn1') {
    const cleanSlug = slug.replace(/^\/+|\/+$/g, '').split('/')[0];
    const cleanChapter = String(chapter).replace(/^\/+|\/+$/g, '');
    const cleanCdn = String(cdn || 'cdn1').toLowerCase();
    const activeCdnBase = this.cdnServers[cleanCdn] || this.cdnServers.cdn1;

    const url = `${this.baseUrl}/${cleanSlug}/chapter/${cleanChapter}`;

    const html = await getHtml(url, {
      headers: { Referer: `${this.baseUrl}/` },
    });

    const nextData = this._extractNextData(html);
    const pageProps = nextData?.props?.pageProps;
    const stk = pageProps?._stk;
    const decrypted = this._decryptPayload(stk);

    const imgList =
      decrypted?.imgList ||
      decrypted?.data?.data?.imageSrc ||
      pageProps?.data?.data?.imageSrc ||
      [];

    // Convert slug to readable manga title (remove -bahasa-indonesia suffix, capitalize words)
    const mangaTitle = cleanSlug
      .replace(/-bahasa-indonesia$/, '')
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    const pages = imgList.map((rawPath, index) => {
      const cleanPath = String(rawPath).trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/');
      const directUrl = `${activeCdnBase}/${cleanPath}?id=${this.imageToken}`;
      const proxyPath = `/api/proxy/image?url=${encodeURIComponent(directUrl)}`;
      return {
        page: index + 1,
        url: directUrl,
        directUrl,
        proxyUrl: proxyPath,
      };
    });

    return {
      source: this.name,
      title: `${mangaTitle} Chapter ${cleanChapter}`,
      slug: cleanSlug,
      chapter: cleanChapter,
      currentCdn: cleanCdn in this.cdnServers ? cleanCdn : 'cdn1',
      availableCdns: [
        { id: 'cdn1', name: 'CDN 1 (image.komik.im)' },
        { id: 'cdn2', name: 'CDN 2 (psy1.komik.im)' },
        { id: 'cdn3', name: 'CDN 3 (image.komik.im Backup)' },
      ],
      totalPages: pages.length,
      headers: {
        Referer: `${this.baseUrl}/`,
      },
      pages,
    };
  }
}

module.exports = SoftkomikSource;
