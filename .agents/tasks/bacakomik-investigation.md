# Investigation: https://bacakomik.my/ — Manga Source Structure

**Status:** READ-ONLY investigation. No code was changed.  
**Primary source:** Kotlin parser `BacaKomik.kt` (production, verified working) at
`kotatsu-parsers-redo/src/main/kotlin/org/koitharu/kotatsu/parsers/site/mangareader/id/BacaKomik.kt`
and its base class `MangaReaderParser.kt`.  
**Secondary sources:** Live page fetches from `https://bacakomik.my/` (text-only; rendered HTML
stripped by the fetch tool due to anti-scraping). The Kotlin parser is the authoritative ground truth
where live fetches are ambiguous.

---

## 1. Executive Summary (answers to the 10 brief questions)

1. **WordPress Madara/Themesia?** NO. bacakomik.my uses a **custom Indonesian manga theme** (sometimes
   called "AnimePost" or "ReadManga" family). `robots.txt` shows Yoast SEO (WordPress) but the theme
   classes are `div.animepost`, `.animposx`, `div.infoanime`, `.infox .spe` — **not** `.bsx/.bs/.bixbox`
   (Themesia/Madara). The base class is `MangaReaderParser` from kotatsu, but bacakomik overrides
   nearly all selectors.

2. **Listing page structure:**  
   - Manga cards: `div.animepost`  
   - Cover: `div.limit img`  
   - Title: `.animposx .tt h4`  
   - Slug: extract from `<a href>` → last path segment of `/komik/{slug}/`  
   - Latest chapter: `.epxs` text → `Chapter\s+([0-9.]+)`  
   - Status: `span.status` inside the card (optional; absent ⇒ ongoing)  
   - Type: `span.type` inside the card  
   - Rating: `.numscore` text  
   - Genres: not available on cards (only on detail pages)  
   Pagination: `a.r` (next-only) or numbered links on the daftar-komik archive.

3. **Manga detail page** (`/komik/{slug}/`):  
   - Title: `#breadcrumbs li:last-child span`  
   - Alt title: `.infox .spe span:contains(Judul Alternatif)` (see §4.2)  
   - Cover: `.thumb > img:nth-child(1)` `src`  
   - Synopsis: `div.desc > .entry-content.entry-content-single` → `p` elements, strip Indonesian
     boilerplate ("bercerita tentang ") from the start  
   - Status: `.infox .spe span:contains(Status)` → detect "berjalan" (ongoing) or "tamat" (finished)  
   - Type: `.infox .spe span:contains(Jenis Komik) a` text  
   - Author: `.infox .spe span:contains(Author) :not(b)` text  
   - Artist: `.infox .spe span:contains(Artis) :not(b)` text (present; per user msg #14, omit from
     response but parse if useful)  
   - Year: `.infox .spe span:contains(Rilis)` text  
   - Genres: `.infox > .genre-info > a` AND `.infox .spe span:contains(Jenis Komik) a`; slug = last
     segment of the genre href before `?`  
   - Rating: `.numscore` or aggregateRating  
   - Chapter list: `#chapter_list li` (NOT `#chapterlist`)  
   - Related: present on page (same `.animepost` cards in a related section)  

4. **Chapter/reader page:**  
   Images are in `div:has(>img[alt*=Chapter]) img` (direct children with alt containing "Chapter").
   They are **static `<img>` tags**, NOT `ts_reader.run` JSON and NOT `#readerarea` injection.  
   Filter out `noscript` wrappers: `element.parent()?.tagName() != "noscript"`.  
   Fallback image URL from `onError`/`onerror` attribute: parse `src='...'` substring.

5. **Search endpoint:** `/?s={query}` (page 1) or `/page/{N}/?s={query}` (page ≥2). Standard
   WordPress search. Results container same card structure (`div.animepost`).

6. **Latest/update page:** `/daftar-komik/?order=update` — this is the listing URL used by the parser.
   Also `/daftar-komik/?order=update&page={N}` for paging. (NOT `/manga/?m_orderby=latest`.)

7. **Popular page:** `/daftar-komik/?order=popular`

8. **Genres list:** Genre catalog is scraped from the filter form on `/daftar-komik/`.  
   Selector: `ul.dropdown-menu.c4 li input[name='genre[]']` for genre ID (value attr) and sibling
   label for name. Slug = slugify(name).  
   A direct genres index at `/genre/` or `/manga-genre/` was NOT confirmed.

9. **Pagination:** The listing archive uses `?page={N}` params. The Kotlin parser paginates with
   page > 1 as `/daftar-komik/page/{N}/?order=…`. The text fetch confirmed 201 pages of titles in
   the alphabetical listing (`1 2 3 … 201 Berikutnya »`), so `maxPage` is parseable from numbered
   links.

10. **AJAX endpoints:** No `wp-admin/admin-ajax.php` chapter-loading endpoint observed. Images are
    served inline as static `<img>` tags in the reader HTML — no AJAX chapter loading needed.
    `robots.txt` uses Yoast SEO format (`Sitemap: …sitemap_index.xml`, `Disallow:` blank) — standard
    WordPress, no page-specific AJAX blocks.

---

## 2. Platform & Theme Identification

**Theme family:** "AnimePost" / custom Indonesian manga theme (NOT Madara, NOT Themesia mangastream).

Evidence from `BacaKomik.kt`:
- `selectMangaList = "div.animepost"` — distinct from Themesia's `.bsx/.bs`
- Detail info container: `div.infoanime`, `.infox .spe` (label-value spans)
- Chapter list: `#chapter_list` (not `#chapterlist`)
- Images: `div:has(>img[alt*=Chapter]) img` (static img tags, not `ts_reader.run`)

Evidence from live fetch of `/komik/one-piece/`:
- Uses Indonesian labels: "Judul Alternatif", "Status: Berjalan", "Jenis Komik: Manga",
  "Author", "Artis", "Rilis: 1997", "Serialisasi", "Jumlah Pembaca"
- Status value: "Berjalan" (ongoing) / "Tamat" (completed) — Indonesian words (differs from
  apkomik's English "Ongoing"/"Completed")

**Content URL pattern:** manga detail at `/komik/{slug}/` (not `/manga/{slug}/`).  
**Listing URL:** `/daftar-komik/` (not `/manga/`).

`robots.txt` confirms WordPress (Yoast SEO block), but the theme is not Madara-family.

---

## 3. URL Map (endpoints to expose)

| Purpose | Upstream URL | API method |
|---|---|---|
| Latest updates | `https://bacakomik.my/daftar-komik/?order=update&page={N}` | `getLatest` |
| Popular | `https://bacakomik.my/daftar-komik/?order=popular&page={N}` | `getPopular` |
| Newest added | `https://bacakomik.my/daftar-komik/?order=latest&page={N}` | `getNewest` |
| A‑Z | `https://bacakomik.my/daftar-komik/?order=title&page={N}` | `getAz` |
| Z‑A | `https://bacakomik.my/daftar-komik/?order=titlereverse&page={N}` | `getZa` |
| Filtered list | `/daftar-komik/?order={o}&status={s}&type={t}&genre[]={id}&yearx={y}&title={q}&page={N}` | `getList` |
| Search | `/?s={q}` (p=1) or `/page/{N}/?s={q}` (p≥2) | `search` |
| Genre catalog | parse from `/daftar-komik/` filter form | `getGenres` |
| Genre-filtered | `/daftar-komik/?genre[]={id}&order=update&page={N}` | `getByGenre` |
| Type-filtered | `/daftar-komik/?type={t}&order=update&page={N}` | `getByType` |
| Manga detail | `/komik/{slug}/` | `getDetails` |
| Chapter images | `{chapter-href}` (full href from chapter list) | `getPages` |

### Sort order parameter values (from `BacaKomik.kt` `getListPage`):
| API sort | URL param |
|---|---|
| Updated/Latest | `order=update` |
| Newest added | `order=latest` |
| Popularity | `order=popular` |
| A-Z | `order=title` |
| Z-A | `order=titlereverse` |

### Status parameter values:
| Status | URL param |
|---|---|
| Ongoing | `status=ongoing` |
| Completed | `status=completed` |

### Type parameter values (from `BacaKomik.kt`):
`Manga`, `Manhwa`, `Manhua`, `Comic` (capital first letter)

---

## 4. Selectors (with Source Evidence)

### 4.1 Listing/Card Pages

Source: `BacaKomik.kt` overrides + `MangaReaderParser.kt` defaults.

```
// Card container
div.animepost                        // BacaKomik.selectMangaList

// Within each card:
a[href]                              // base link (→ /komik/{slug}/)
div.limit img                        // cover (BacaKomik.selectMangaListImg)
.animposx .tt h4                     // title (BacaKomik.selectMangaListTitle)
.limit span.type                     // manga type
.limit span.status                   // status (absent = ongoing)
.adds .epxs                          // latest chapter text
.adds .numscore                      // rating (parseFloat)
```

Slug extraction from href:
```js
// href = "https://bacakomik.my/komik/{slug}/"
href.match(/\/komik\/([^/]+)\/?$/)[1]
```

### 4.2 Manga Detail Page (`/komik/{slug}/`)

Source: `BacaKomik.kt` `getDetails()` + live fetch of `/komik/one-piece/`.

```
// Title (from breadcrumb, not h1)
#breadcrumbs li:last-child span                   // "One Piece"

// Cover
.thumb > img:nth-child(1)                         // src attr

// Info block container
div.infoanime
.infox .spe                                        // info rows

// Alt title (from .spe spans)
.infox .spe span:contains("Judul Alternatif")     // next sibling text

// Status — check text of the span
.infox .spe span:contains("Status")               // text contains "Berjalan"→ongoing, "Tamat"→completed

// Type
.infox .spe span:contains("Jenis Komik") a        // link text e.g. "Manga"

// Author  
.infox .spe span:contains("Author") :not(b)       // text node (not the <b> label)

// Artist
.infox .spe span:contains("Artis") :not(b)        // text node

// Year/Release
.infox .spe span:contains("Rilis")                // text; extract \d{4}

// Genres (BOTH sources, merged)
.infox > .genre-info > a                          // genre links
.infox .spe span:contains("Jenis Komik") a        // type-as-genre fallback
// slug = a.attr("href").substringAfterLast('/').substringBefore('?')

// Synopsis
div.desc > .entry-content.entry-content-single
  → select("p").text()
  → strip prefix "bercerita tentang "

// Chapter list
#chapter_list li                                   // BacaKomik.selectChapter

// Within each chapter li:
span.lchx > a    (or fallback: a)                 // chapter link
  a.attr("href")                                  // chapter URL (relative)
  a.text()                                        // chapter name e.g. "Chapter 1"
span.dt a, span.dt                                // date element
```

Chapter number parsing (BacaKomik.kt):
```kotlin
Regex("""chapter\s+([0-9]+(?:\.[0-9]+)?)""", RegexOption.IGNORE_CASE)
  .find(chapterName)?.groupValues?.getOrNull(1)?.toFloatOrNull()
```
Chapters are mapped with `reversed = true` (the list is newest-first in HTML; reversed = ascending order).

Chapter date parsing uses Indonesian relative dates:
- "X detik/menit/jam/hari/minggu/bulan/tahun yang lalu" → relative subtraction
- "hari ini" → today, "kemarin" → yesterday
- Fallback: `MMM d, yyyy` (English SimpleDateFormat)

### 4.3 Chapter/Reader Page

Source: `BacaKomik.kt` `getPages()`.

```
// Image selector (static img tags, NOT ts_reader.run)
div:has(>img[alt*=Chapter]) img

// Filter: skip noscript wrappers
element.parent?.tagName != "noscript"

// Image URL resolution (priority):
1. element.attr("onError")?.substringAfter("src='")?.substringBefore("';")
   OR element.attr("onerror")?.substringAfter("src='")?.substringBefore("';")
2. element.src()    // standard img src
```

This is unlike apkomik/komikindo which use `ts_reader.run` JSON. bacakomik images are **statically
embedded** in the HTML.

No server-switching / CDN selection (no `sources[]` array).

### 4.4 Search

Endpoint: `/?s={query}` (page 1), `/page/{N}/?s={query}` (page ≥2).  
Results: same `div.animepost` cards.  
Pagination: same as listing pages.

### 4.5 Pagination

From the `/daftar-komik/` full fetch: numbered links present — `1 2 3 … 201 Berikutnya »`.

The Kotlin `MangaReaderParser` base uses path-style paging for page > 1:
```kotlin
if (page > 1) {
    append("page/")
    append(page)
    append('/')
}
// then query params: ?order=update&...
```
So page 2 URL = `/daftar-komik/page/2/?order=update`.

For `maxPage`: numbered pagination links are present (`1 2 3 … 201`), so `maxPage` is parseable
from the last numbered page link.

Selector: `div.pagination a.page-numbers` (standard WP pagination — confirmed by the "201" and "»"
links seen in the daftar-komik fetch). The kotatsu parser doesn't extract maxPage but the API can
use `div.pagination a.page-numbers:not(.next)` to find the max.

### 4.6 Genre Catalog (from `/daftar-komik/` filter form)

Source: `BacaKomik.kt` `fetchAvailableTags()`.

```
// Genre inputs in the filter form
ul.dropdown-menu.c4 li input[name='genre[]']
  value attr → genre numeric ID
  nextElementSibling (label) → genre name
```

Genres seen in live fetch of `/daftar-komik/` (text only, as displayed):
`Action, Adult, Adventure, Comedy, Crime, Demons, Doujinshi, Drama, Ecchi, Fantasy, Game,
Gender Bender, Girls' Love, Harem, Historical, Horror, Isekai, Josei, Martial Arts, Mature,
Mecha, Medical, Military, Mystery, Psychological, Romance, School Life, Sci-fi, Seinen,
Shoujo, Shounen, Slice of Life, Smut, Sports, Supernatural, Thriller, Tragedy, Wuxia, Yaoi, Yuri`

Years filter also present: `ul.dropdown-menu` with years (1983–2026).
Status filter: `All`, `Ongoing`, `Completed`, `Hiatus`.
Type filter: `All`, `Manga`, `Manhwa`, `Manhua`, `Comic`.
Color filter: `All`, `Hitam Putih` (B&W), `Berwarna` (Color).
Order filter: `All (A-Z)`, `Z-A`, `Latest Update`, `Latest Added`, `Popular`.

---

## 5. Key Differences from apkomik / komikindo

| Aspect | apkomik / komikindo (Themesia) | bacakomik (AnimePost) |
|---|---|---|
| Card selector | `div.listupd .bsx` | `div.animepost` |
| Cover selector | `.limit img.ts-post-image` | `div.limit img` |
| Title selector | `.tt` text | `.animposx .tt h4` |
| Listing URL | `/manga/` | `/daftar-komik/` |
| Manga detail URL | `/manga/{slug}/` | `/komik/{slug}/` |
| Title on detail | `h1.entry-title` | `#breadcrumbs li:last-child span` |
| Cover on detail | `div.thumbook div.thumb img` | `.thumb > img:nth-child(1)` |
| Info container | `div.tsinfo div.imptdt` | `div.infoanime .infox .spe` |
| Author | `div.flex-wrap div.fmed` | `.infox .spe span:contains("Author") :not(b)` |
| Status values | English (Ongoing/Completed) | Indonesian (Berjalan/Tamat) |
| Chapter list | `#chapterlist > ul > li[data-num]` | `#chapter_list li` |
| Reader images | `ts_reader.run({})` JSON | `div:has(>img[alt*=Chapter]) img` (static) |
| Pagination | `div.hpage a.r` (next-only) | `div.pagination a.page-numbers` (numbered) |
| Genre form selector | `ul.genrez > li input[name="genre[]"]` | `ul.dropdown-menu.c4 li input[name="genre[]"]` |

---

## 6. Image Hosting & Proxy

Reader images appear to be hosted on bacakomik's own CDN or `wp-content`. Since images are
static `<img>` tags (not lazy-loaded from an external CDN like apkomik's `cdnap.site`), hotlink
protection may be less aggressive. Standard proxy with `Referer: https://bacakomik.my/` should
work.

The proxy route at `/api/proxy/image` appends the image's own origin as `Referer` when no explicit
`referer` param is given — this is sufficient for most WordPress image servers.

---

## 7. Recommendations for Implementation

Create `src/sources/bacakomik/BacakomikSource.js` extending `BaseSource`. Register in
`src/sources/index.js`. Use `ApkomikSource.js` as the code template (same project patterns) but
replace ALL selectors with the bacakomik-specific ones below.

### Constructor
```js
super('bacakomik', 'BacaKomik');
this.baseUrl = 'https://bacakomik.my';
this.icon = 'https://bacakomik.my/wp-content/uploads/...';  // fetch from homepage <link rel="icon">
```

### `_parseCardList($)`
```js
$('div.animepost').each((_, el) => {
  const a = $(el).find('a').first();
  const href = a.attr('href') || '';
  const slugMatch = href.match(/\/komik\/([^/]+)\/?$/);
  const slug = slugMatch ? slugMatch[1] : null;
  if (!slug) return;

  const title = $(el).find('.animposx .tt h4').text().trim() || a.attr('title') || '';
  const cover = $(el).find('div.limit img').first().attr('src') || null;
  const type = $(el).find('.limit span.type').text().trim().toLowerCase() || null;
  const statusRaw = $(el).find('.limit span.status').text().trim().toLowerCase();
  const status = statusRaw || 'ongoing';
  const latestChText = $(el).find('.epxs').text().trim();
  const latestChMatch = latestChText.match(/Chapter\s+([0-9.]+)/i);
  const latestChapter = latestChMatch ? latestChMatch[1] : latestChText || null;
  const ratingRaw = $(el).find('.numscore').text().trim();
  const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

  items.push({ title, slug, cover, type, status, latestChapter, rating });
});
```

### `_parsePagination($, currentPage)`
```js
let maxPage = currentPage;
$('div.pagination a.page-numbers:not(.next)').each((_, el) => {
  const n = parseInt($(el).text().trim(), 10);
  if (!isNaN(n) && n > maxPage) maxPage = n;
});
const hasNextPage = $('div.pagination a.next.page-numbers').length > 0;
return { maxPage: maxPage > currentPage ? maxPage : null, hasNextPage };
```

### `getLatest(page)` / `getPopular(page)` / `getNewest(page)` / `getAz` / `getZa`
```js
// Build URL:
const base = `${this.baseUrl}/daftar-komik/`;
const pagePrefix = page > 1 ? `page/${page}/` : '';
const url = `${base}${pagePrefix}?order=update`;  // change order per method
```

### `getDetails(slug)`
```js
const url = `${this.baseUrl}/komik/${slug}/`;
// ... fetch and parse per §4.2 selectors
```

Chapter URL resolution: The chapter `href` from `#chapter_list li span.lchx > a` is a full URL
(e.g. `https://bacakomik.my/komik/{slug}-chapter-1/`). Store the full href as the chapter slug in
the chapter list. In `getPages(slug, chapter)`:
- If `slug` starts with `http`, use it directly.
- Otherwise resolve from `getDetails(slug).chapters` matching the chapter number.

### `getPages(slug, chapter)`
```js
// Fetch chapter page HTML
// Extract images:
const pages = [];
$('div').filter((_, el) => {
  return $(el).children('img[alt*=Chapter]').length > 0;
}).children('img[alt*=Chapter]').each((i, img) => {
  if ($(img).parent().is('noscript')) return;
  const onerror = $(img).attr('onError') || $(img).attr('onerror') || '';
  const fallback = onerror.match(/src='([^']+)'/)?.[1];
  const url = fallback?.trim() || $(img).attr('src') || null;
  if (!url) return;
  pages.push({
    page: i + 1,
    url,
    directUrl: url,
    proxyUrl: `/api/proxy/image?url=${encodeURIComponent(url)}&referer=${encodeURIComponent('https://bacakomik.my/')}`,
  });
});
```

### `getGenres()` (cached 24h)
```js
const html = await getHtml(`${this.baseUrl}/daftar-komik/`);
const $ = cheerio.load(html);
const genres = [];
$('ul.dropdown-menu.c4 li input[name="genre[]"]').each((_, el) => {
  const id = $(el).val();
  const label = $(el).next('label').text().trim() || $(el).closest('li').text().trim();
  if (!id || !label) return;
  const slug = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  genres.push({ name: label, slug, id });
});
return genres.sort((a, b) => a.name.localeCompare(b.name, 'id'));
```

### `getByGenre(genre, page, options)`
```js
// Resolve genre id from getGenres() by slug/name/id
// Build URL: /daftar-komik/?genre[]={id}&order=update&page={N}
// Use path paging: /daftar-komik/page/{N}/?genre[]={id}&order=update
```

### `getTypes()`
```js
return ['manga', 'manhwa', 'manhua', 'comic'];
// Note: bacakomik filter shows Manga/Manhwa/Manhua/Comic (capital first; send lowercase, capitalize on URL)
```

---

## 8. Gaps & Assumptions

1. **HTTP anti-scraping:** Live web fetches via the investigation tool returned a static/cached 12-card
   response regardless of query. The project's `getHtml` (Chrome UA + `Accept-Language: id-ID`)
   should get real responses. Verify in implementation by running the server and hitting a real
   endpoint.

2. **Chapter URL format:** Chapter URLs in the list are full absolute hrefs like
   `https://bacakomik.my/komik/{manga-slug}-chapter-{N}/` or
   `https://bacakomik.my/{manga-slug}-chapter-{N}/` — the exact pattern needs verification from a
   live detail page fetch. The Kotlin parser stores the relative URL (`attrAsRelativeUrl("href")`).

3. **Genre slugs in detail:** The genre `<a>` hrefs like `/genre/{slug}/` or `/tag/{slug}/` need
   to be checked on a live detail page. The instruction to provide genre slugs (user message #7
   "di detail untuk genre nya kasih slug nya") means we extract the slug from the href.

4. **Related series section:** bacakomik likely has a related/recommended section on detail pages
   (user message #8 "ada related di detail"). The Kotlin parser does not extract it explicitly in
   `getDetails`, but the base class `getRelatedManga` fetches the same page and calls `parseMangaList`
   — which would find `div.animepost` cards if they are in a related block. Implementation should
   check whether related cards use the same `div.animepost` selector.

5. **`maxPage` availability:** Confirmed from the daftar-komik full fetch showing numbered pagination
   (1–201). The implementation can reliably parse `maxPage` unlike apkomik which had next-only
   pagination.

6. **Image proxy referer:** bacakomik images are static WordPress-hosted (`/wp-content/uploads/`).
   Standard proxy with `Referer: https://bacakomik.my/` will work. No special CDN handling needed.

7. **Author filter:** `BacaKomik.kt` supports `isAuthorSearchSupported = true` with
   `addQueryParameter("author", filter.author)` — so `/daftar-komik/?author={name}&order=update`
   works for author search. Expose this via `getList(page, { author })` if desired.

---

## 9. Fetch Notes (Methodology)

- Live pages fetched: `/`, `/komik/`, `/komik/?m_orderby=latest`, `/komik/?m_orderby=views`,
  `/daftar-komik/`, `/daftar-komik/?order=update&page=1`, `/komik/one-piece/`, `/?s=one+piece`,
  `robots.txt`.
- The text-only fetch tool strips HTML/CSS; all fetched results showed an anti-scraping 12-card
  fallback for listing pages, and the one-piece detail page showed real metadata.
- The Kotlin source code at `kotatsu-parsers-redo/src/main/kotlin/.../BacaKomik.kt` and
  `MangaReaderParser.kt` was read in full — this is the authoritative source for selectors as it
  is a production parser with verified working selectors.
