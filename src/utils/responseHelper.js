/**
 * Helper to get the author name from environment variables.
 * Priority: process.env.API_AUTHOR -> process.env.AUTHOR -> 'dhiksn'
 * @returns {string}
 */
function getAuthor() {
  return process.env.API_AUTHOR || process.env.AUTHOR || 'dhiksn';
}

/**
 * Helper to build a clean, standardized pagination object.
 * Placed at the bottom of paginated list responses.
 *
 * @param {Object} options
 * @param {number|string} [options.page=1] Current page number
 * @param {number|string} [options.maxPage] Total maximum pages (if known)
 * @param {boolean} [options.hasNextPage] Whether a next page exists
 * @returns {Object}
 */
function formatPagination({ page = 1, maxPage, hasNextPage } = {}) {
  const currentPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedMaxPage =
    maxPage !== undefined && maxPage !== null ? Math.max(1, parseInt(maxPage, 10) || 1) : null;
  const hasPrev = currentPage > 1;
  const hasNext =
    hasNextPage !== undefined
      ? Boolean(hasNextPage)
      : parsedMaxPage !== null
      ? currentPage < parsedMaxPage
      : false;

  // If there's no next page, no previous page, and maxPage is <= 1 (single-page result), omit pagination
  if (!hasPrev && !hasNext && (parsedMaxPage === null || parsedMaxPage <= 1)) {
    return null;
  }

  const pagination = {
    page: currentPage,
  };

  if (parsedMaxPage !== null) {
    pagination.maxPage = parsedMaxPage;
  }

  pagination.hasNextPage = hasNext;
  pagination.nextPage = hasNext ? currentPage + 1 : null;
  pagination.prevPage = hasPrev ? currentPage - 1 : null;

  return pagination;
}

/**
 * Helper function to format response object:
 * - Inserts 'author' right below 'success'
 * - Guarantees 'pagination' is placed at the very bottom (after 'data')
 * @param {Object} data
 * @returns {Object}
 */
function formatResponse(data = {}) {
  const author = getAuthor();
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const hasSuccess = 'success' in data;
    const { success, author: existingAuthor, pagination, ...rest } = data;

    const ordered = {};
    if (hasSuccess) {
      ordered.success = success;
      ordered.author = existingAuthor || author;
    } else {
      ordered.author = existingAuthor || author;
    }

    Object.assign(ordered, rest);

    // Always place pagination at the very bottom (if present and valid)
    if (isPaginationValid(pagination)) {
      ordered.pagination = pagination;
    }

    return ordered;
  }
  return data;
}

/**
 * Helper to check whether a pagination object has multiple pages or valid navigation.
 * Returns false if there is only 1 page with no next/prev pages.
 * @param {Object} pagination
 * @returns {boolean}
 */
function isPaginationValid(pagination) {
  if (!pagination || typeof pagination !== 'object') return false;
  const hasNext = Boolean(pagination.nextPage);
  const hasPrev = Boolean(pagination.prevPage);
  const hasMultiplePages = Boolean(pagination.maxPage && Number(pagination.maxPage) > 1);
  return hasNext || hasPrev || hasMultiplePages;
}

/**
 * Express middleware that intercepts res.json to automatically:
 * 1. Inject 'author' right below 'success'
 * 2. Ensure 'pagination' is ordered at the very bottom of the response
 */
function authorMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const author = getAuthor();

      if ('success' in body) {
        let source = body.source || req.mangaSource?.name || req.params?.source;
        if (!source && req.originalUrl) {
          const match = req.originalUrl.match(/\/sources\/([^/?#]+)/i);
          if (match) {
            source = match[1].toLowerCase();
          }
        }

        const { success, author: existingAuthor, source: bodySource, pagination, ...rest } = body;
        const orderedBody = {
          success,
          author: existingAuthor || author,
          ...(source ? { source } : {}),
          ...rest,
        };

        // Always put pagination at the very bottom (if present and valid)
        if (isPaginationValid(pagination)) {
          orderedBody.pagination = pagination;
        }

        return originalJson(orderedBody);
      }
    }
    return originalJson(body);
  };

  next();
}

module.exports = {
  getAuthor,
  isPaginationValid,
  formatPagination,
  formatResponse,
  authorMiddleware,
};
