# Luvyaa.co Investigation Report

**URL:** https://v5.luvyaa.co/  
**Date:** 2025-11-05  
**Purpose:** Build a manga scraper source for `v5.luvyaa.co`

---

## Summary

`v5.luvyaa.co` is a **custom WordPress theme** named **MangaReader 2.2.2** — NOT Madara, NOT Themesia. It shares structural similarity with Madara-derived themes but uses its own class names and data patterns. The site serves Indonesian-translated manga/manhwa/manhua.

Key findings:
- Theme: `mangareader2.2.2` (custom, not Madara)
- Cards use `.bs > .bsx` structure with `.epxs` for latest chapter
- Manga slugs are at **root level** `/{slug}/` (not `/manga/{slug}/`)
- Chapter images delivered via `ts_reader.run(JSON)` — standard for this theme family
- Search is `/?s=query` (WordPress standard search, no AJAX autocomplete)
- Genre taxonomy at `/genres/{genre-slug}/`
- Pagination uses `?page=N` query param
- Image CDN: `img1.cdn-nyaa.link`

---

## 1. Theme Identification

**Theme:** `mangareader2.2.2` (custom WordPress theme)

**Evidence:**
```
body class: home blog wp-theme-mangareader222 darkmode
Theme assets:
  https://v5.luvyaa.co/wp-content/themes/mangareader2.2.2/assets/js/jquery.min.js
  https://v5.luvyaa.co/wp-content/themes/mangareader2.2.2/assets/js/function.js
  https://v5.luvyaa.co/wp-content/themes/mangareader2.2.2/assets/js/tabs.js
```

None of the Madara indicators (`madara`, `manga-hot`, `wp-manga`, `wooadmin`) appeared in the HTML. No Themesia fingerprints found either. This theme shares the `.bsx`/`.bs` card pattern with Madara-adjacent themes but is structurally distinct.

**robots.txt confirms WordPress:**
```
User-agent: *
Allow: /wp-admin/admin-ajax.php
Sitemap: https://v5.luvyaa.co/wp-sitemap.xml
```

---

## 2. Card Selectors (List Pages)

Observed from `/manga/?order=update` and homepage.

### Container
- **Outer wrapper:** `.bs` (contains one `.bsx` each)
- **Card element:** `.bsx` (51 cards on homepage, 18 on list page)

### Full card HTML structure:
```html
<div class="bs">
  <div class="bsx">
    <a href="https://v5.luvyaa.co/{slug}/" title="{Title}">
      <div class="limit">
        <span class="status Completed">Completed</span>
        <span class="type Manhwa"></span>
        <img src="{cover-url}" class="ts-post-image wp-post-image" />
      </div>
      <div class="bigor">
        <div class="tt">{Title}</div>
        <div class="adds">
          <div class="epxs">Chapter 39</div>
          <div class="rt">
            <div class="rating">
              <div class="rating-prc"><div class="rtp"><div class="rtb"><span style="width:72.8%"></span></div></div></div>
              <div class="numscore">7.28</div>
            </div>
          </div>
        </div>
      </div>
    </a>
  </div>
</div>
```

### Selectors map:

| Field | Selector | Notes |
|-------|----------|-------|
| Card | `.bs` | outer wrapper |
| Link + Slug | `.bsx a[href]` | href = `https://v5.luvyaa.co/{slug}/` |
| Title | `.bsx a[title]` OR `.bsx .tt` | |
| Cover | `.bsx img[src]` | direct `src`, not `data-src` |
| Latest chapter | `.bsx .epxs` | text e.g. `"Chapter 39"` |
| Status | `.bsx .status` | class also contains status value e.g. `class="status Completed"` |
| Type | `.bsx .type` | class also contains type e.g. `class="type Manhwa"` |
| Rating | `.bsx .numscore` | numeric string e.g. `"7.28"` |

**Slug extraction:** Strip `https://v5.luvyaa.co/` and trailing `/` from the href.

---

## 3. Manga Detail Page

**URL pattern:** `https://v5.luvyaa.co/{slug}/`  
**Example:** `https://v5.luvyaa.co/invincible-after-a-hundred-years-of-seclusion/`

**Body class:** `wp-singular manga-template-default single single-manga postid-783321 wp-theme-mangareader222 darkmode`

### Full HTML structure (abbreviated):
```html
<article class="post-783321 hentry" itemscope itemtype="http://schema.org/CreativeWorkSeries">
  <div class="mr-header-wrapper">
    <div class="mr-header">
      <div class="kh-left">
        <div class="thumb">
          <img src="{cover-url}" class="wp-post-image" />
        </div>
      </div>
      <div class="kh-right">
        <h1 class="entry-title" itemprop="name">{Title}</h1>
        <span class="alternative">{Alt titles, comma separated}</span>
        <div class="kh-stats">
          <div class="kh-stat-item rating-score">
            <span>{rating}</span>
            <meta itemprop="ratingValue" content="{rating}">
          </div>
        </div>
        <div class="kh-status">
          <span class="status-dot"></span>
          <span class="status-text">Completed</span>
        </div>
      </div>
    </div>
  </div>
  <div class="main-info">
    <div class="info-desc">
      <div class="entry-content entry-content-single" itemprop="description">
        <p>{Synopsis}</p>
      </div>
      <div class="mr-meta-row">
        <div class="meta-item"><span class="meta-label">Genre</span><div class="meta-tags mgen"><a href="/genres/{slug}/" class="meta-pill">{Genre}</a></div></div>
        <div class="meta-item"><span class="meta-label">Type</span><a href="..." class="meta-pill">{Type}</a></div>
        <div class="meta-item"><span class="meta-label">Released</span><span class="meta-pill">{Year}</span></div>
        <div class="meta-item"><span class="meta-label">Author</span><span class="meta-pill">{Author}</span></div>
        <div class="meta-item"><span class="meta-label">Artist</span><span class="meta-pill">{Artist}</span></div>
      </div>
    </div>
  </div>
</article>
```

### Detail page selectors:

| Field | Selector | Notes |
|-------|----------|-------|
| Title | `h1.entry-title` | |
| Alt Title | `span.alternative` | comma-separated list |
| Cover | `.thumb img` or `.kh-left img` | direct `src` |
| Synopsis | `.entry-content.entry-content-single p` | can be multiple `<p>` tags, join with `\n` |
| Rating | `.kh-stat-item.rating-score span` OR `meta[itemprop="ratingValue"]` attr `content` | |
| Status | `.kh-status .status-text` | text: `"Completed"`, `"Ongoing"`, `"Hiatus"` |
| Genres | `.meta-tags.mgen a.meta-pill` | multiple `<a>` tags |
| Type | `.meta-item:has(.meta-label:contains("Type")) .meta-pill` | text value |
| Year | `.meta-item:has(.meta-label:contains("Released")) .meta-pill` | text value (year only) |
| Author | `.meta-item:has(.meta-label:contains("Author")) .meta-pill` | |
| Artist | `.meta-item:has(.meta-label:contains("Artist")) .meta-pill` | |

**Reliable alternative for meta fields** (simpler to code): iterate over `.meta-item` elements, read `.meta-label` text as the key, `.meta-pill` text as the value.

### Chapter List:

```html
<div id="chapterlist">
  <ul>
    <li>
      <div class="chbox">
        <div class="eph-num">
          <a href="https://v5.luvyaa.co/{manga-slug}-chapter-{num}/">
            <span class="chapternum">Chapter 10</span>
            <span class="chapterdate">05/11/2026</span>
          </a>
        </div>
      </div>
    </li>
  </ul>
</div>
```

| Field | Selector |
|-------|----------|
| Chapter items | `#chapterlist ul li` |
| Chapter URL | `li a[href]` |
| Chapter title/number | `li .chapternum` |
| Chapter date | `li .chapterdate` | format: `DD/MM/YYYY` |

**Date format:** `DD/MM/YYYY` (e.g., `05/11/2026` = 5 November 2026). Parse as day/month/year.

---

## 4. Chapter Reader

**URL pattern:** `https://v5.luvyaa.co/{manga-slug}-chapter-{num}/`  
**Example:** `https://v5.luvyaa.co/invincible-after-a-hundred-years-of-seclusion-chapter-10/`

**Image delivery:** Via `ts_reader.run(JSON)` embedded in `<script>` tag.

### Full ts_reader.run JSON (example):
```json
{
  "post_id": 797438,
  "prevUrl": "https://v5.luvyaa.co/invincible-after-a-hundred-years-of-seclusion-chapter-9/",
  "nextUrl": "",
  "mode": "full",
  "sources": [
    {
      "source": "Server 1",
      "images": [
        "https://img1.cdn-nyaa.link/i/783321C10/01.webp?v=1793882301",
        "https://img1.cdn-nyaa.link/i/783321C10/02.webp?v=1793882301",
        ...
      ]
    }
  ],
  "lazyload": true,
  "defaultSource": "Server 1",
  "lazyloadPlaceHolder": "https://v5.luvyaa.co/wp-content/themes/mangareader2.2.2/assets/img/readerarea.svg",
  "progressBar": false,
  "contentmode": "advanced",
  "protected": false,
  "is_novel": false,
  "unlock_token": null
}
```

**Extraction pattern:**
```javascript
const match = html.match(/ts_reader\.run\((\{[\s\S]+?\})\)/);
const data = JSON.parse(match[1]);
const images = data.sources[0].images; // Array of absolute image URLs
```

**Image CDN:** `img1.cdn-nyaa.link` — images are `.webp` format with `?v=` cache buster.

**Note:** `#readerarea img` is empty when JS is disabled (images loaded by the `ts_reader` script at runtime). The `<noscript>` fallback inside `#readerarea` contains static `<img src>` tags as backup, but `ts_reader.run` JSON is the canonical source.

---

## 5. Search

**Endpoint:** `/?s={query}` (WordPress standard search)  
**Example:** `https://v5.luvyaa.co/?s=solo+leveling`

**Search results page body class:** `search search-results wp-theme-mangareader222 darkmode` (no results: `search search-no-results ...`)

**Results structure:** Same `.bsx` card structure as list pages.

**AJAX search:** `admin-ajax.php` with action `ts_ac_do_search` returns HTTP 400 — not supported/blocked.

---

## 6. Latest Updates

**URL:** `https://v5.luvyaa.co/manga/?order=update`  
**Returns:** 18 cards per page with `.bs > .bsx` cards  
**Pagination:** `?page=N` (e.g., `?order=update&page=2`)

---

## 7. Popular

**URL:** `https://v5.luvyaa.co/manga/?order=popular`  
**Returns:** same `.bsx` card structure  
**Sidebar popular widget:** `.widget_ts_popular_posts` with weekly/monthly/all tabs (uses JS tabs, not separate URLs)

---

## 8. Genres

**Genre taxonomy URL:** `/genres/{genre-slug}/`  
**Example:** `https://v5.luvyaa.co/genres/adult/`

**Genre page body class:** `archive tax-genres term-adult term-50 wp-theme-mangareader222 darkmode`  
(`.bsx` cards present, same structure)

**Genre filter on list pages:** `?genre[]=50&status=&type=manhwa&order=update` (uses ID numbers, not slugs) — avoid this pattern, use `/genres/{slug}/` instead.

**Known genre slugs** (from detail page links):
- `action`, `comedy`, `fantasy`, `martial-arts`, `shounen`, `adult`, `drama`, `josei`, `reverse-harem`, `smut`, `ecchi`, `romance`, `mature`, `horror`, `mystery`, `thriller`, `psychological`, `tragedy`

To get full genre list: scrape the dropdown on `/manga/?order=update` — genre links appear as `<a href="https://v5.luvyaa.co/genres/{slug}/">` in the sidebar.

---

## 9. Pagination

**Pattern:** Append `&page=N` or `?page=N` to any listing URL.

**Pagination HTML:**
```html
<div class="pagination">
  <span class="page-numbers current">1</span>
  <a class="page-numbers" href="/manga/?order=update&page=2">2</a>
  <span class="page-numbers dots">…</span>
  <a class="page-numbers" href="/manga/?order=update&page=355">355</a>
  <a class="next page-numbers" href="...">Next</a>
</div>
```

**Selectors:**
- Current page: `.pagination span.page-numbers.current`
- Max page: `.pagination a.page-numbers:last-of-type` text, or parse from last non-dots `.page-numbers`
- Next page exists: `.pagination a.next.page-numbers` present

---

## 10. AJAX Endpoints

**admin-ajax.php** is present (`https://v5.luvyaa.co/wp-admin/admin-ajax.php`) but:
- `ts_ac_do_search` returns HTTP 400 — disabled/not implemented
- `search_manga` returns HTTP 400

**JS global variable** found in homepage:
```javascript
var mangareader_vars = {
  "ajaxUrl": "https://v5.luvyaa.co/wp-admin/admin-ajax.php",
  "homeUrl": "https://v5.luvyaa.co/",
  "isHome": true,
  "isSeriesPage": false,
  "isChapterPage": false,
  "lastUpdate": "2026-11-05 23:56:10"
};
```

No usable public AJAX endpoints found. All data is server-rendered HTML.

---

## 11. URL / Slug Patterns

| Page type | URL pattern |
|-----------|-------------|
| Homepage | `https://v5.luvyaa.co/` |
| Latest | `https://v5.luvyaa.co/manga/?order=update&page={n}` |
| Popular | `https://v5.luvyaa.co/manga/?order=popular&page={n}` |
| Search | `https://v5.luvyaa.co/?s={query}&page={n}` |
| Manga detail | `https://v5.luvyaa.co/{slug}/` |
| Genre listing | `https://v5.luvyaa.co/genres/{genre-slug}/&page={n}` |
| Chapter reader | `https://v5.luvyaa.co/{manga-slug}-chapter-{num}/` |

> **Important:** Manga detail slugs are at the **root path** (`/{slug}/`), not under `/manga/`. A slug like `invincible-after-a-hundred-years-of-seclusion` becomes `https://v5.luvyaa.co/invincible-after-a-hundred-years-of-seclusion/`.

---

## Implementation Recommendations

### Source class: `LuvyaaSource`

1. **HTML scraping only** — no REST API available. Use `getHtml()` + `cheerio`.

2. **Card parsing** (for `getLatest`, `getPopular`, `search`, `getByGenre`):
   ```javascript
   const cards = [];
   $('.bs').each((_, el) => {
     const a = $(el).find('.bsx a');
     const href = a.attr('href'); // full URL
     const slug = href.replace('https://v5.luvyaa.co/', '').replace(/\/$/, '');
     const title = a.attr('title') || $(el).find('.tt').text().trim();
     const cover = $(el).find('img').attr('src');
     const latestChapter = $(el).find('.epxs').text().trim();
     const status = $(el).find('.status').text().trim();
     const type = $(el).find('.type').text().trim() || $(el).find('.type').attr('class').replace('type ', '').trim();
     const rating = parseFloat($(el).find('.numscore').text().trim()) || null;
     cards.push({ slug, title, cover, latestChapter, status, type, rating });
   });
   ```

3. **Detail parsing** (for `getDetails`):
   ```javascript
   const title = $('h1.entry-title').text().trim();
   const altTitle = $('span.alternative').text().trim() || null;
   const cover = $('.thumb img, .kh-left img').first().attr('src');
   const synopsis = $('.entry-content.entry-content-single').text().trim();
   const status = $('.kh-status .status-text').text().trim().toLowerCase();
   const rating = parseFloat($('meta[itemprop="ratingValue"]').attr('content')) || null;
   
   const genres = [];
   $('.meta-tags.mgen a.meta-pill').each((_, el) => genres.push({ name: $(el).text().trim(), slug: $(el).attr('href').split('/genres/')[1].replace('/', '') }));
   
   let type, year, author, artist;
   $('.meta-item').each((_, el) => {
     const label = $(el).find('.meta-label').text().trim();
     const value = $(el).find('.meta-pill').text().trim();
     if (label === 'Type') type = value;
     else if (label === 'Released') year = value;
     else if (label === 'Author') author = value;
     else if (label === 'Artist') artist = value;
   });
   
   const chapters = [];
   $('#chapterlist ul li').each((_, el) => {
     const a = $(el).find('a');
     const url = a.attr('href');
     // extract chapter num from URL: ...chapter-{num}/
     const numMatch = url.match(/chapter-(\d+(?:\.\d+)?)\/$/);
     const chapterNum = numMatch ? numMatch[1] : null;
     const title = $(el).find('.chapternum').text().trim();
     const dateRaw = $(el).find('.chapterdate').text().trim(); // DD/MM/YYYY
     chapters.push({ slug: chapterNum, title, date: dateRaw, url });
   });
   ```

4. **Chapter reader** (for `getPages`):
   ```javascript
   const match = html.match(/ts_reader\.run\((\{[\s\S]+?\})\)/);
   const data = JSON.parse(match[1]);
   const images = data.sources[0]?.images || [];
   ```

5. **Date parsing** for chapter dates: Format is `DD/MM/YYYY`.
   ```javascript
   function parseChapterDate(raw) {
     const [day, month, year] = raw.split('/');
     return new Date(year, month - 1, day);
   }
   ```

6. **Pagination**: Extract from `.pagination a.page-numbers` to find total pages, check `.pagination a.next` for hasNextPage.

7. **Request headers**: Include `Referer: https://v5.luvyaa.co/` and a browser `User-Agent` for image requests (CDN may check referer).

---

## Existing Similar Sources to Reference

- `src/sources/apkomik/ApkomikSource.js` — HTML scraper, similar Madara-adjacent theme
- `src/sources/ikiru/` — HTML scraper with chapter date parsing
- `src/sources/westmanga/` — likely similar structure

The `ShinigamiSource.js` pattern (API-based) is NOT the right template — use a cheerio HTML scraper pattern instead.
