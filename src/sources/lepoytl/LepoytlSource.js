const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml, getJson } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

const PAGE_SIZE = 20;

class LepoytlSource extends BaseSource {
  constructor() {
    super('lepoytl', 'Lepoy TL');
    this.baseUrl = 'https://www.lepoytl.my.id';
    this.icon = `${this.baseUrl}/favicon.ico`;
  }

  getSupportedSorts() {
    return [{ id: 'latest', name: 'Terbaru' }];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _fixCoverUrl(url) {
    if (!url) return null;
    return url
      .replace(/\/s\d+-c\//g, '/w600/')
      .replace(/=s\d+-c$/, '=w600')
      .replace(/\/s\d+-c-rw\//g, '/w600/')
      .replace(/=s\d+-c-rw$/, '=w600');
  }

  _slugFromUrl(url) {
    if (!url) return null;
    return url.replace(/\/$/, '').split('/').pop();
  }

  _parseEntries(entries) {
    return entries.map((entry) => {
      const title = entry.title?.['$t'] || '';
      const href = entry.link?.find((l) => l.rel === 'alternate')?.href || '';
      const slug = this._slugFromUrl(href);

      let cover = null;
      if (entry['media$thumbnail']?.url) {
        cover = this._fixCoverUrl(entry['media$thumbnail'].url);
      } else if (entry.content?.['$t']) {
        const m = entry.content['$t'].match(/<img[^>]+src="([^"]+)"/i);
        if (m) cover = m[1];
      }

      // Labels contain genres, status, rating etc.
      const labels = (entry.category || []).map((c) => c.term);

      return { title, slug, href, cover, labels };
    });
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const startIndex = PAGE_SIZE * (pageNum - 1) + 1;
    const url = `${this.baseUrl}/feeds/posts/default/-/Series?alt=json&orderby=published&max-results=${PAGE_SIZE + 1}&start-index=${startIndex}`;

    const json = await getJson(url);
    const feed = json.feed || {};
    const entries = feed.entry || [];

    // If we got PAGE_SIZE+1, there's a next page
    const hasNextPage = entries.length > PAGE_SIZE;
    const slice = entries.slice(0, PAGE_SIZE);
    const parsed = this._parseEntries(slice);

    const data = parsed.map(({ title, slug, cover, labels }) => {
      const status = labels.some((l) => l.toLowerCase() === 'ongoing') ? 'ongoing'
        : labels.some((l) => l.toLowerCase() === 'completed') ? 'completed'
        : labels.some((l) => l.toLowerCase() === 'hiatus') ? 'hiatus'
        : null;
      return { title, slug, cover, status };
    });

    return { source: this.name, page: pageNum, maxPage: hasNextPage ? pageNum + 1 : pageNum, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const startIndex = PAGE_SIZE * (pageNum - 1) + 1;
    const q = encodeURIComponent(String(query || '').trim());
    const url = `${this.baseUrl}/feeds/posts/default/-/Series?alt=json&orderby=published&max-results=${PAGE_SIZE + 1}&start-index=${startIndex}&q=label:Series+${q}`;

    const json = await getJson(url);
    const entries = json.feed?.entry || [];
    const hasNextPage = entries.length > PAGE_SIZE;
    const parsed = this._parseEntries(entries.slice(0, PAGE_SIZE));

    const data = parsed.map(({ title, slug, cover }) => ({ title, slug, cover }));
    return { source: this.name, query: String(query || '').trim(), page: pageNum, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '');
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    // Construct full URL — slugs look like "2026/09/ore-wa-bishoujo-v-tuber.html"
    // or just the last segment "ore-wa-bishoujo-v-tuber.html"
    // We need to find the full URL via API or use the slug directly if it has the year path
    let postUrl;
    if (cleanSlug.match(/^\d{4}\/\d{2}\//)) {
      postUrl = `${this.baseUrl}/${cleanSlug}`;
    } else {
      // Search by title slug to get full URL
      const searchUrl = `${this.baseUrl}/feeds/posts/default/-/Series?alt=json&max-results=1&q=${encodeURIComponent(cleanSlug.replace(/-/g, ' ').replace(/\.html$/, ''))}`;
      try {
        const json = await getJson(searchUrl);
        const entry = json.feed?.entry?.[0];
        postUrl = entry?.link?.find((l) => l.rel === 'alternate')?.href;
      } catch (_) {}
      if (!postUrl) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Lepoy TL`, 'NOT_FOUND');
    }

    let html;
    try {
      html = await getHtml(postUrl);
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Lepoy TL`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1[itemprop="name"], h1').filter((_, el) => $(el).text().trim().length > 0).first().text().trim() || cleanSlug;
    const cover = this._fixCoverUrl($('img[itemprop="image"], img.thumb').first().attr('src') || null);

    // Status from [data-status] span
    const statusRaw = $('[data-status]').attr('data-status')?.toLowerCase() || '';
    let status = null;
    if (statusRaw.includes('ongoing')) status = 'ongoing';
    else if (statusRaw.includes('completed') || statusRaw.includes('tamat')) status = 'completed';
    else if (statusRaw.includes('hiatus')) status = 'hiatus';

    // Metadata from dt/dd pairs
    let type = null, author = null, year = null;
    const dts = $('dt').toArray();
    for (const dtEl of dts) {
      const key = $(dtEl).text().replace(':', '').trim().toLowerCase();
      const val = $(dtEl).next('dd').text().trim();
      if (!val) continue;
      if (key === 'type' || key === 'tipe') type = val.toLowerCase();
      else if (key === 'author' || key === 'penulis') author = val;
      else if (key === 'published' || key === 'dirilis') {
        const m = val.match(/\d{4}/);
        if (m) year = m[0];
      } else if (key === 'status') {
        const v = val.toLowerCase();
        if (!status) {
          if (v.includes('ongoing')) status = 'ongoing';
          else if (v.includes('completed') || v.includes('tamat')) status = 'completed';
          else if (v.includes('hiatus')) status = 'hiatus';
        }
      }
    }

    // Synopsis — from schema or paragraph
    const synopsisSchema = $('script[type="application/ld+json"]').filter((_, el) => $(el).html()?.includes('"description"')).first().html();
    let synopsis = null;
    if (synopsisSchema) {
      const m = synopsisSchema.match(/"description"\s*:\s*"([\s\S]*?)(?<!\\)"/);
      if (m) synopsis = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
    }
    if (!synopsis) {
      synopsis = $('#synopsis, #Sinopse, #sinopas, .sinopsis, .sinopas').first().text().trim() || null;
    }
    if (!synopsis) {
      // Find a paragraph that's not boilerplate
      $('p').each((_, el) => {
        const txt = $(el).text().trim();
        if (txt.length > 50 && !txt.toLowerCase().includes('baca komik') && !txt.toLowerCase().includes('bahasa indonesia')) {
          synopsis = txt;
          return false;
        }
      });
    }

    // Genres from dt "Genre" dd a links or labels
    const genres = [];
    const seenG = new Set();
    $('dl:contains("Genre") dd a, dl:contains("Genre") dd').each((_, el) => {
      const links = $(el).find('a');
      if (links.length) {
        links.each((__, a) => {
          const name = $(a).text().trim();
          const href = $(a).attr('href') || '';
          const m = href.match(/label\/([^?/]+)/);
          const gSlug = m ? decodeURIComponent(m[1]).toLowerCase().replace(/\s+/g, '-') : name.toLowerCase().replace(/\s+/g, '-');
          if (!name || seenG.has(name)) return;
          seenG.add(name);
          genres.push({ name, slug: gSlug });
        });
      } else {
        // Plain text, comma-separated
        $(el).text().split(/[,\n]/).forEach((g) => {
          const name = g.trim();
          if (!name || seenG.has(name)) return;
          seenG.add(name);
          genres.push({ name, slug: name.toLowerCase().replace(/\s+/g, '-') });
        });
      }
    });

    // Find chapter feed label from script
    let chapterFeedLabel = null;
    const scripts = $('script:not([src])').toArray();
    for (const sc of scripts) {
      const content = $(sc).html() || '';
      // Pattern: clwd.run('LABEL')
      const m1 = content.match(/clwd\.run\('([^']+)'\)/);
      if (m1) { chapterFeedLabel = decodeURIComponent(m1[1]); break; }
      // Pattern: label = 'LABEL'
      const m2 = content.match(/label\s*=\s*'([^']+)'/);
      if (m2) { chapterFeedLabel = decodeURIComponent(m2[1]); break; }
      // Pattern: var label_chapter = "LABEL"
      const m3 = content.match(/label_chapter\s*=\s*["']([^"']+)["']/);
      if (m3) { chapterFeedLabel = m3[1]; break; }
      // Pattern: #chapterlist data-post-title
    }
    if (!chapterFeedLabel) {
      chapterFeedLabel = $('#chapterlist').attr('data-post-title') || null;
    }

    // Fetch chapters
    const chapters = [];
    if (chapterFeedLabel) {
      try {
        const chUrl = `${this.baseUrl}/feeds/posts/default/-/${encodeURIComponent(chapterFeedLabel)}?alt=json&orderby=published&max-results=9999`;
        const chJson = await getJson(chUrl);
        const chEntries = (chJson.feed?.entry || []).reverse();
        const postSlug = this._slugFromUrl(postUrl);

        chEntries.forEach((entry, idx) => {
          const chTitle = entry.title?.['$t'] || '';
          const chHref = entry.link?.find((l) => l.rel === 'alternate')?.href || '';
          const chSlug = this._slugFromUrl(chHref);
          // Skip the manga detail post itself
          if (chSlug === postSlug) return;
          const dateRaw = entry.published?.['$t']?.split('T')[0] || null;
          chapters.push({
            title: chTitle,
            slug: chHref,
            endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(chHref)}`,
            date: dateRaw,
          });
        });
      } catch (_) {}
    }

    // Related — fetch recent Series posts from Blogger API, exclude current
    const related = [];
    try {
      const relUrl = `${this.baseUrl}/feeds/posts/default/-/Series?alt=json&max-results=13&orderby=published`;
      const relJson = await getJson(relUrl);
      const relEntries = relJson.feed?.entry || [];
      const currentSlug = this._slugFromUrl(postUrl);
      for (const entry of relEntries) {
        const href = entry.link?.find((l) => l.rel === 'alternate')?.href || '';
        const relSlug = this._slugFromUrl(href);
        if (!relSlug || relSlug === currentSlug) continue;
        const relTitle = entry.title?.['$t'] || '';
        const relCover = entry['media$thumbnail']?.url
          ? this._fixCoverUrl(entry['media$thumbnail'].url)
          : null;
        const relLabels = (entry.category || []).map((c) => c.term);
        const relStatus = relLabels.some((l) => l.toLowerCase() === 'ongoing') ? 'ongoing'
          : relLabels.some((l) => l.toLowerCase() === 'completed') ? 'completed'
          : null;
        related.push({ title: relTitle, slug: relSlug, cover: relCover, status: relStatus });
        if (related.length >= 12) break;
      }
    } catch (_) {}

    return {
      source: this.name,
      title,
      cover,
      synopsis,
      status,
      type,
      author: author || null,
      year: year || null,
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
      // Full URL passed directly
      chapterUrl = rawSlug;
    } else {
      // slug + chapter number → find from detail chapters list
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
      html = await getHtml(chapterUrl);
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di Lepoy TL', 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);
    let images = [];

    // Pattern 1: chapterImage = [...]
    const scriptImg = $('script:not([src])').filter((_, el) => $(el).html()?.includes('chapterImage')).first().html() || '';
    if (scriptImg) {
      const m = scriptImg.match(/chapterImage\s*=\s*\[([\s\S]*?)\]/);
      if (m) {
        images = m[1].replace(/\s+/g, '').replace(/"/g, '').split(',').filter(Boolean);
      }
    }

    // Pattern 2: const content = `...`
    if (!images.length) {
      const scriptContent = $('script:not([src])').filter((_, el) => $(el).html()?.includes('const content =')).first().html() || '';
      if (scriptContent) {
        const m = scriptContent.match(/const content\s*=\s*`([\s\S]*?)`\s*;/);
        if (m) {
          const imgMatches = [...m[1].matchAll(/src="([^"]+)"/g)];
          images = imgMatches.map((im) => im[1]);
        }
      }
    }

    // Pattern 3: #readerarea img / .separator img
    if (!images.length) {
      $('#readerarea img, #reader img, article .separator img, .check-box img').each((_, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src) images.push(src);
      });
    }

    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini di Lepoy TL', 'UPSTREAM_ERROR');

    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*Lepoy\s*TL.*$/i, '')
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

module.exports = LepoytlSource;
