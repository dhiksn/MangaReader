/**
 * Base abstract class that every manga scraper/source must extend.
 */
class BaseSource {
  constructor(name, displayName) {
    if (new.target === BaseSource) {
      throw new TypeError('Cannot construct BaseSource instances directly');
    }
    this.name = name;
    this.displayName = displayName;
    this.icon = null;
  }

  /**
   * Extract or get the website favicon/icon URL.
   * Scrapes <link rel="icon"> or <link rel="apple-touch-icon"> from the website's HTML.
   * @returns {Promise<string|null>}
   */
  async getIcon() {
    if (this.icon) return this.icon;
    if (!this.baseUrl) return null;
    try {
      const { getHtml } = require('../utils/httpClient');
      const cheerio = require('cheerio');
      const html = await getHtml(this.baseUrl, { timeout: 8000 });
      const $ = cheerio.load(html);

      let iconHref =
        $('link[rel="apple-touch-icon"]').attr('href') ||
        $('link[rel="apple-touch-icon-precomposed"]').attr('href') ||
        $('link[rel="icon"][sizes*="192"]').attr('href') ||
        $('link[rel="icon"][sizes*="96"]').attr('href') ||
        $('link[rel="icon"][sizes*="32"]').attr('href') ||
        $('link[rel*="icon"]').attr('href');

      if (!iconHref) {
        this.icon = `${this.baseUrl.replace(/\/$/, '')}/favicon.ico`;
        return this.icon;
      }

      if (iconHref.startsWith('//')) {
        this.icon = `https:${iconHref}`;
      } else if (iconHref.startsWith('/')) {
        this.icon = `${this.baseUrl.replace(/\/$/, '')}${iconHref}`;
      } else if (!iconHref.startsWith('http') && !iconHref.startsWith('data:')) {
        this.icon = `${this.baseUrl.replace(/\/$/, '')}/${iconHref}`;
      } else {
        this.icon = iconHref;
      }
      return this.icon;
    } catch (_) {
      this.icon = `${this.baseUrl.replace(/\/$/, '')}/favicon.ico`;
      return this.icon;
    }
  }

  /**
   * Get popular / trending manga list.
   * @param {number} page Page number (1-indexed)
   * @returns {Promise<{page: number, hasNextPage: boolean, data: Array}>}
   */
  async getPopular(page = 1) {
    throw new Error(`getPopular() not implemented for source: ${this.name}`);
  }

  /**
   * Get latest / newly updated manga list.
   * @param {number} page Page number (1-indexed)
   * @param {string} [category] Category (e.g. 'all', 'normal', 'sensitive', 'nsfw')
   * @returns {Promise<{page: number, hasNextPage: boolean, data: Array}>}
   */
  async getLatest(page = 1, category = 'all') {
    throw new Error(`getLatest() not implemented for source: ${this.name}`);
  }

  /**
   * Search manga by query.
   * @param {string} query Search text
   * @param {number} page Page number (1-indexed)
   * @returns {Promise<{page: number, hasNextPage: boolean, data: Array}>}
   */
  async search(query, page = 1) {
    throw new Error(`search() not implemented for source: ${this.name}`);
  }

  /**
   * Get list of all available genres for this source.
   * @returns {Promise<Array<{name: string, slug: string}>>}
   */
  async getGenres() {
    throw new Error(`getGenres() not implemented for source: ${this.name}`);
  }

  /**
   * Get manga list filtered by genre.
   * @param {string} genre Genre identifier / name
   * @param {number} page Page number (1-indexed)
   * @returns {Promise<Object>}
   */
  async getByGenre(genre, page = 1) {
    throw new Error(`getByGenre() not implemented for source: ${this.name}`);
  }

  /**
   * Get list of available manga types (e.g. ['manga', 'manhwa', 'manhua']).
   * @returns {Promise<Array<string>>}
   */
  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  /**
   * Get manga list filtered by type.
   * @param {string} type Manga type ('manga', 'manhwa', 'manhua')
   * @param {number} page Page number (1-indexed)
   * @returns {Promise<Object>}
   */
  async getByType(type, page = 1) {
    throw new Error(`getByType() not implemented for source: ${this.name}`);
  }

  /**
   * Get complete manga list / directory.
   * @param {number} page Page number (1-indexed)
   * @param {Object} [options] Filter options
   * @returns {Promise<Object>}
   */
  async getList(page = 1, options = {}) {
    throw new Error(`getList() not implemented for source: ${this.name}`);
  }

  /**
   * Get detailed manga information and chapters list.
   * @param {string} slug Manga slug identifier
   * @returns {Promise<Object>}
   */
  async getDetails(slug) {
    throw new Error(`getDetails() not implemented for source: ${this.name}`);
  }

  /**
   * Get list of image pages for a specific chapter.
   * @param {string} slug Manga slug identifier
   * @param {string|number} chapter Chapter identifier / number
   * @param {string} [cdn] Optional CDN server identifier (e.g. 'cdn1', 'cdn2', 'cdn3')
   * @returns {Promise<{chapter: string, pages: Array<{page: number, url: string}>}>}
   */
  async getPages(slug, chapter, cdn = 'cdn1') {
    throw new Error(`getPages() not implemented for source: ${this.name}`);
  }
}

module.exports = BaseSource;
