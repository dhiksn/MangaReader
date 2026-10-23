const express = require('express');
const { getSource, listSources } = require('../sources');
const BaseSource = require('../sources/BaseSource');
const { createNotFound, createBadRequest } = require('../utils/errors');
const { formatPagination, isPaginationValid } = require('../utils/responseHelper');
const {
  validatePageParam,
  validateCategoryParam,
  validateSlugParam,
} = require('../middlewares/security');

const router = express.Router();

/**
 * Middleware to resolve and validate the requested source.
 */
function resolveSource(req, res, next) {
  const sourceName = req.params.source;
  if (!sourceName) {
    return next(createBadRequest("Parameter 'source' wajib diisi", 'INVALID_PARAMETER'));
  }

  const source = getSource(sourceName);
  if (!source) {
    const available = listSources().map((s) => s.id).join(', ');
    return next(
      createNotFound(
        `Sumber manga '${sourceName}' tidak ditemukan. Pilihan tersedia: ${available}`,
        'NOT_FOUND'
      )
    );
  }
  req.mangaSource = source;
  next();
}

/**
 * Validate that a requested page number does not exceed maximum pages or return empty data.
 * Throws 404 NOT_FOUND if page > 1 and out of bounds.
 */
function validatePageBounds(page, result) {
  if (page <= 1) return;
  const maxPage = result.maxPage || result.pagination?.maxPage;
  if ((maxPage && page > maxPage) || (result.data && result.data.length === 0)) {
    throw createNotFound(
      `Halaman ${page} tidak ditemukan${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
      'NOT_FOUND'
    );
  }
}

/**
 * GET /api/sources
 * List all available manga sources.
 */
router.get('/sources', (req, res) => {
  res.json({
    success: true,
    data: listSources(),
  });
});

/**
 * GET /api/sources/:source/popular?page=1
 * Get popular manga list for a source.
 */
router.get('/sources/:source/popular', resolveSource, async (req, res, next) => {
  try {
    const page = validatePageParam(req.query.page);
    const result = await req.mangaSource.getPopular(page);
    validatePageBounds(page, result);
    const pagination =
      result.pagination !== undefined
        ? result.pagination
        : formatPagination({
            page,
            maxPage: result.maxPage,
            hasNextPage: result.hasNextPage,
          });

    res.json({
      success: true,
      source: result.source || req.mangaSource.name,
      data: result.data || [],
      ...(isPaginationValid(pagination) ? { pagination } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/latest?page=1
 * Get latest manga list for a source.
 * - Softkomik: category=all|normal|sensitive|nsfw
 * - Komiku: scrapes from https://komiku.org/pustaka/ (supports orderby, tipe, genre, status)
 */
router.get('/sources/:source/latest', resolveSource, async (req, res, next) => {
  try {
    const page = validatePageParam(req.query.page);
    let options = req.query;
    if (req.mangaSource.name === 'softkomik' || req.query.category) {
      options = validateCategoryParam(req.query.category);
    }

    const result = await req.mangaSource.getLatest(page, options);
    validatePageBounds(page, result);
    const pagination =
      result.pagination !== undefined
        ? result.pagination
        : formatPagination({
            page,
            maxPage: result.maxPage,
            hasNextPage: result.hasNextPage,
          });

    res.json({
      success: true,
      source: result.source || req.mangaSource.name,
      ...(result.from ? { from: result.from } : {}),
      ...(result.category ? { category: result.category } : {}),
      ...(result.orderby ? { orderby: result.orderby } : {}),
      data: result.data || [],
      ...(isPaginationValid(pagination) ? { pagination } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/rating?page=1
 * Get top rated manga list for a source.
 * - Hwago: https://02.hwago.xyz/browse?sort=rating
 */
router.get('/sources/:source/rating', resolveSource, async (req, res, next) => {
  try {
    if (typeof req.mangaSource.getRating !== 'function') {
      throw createNotFound(
        `Sumber '${req.mangaSource.name}' tidak menyediakan endpoint /rating`,
        'NOT_FOUND'
      );
    }

    const page = validatePageParam(req.query.page);
    const result = await req.mangaSource.getRating(page);
    validatePageBounds(page, result);
    const pagination =
      result.pagination !== undefined
        ? result.pagination
        : formatPagination({
            page,
            maxPage: result.maxPage,
            hasNextPage: result.hasNextPage,
          });

    res.json({
      success: true,
      source: result.source || req.mangaSource.name,
      sort: result.sort || 'rating',
      ...(result.from ? { from: result.from } : {}),
      data: result.data || [],
      ...(isPaginationValid(pagination) ? { pagination } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/az?page=1
 * Get alphabetical A-Z manga list for a source.
 * - Hwago: https://02.hwago.xyz/browse?sort=az
 */
router.get(['/sources/:source/az', '/sources/:source/alphabetical'], resolveSource, async (req, res, next) => {
  try {
    if (typeof req.mangaSource.getAz !== 'function') {
      throw createNotFound(
        `Sumber '${req.mangaSource.name}' tidak menyediakan endpoint /az`,
        'NOT_FOUND'
      );
    }

    const page = validatePageParam(req.query.page);
    const result = await req.mangaSource.getAz(page);
    validatePageBounds(page, result);
    const pagination =
      result.pagination !== undefined
        ? result.pagination
        : formatPagination({
            page,
            maxPage: result.maxPage,
            hasNextPage: result.hasNextPage,
          });

    res.json({
      success: true,
      source: result.source || req.mangaSource.name,
      sort: result.sort || 'az',
      ...(result.from ? { from: result.from } : {}),
      data: result.data || [],
      ...(isPaginationValid(pagination) ? { pagination } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/list?page=1
 * Get directory / catalog list of manga.
 * - Komiku: scrapes from https://komiku.org/daftar-komik/ (supports query params: page, letter/huruf)
 */
router.get('/sources/:source/list', resolveSource, async (req, res, next) => {
  try {
    if (
      typeof req.mangaSource.getList !== 'function' ||
      req.mangaSource.getList === BaseSource.prototype.getList
    ) {
      throw createNotFound(
        `Sumber '${req.mangaSource.name}' tidak menyediakan endpoint /list`,
        'NOT_FOUND'
      );
    }

    const page = validatePageParam(req.query.page);
    const result = await req.mangaSource.getList(page, req.query);
    validatePageBounds(page, result);
    const pagination =
      result.pagination !== undefined
        ? result.pagination
        : formatPagination({
            page,
            maxPage: result.maxPage,
            hasNextPage: result.hasNextPage,
          });

    res.json({
      success: true,
      source: result.source || req.mangaSource.name,
      ...(result.from ? { from: result.from } : {}),
      ...(result.letter ? { letter: result.letter } : {}),
      ...(result.sort ? { sort: result.sort } : {}),
      ...(result.status ? { status: result.status } : {}),
      ...(result.type ? { type: result.type } : {}),
      ...(result.genre ? { genre: result.genre } : {}),
      data: result.data || [],
      ...(isPaginationValid(pagination) ? { pagination } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/search?q=query&page=1
 * Search manga across a source.
 */
router.get('/sources/:source/search', resolveSource, async (req, res, next) => {
  try {
    const rawQuery = req.query.q || req.query.query;
    if (!rawQuery || typeof rawQuery !== 'string' || !rawQuery.trim()) {
      throw createBadRequest(
        'Parameter query "q" wajib diisi (contoh: ?q=magic)',
        'INVALID_PARAMETER'
      );
    }
    const query = rawQuery.trim();
    const page = validatePageParam(req.query.page);
    const result = await req.mangaSource.search(query, page);
    validatePageBounds(page, result);
    const pagination =
      result.pagination !== undefined
        ? result.pagination
        : formatPagination({
            page,
            maxPage: result.maxPage,
            hasNextPage: result.hasNextPage,
          });

    const isEmpty = !result.data || result.data.length === 0;
    res.json({
      success: !isEmpty,
      source: result.source || req.mangaSource.name,
      query,
      data: isEmpty
        ? { message: `Tidak ada hasil untuk "${query}"` }
        : result.data,
      ...(isPaginationValid(pagination) && !isEmpty ? { pagination } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/genres
 * Get list of all available genres for a source.
 */
router.get('/sources/:source/genres', resolveSource, async (req, res, next) => {
  try {
    const genres = await req.mangaSource.getGenres();
    res.json({
      success: true,
      source: req.mangaSource.name,
      data: genres,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/genres/:genre?page=1
 * Get manga list filtered by genre.
 */
router.get('/sources/:source/genres/:genre', resolveSource, async (req, res, next) => {
  try {
    const genre = String(req.params.genre || '').trim();
    if (!genre) {
      throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');
    }
    const page = validatePageParam(req.query.page);
    const result = await req.mangaSource.getByGenre(genre, page);
    validatePageBounds(page, result);
    const pagination =
      result.pagination !== undefined
        ? result.pagination
        : formatPagination({
            page,
            maxPage: result.maxPage,
            hasNextPage: result.hasNextPage,
          });

    res.json({
      success: true,
      source: result.source || req.mangaSource.name,
      genre: result.genre || genre,
      ...(result.from ? { from: result.from } : {}),
      data: result.data || [],
      ...(isPaginationValid(pagination) ? { pagination } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/types
 * Get list of available manga types ('manga', 'manhwa', 'manhua').
 */
router.get('/sources/:source/types', resolveSource, async (req, res, next) => {
  try {
    const types = await req.mangaSource.getTypes();
    res.json({
      success: true,
      source: req.mangaSource.name,
      data: types,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/types/:type?page=1
 * Get manga list filtered by type ('manga', 'manhwa', 'manhua').
 */
router.get('/sources/:source/types/:type', resolveSource, async (req, res, next) => {
  try {
    const rawType = String(req.params.type || '').trim().toLowerCase();
    const validTypes =
      typeof req.mangaSource.getTypes === 'function'
        ? await req.mangaSource.getTypes()
        : ['manga', 'manhwa', 'manhua'];
    if (!validTypes.includes(rawType)) {
      throw createBadRequest(
        `Tipe '${rawType}' tidak valid. Pilihan tersedia: ${validTypes.join(', ')}`,
        'INVALID_PARAMETER'
      );
    }
    const page = validatePageParam(req.query.page);
    const result = await req.mangaSource.getByType(rawType, page);
    validatePageBounds(page, result);
    const pagination =
      result.pagination !== undefined
        ? result.pagination
        : formatPagination({
            page,
            maxPage: result.maxPage,
            hasNextPage: result.hasNextPage,
          });

    res.json({
      success: true,
      source: result.source || req.mangaSource.name,
      type: result.type || rawType,
      ...(result.from ? { from: result.from } : {}),
      data: result.data || [],
      ...(isPaginationValid(pagination) ? { pagination } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/manga/:slug
 * Get full manga details, synopsis, and chapters.
 */
router.get('/sources/:source/manga/:slug', resolveSource, async (req, res, next) => {
  try {
    const slug = validateSlugParam(req.params.slug);
    const { source, ...rest } = await req.mangaSource.getDetails(slug);

    // Strip internal-only fields from chapters before sending response
    if (Array.isArray(rest.chapters)) {
      rest.chapters = rest.chapters.map(({ id, chapterNumber, ...pub }) => pub);
    }

    res.json({ success: true, source, data: rest });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sources/:source/chapter/:slug/:chapter?cdn=cdn1|cdn2|cdn3
 * Get chapter image pages with selectable CDN.
 */
router.get('/sources/:source/chapter/:slug/:chapter', resolveSource, async (req, res, next) => {
  try {
    const slug = validateSlugParam(req.params.slug);
    const chapter = String(req.params.chapter || '').trim();
    if (!chapter) {
      throw createBadRequest("Parameter 'chapter' wajib diisi", 'INVALID_PARAMETER');
    }

    const rawCdn = req.query.cdn || 'cdn1';
    const cdn = String(rawCdn).toLowerCase().trim();
    const validCdns = ['cdn1', 'cdn2', 'cdn3'];
    if (!validCdns.includes(cdn)) {
      throw createBadRequest(
        `Pilihan CDN '${rawCdn}' tidak valid. Pilihan tersedia: ${validCdns.join(', ')}`,
        'INVALID_PARAMETER'
      );
    }

    const { source, ...result } = await req.mangaSource.getPages(slug, chapter, cdn);
    const host = req.get('host');
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}`;

    const formattedPages = (result.pages || []).map((p) => {
      const fullProxy = p.proxyUrl?.startsWith('http') ? p.proxyUrl : `${baseUrl}${p.proxyUrl}`;
      return {
        page: p.page,
        url: fullProxy,
        directUrl: p.directUrl || p.url,
        proxyUrl: fullProxy,
      };
    });

    res.json({
      success: true,
      source,
      data: {
        ...result,
        pages: formattedPages,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
