# Komikindo Source Investigation Report

Site: `https://2.komikindo.shop/`
Investigator: planning/inspection step (read-only HTTP fetches via PowerShell `Invoke-WebRequest`).
All evidence below was taken from live raw HTML fetched on 2026-10-31.

---

## 1. Summary (TL;DR)

- **Stack:** WordPress + the **Themesia "mangareader"** manga theme (theme folder `wp-content/themes/mangareader/`; cache comments say `themesia cache`). It is **not** the Madara theme — selectors are Themesia-specific.
- **Scraping model: purely HTML with cheerio** — with **one exception**: the **chapter reader images are embedded as a JSON blob inside an inline `<script>`** that calls `ts_reader.run({...})`. They are NOT in the `#readerarea` div (that div is empty and filled at runtime by JS). Extract the JSON with a regex + `JSON.parse`, read `sources[0].images`. No headless browser or XHR call is required.
- **No JSON REST/XHR API is needed.** `admin-ajax.php` is used only for the view-counter (`dynamic_view_ajax`) and live-search autocomplete — neither is required for scraping.
- **Key gotchas:**
  1. The homepage "latest update" cards link to the **chapter page**, not the manga detail page. Use `/manga/?order=update` (and `/manga/`, `/genres/<slug>/`) for cards that link to **detail pages**.
  2. Chapter URLs are at the **site root**, not under `/manga/`: `https://2.komikindo.shop/<manga-slug>-chapter-<NUM>/`. Don't construct them — follow the `href` from the detail-page chapter list.
  3. The info table rows **vary per manga** (Artist present for manhwa, "Released"/year optional, Serialization optional). Parse by **label**, not by fixed row index.
  4. **No alt-title field exists** anywhere on the site (confirmed: 0 occurrences of subtitle/Alternative/alt-title).
  5. **`Artist` is NOT always present**; map it only when the "Artist" row exists.
  6. "Released" holds the year but data quality varies (one sample was garbage `Paodies`); it is often missing entirely.
  7. Cover images are served through WordPress Photon/Jetpack CDN (`i0.wp.com/...`) or external storage (`linksaya.com`, `cdn.linksaya.com`, `img7.linksaya.com`) with `?resize=W,H`. Strip the `?resize=...` query for the full-resolution image.
- **Recommended source endpoints for the scraper:**
  - Latest updates → `GET /manga/?order=update&page=N` (detail-page links; ~20/page; ~496 pages)
  - Popular → `GET /manga/?order=popular&page=N`
  - A–Z / browse → `GET /manga/?page=N` (default alphabetical-ish archive) — or `?order=title`
  - By genre → `GET /genres/<genre-slug>/page/N/` (~10/page) — or `GET /manga/?genre[]=ID&page=N` using term IDs from the filter form
  - Search → `GET /?s=<query>&page=N` (via `/page/N/?s=<query>`); ~10 results/page
  - Manga detail → `GET /manga/<slug>/`
  - Chapter pages → `GET <chapter-href>` then extract `ts_reader.run(...)` JSON
  - All manga enumeration (fallback) → `GET /manga-sitemap.xml`

---

## 2. URL / endpoint map

| Purpose | URL | Pagination | Notes |
|---|---|---|---|
| Manga detail | `/manga/<slug>/` | n/a | canonical source of metadata + chapter list |
| Chapter / reader | `/<slug>-chapter-<NUM>/` | n/a | root path; images in inline `ts_reader.run()` JSON |
| Manga archive (browse) | `/manga/` | `?page=N` and `/manga/page/N/` both work | ~20/page, 496 pages; supports `order`, `type`, `status`, `genre[]` |
| Latest updates | `/manga/?order=update` | `&page=N` | links to detail pages |
| Popular | `/manga/?order=popular` | `&page=N` | links to detail pages |
| By title (A–Z) | `/manga/?order=title` | `&page=N` | optional `&type=manga|manhwa|manhua` |
| Search | `/?s=<query>` | `/page/N/?s=<query>` | ~10/page |
| Homepage (latest by category) | `/page/N/` | `/page/N/` | multi-section; cards link to chapter pages |
| Genre archive | `/genres/<slug>/` | `/genres/<slug>/page/N/` | ~10/page |
| Genre index (all genres) | `/genres/` | n/a | A–Z list, 449 genre links |
| "Project" (featured grid) | `/project/` | `/project/page/N/` | ~20/page, 29 pages |
| Sitemap index | `/sitemap.xml` (also `/sitemap_index.xml`, `/wp-sitemap.xml`) | n/a | Yoast index → `post-sitemap*.xml`, etc. |
| Manga sitemap | `/manga-sitemap.xml` | n/a | lists every `/manga/<slug>/` + cover image |
| robots.txt | `/robots.txt` | n/a | allows Googlebot/Bingbot/DuckDuckBot; blocks SEO bots; allows all except `/wp-admin/`, `/wp-include/` for `*` |

---

## 3. Q1 — Homepage structure & selectors

The homepage (`/`) is a multi-section landing page. Raw HTML fetched = 220 KB. It contains **5 `.listupd` grids** plus 1 `.listupd.popularslider`:

Section headers (from `<div class="releases"><h2>…</h2>`):
- **Popular Today** (renders as the `listupd popularslider` slider)
- **Project Update** → "View All" = `/project/`
- **Latest Update** → "View All" = `/manga/?order=update`
- **Manhwa Terbaru** → "View All" = `https://komikindo4.link/genres/manwha` (note: points to an external mirror domain, avoid)
- **Manhua Terbaru** → "View All" = `https://komikindo4.link/manga/?order=title&type=manhua` (external mirror)
- **Recommendation**

### Homepage "Latest Update" card (links to the CHAPTER page)

```html
<div class="listupd">
  <div class="bs styletere stylefor">
    <div class="bsx">
      <a href="https://2.komikindo.shop/secret-class-chapter-322/" title="Secret Class Chapter 322">
        <div class="limit">
          <div class="ply"></div>
          <span class="typename Manhwa">Manhwa</span>
          <span class="colored"><i class="fas fa-palette"></i> Color</span>
          <span class="hotx"><i class="fab fa-hotjar"></i></span>
          <img src="https://i3.wp.com/.../cover.jpg?resize=285,425" class="ts-post-image wp-post-image attachment-full size-full" loading="lazy" title="Secret Class Chapter 322" alt="Secret Class Chapter 322"/>
        </div>
        <div class="bigor">
          <div class="tt">Secret Class</div>
          <div class="epxdate">1 day ago</div>
          <div class="adds"><div class="epxs">Chapter 322</div></div>
        </div>
      </a>
    </div>
  </div>
  ...
</div>
```

**Homepage card selectors** (note: `a[href]` → chapter URL, not detail):

| Field | Selector | Notes |
|---|---|---|
| list container | `div.listupd` | one per section |
| card | `div.bs > div.bsx` (home also uses `div.bs.styletere.stylefor`) | |
| link/title-attr | `.bsx > a[href][title]` | `href` = **chapter** page; `title` = "Manga Chapter N" |
| cover | `.bsx .limit img.ts-post-image` | `src` via Photon CDN; strip `?resize=` for full size |
| type | `.bsx .limit span.typename` | text = Manga/Manhua/Manhwa/Comic (class also encodes it, e.g. `typename Manhwa`) |
| color badge | `.bsx .limit span.colored` | optional ("Color") |
| hot badge | `.bsx .limit span.hotx` | optional |
| title (clean) | `.bsx .bigor .tt` | manga name without "Chapter N" |
| relative time | `.bsx .bigor .epxdate` | e.g. "1 day ago" — only on homepage sections |
| latest chapter | `.bsx .bigor .adds .epxs` | e.g. "Chapter 322" |
| status | — | **not present** on homepage cards |
| genres | — | **not present** on homepage cards |

To get the **manga slug** from a homepage card's chapter URL, strip the `-chapter-<NUM>` suffix:
`https://2.komikindo.shop/<slug>-chapter-<NUM>/` → slug. (Prefer using `/manga/?order=update` cards instead — they already link to detail pages.)

### Search bar (homepage + every page)

```html
<form action="https://2.komikindo.shop/" id="form" method="get" itemprop="potentialAction" itemscope itemtype="http://schema.org/SearchAction">
  <meta itemprop="target" content="https://2.komikindo.shop/?s={query}"/>
  <input id="s" name="s" class="search-live" type="text" placeholder="Search"/>
  ...
</form>
```
→ Search endpoint = `GET /?s=<query>`.

### Popular sidebar widget (on listing pages)

```html
<div class="ts-wpop-series-gen">
  <ul class="ts-wpop-nav-tabs">
    <li class="active"><span class="ts-wpop-tab" data-range="weekly">Weekly</span></li>
    <li><span class="ts-wpop-tab" data-range="monthly">Monthly</span></li>
    <li><span class="ts-wpop-tab" data-range="alltime">All</span></li>
  </ul>
</div>
<div id="wpop-items">
  <div class="serieslist pop wpop wpop-weekly"><ul>
    <li>
      <div class="ctr">1</div>
      <div class="imgseries"><a class="series" href="https://2.komikindo.shop/manga/secret-class/" rel="92"><img .../></a></div>
      <div class="leftseries"><h2><a class="series" href="https://2.komikindo.shop/manga/secret-class/" ...>Secret Class</a></h2></div>
    </li>
```
This is the "popular" widget (Weekly/Monthly/All tabs). For a clean popular list, **prefer `/manga/?order=popular`** over parsing this widget (tab switching is JS/AJAX).

---

## 4. Q2 — Manga detail page (`/manga/<slug>/`)

Cross-verified against two titles: `one-piece-a-boy-with-his-horse` (single chapter, sparse data) and `secret-class` (328 chapters, full data). Structure is consistent.

### Container & header

```html
<div class="manga-info mangatere">
  <div class="wrapper">
    <div class="bigcover">
      <div class="bigbanner" style="background-image: url('https://i2.wp.com/.../one-Piece.jpg');"></div>
    </div>
    <div class="terebody">
      <div class="postbody seriestu seriestere">
        <article id="post-52465" class="post-52465 hentry" itemscope itemtype="http://schema.org/CreativeWorkSeries">
          <div class="seriestucon">
            <div class="seriestuheader">
              <h1 class="entry-title" itemprop="name">One Piece A Boy With His Horse</h1>
            </div>
            <div class="seriestucontent">
              <div class="seriestucontl"> ... cover, bookmark, rating ... </div>
              <div class="seriestucontentr"> ... synopsis, first/latest, infotable, genres ... </div>
            </div>
```

### Cover

```html
<div class="thumb" itemprop="image" itemscope itemtype="https://schema.org/ImageObject">
  <img width="285" height="400" src="https://i2.wp.com/2.komikindo.shop/wp-content/uploads/2022/12/one-Piece.jpg" class="attachment- size- wp-post-image" alt="One Piece A Boy With His Horse" title="..." itemprop="image" decoding="async" fetchpriority="high"/>
</div>
<div data-id="52465" class="bookmark"><i class="far fa-bookmark"></i> Bookmark</div>
<div class="bmc">Followed by 516 people</div>
```
Selector: `div.thumb img` (note the class is literally `attachment- size- wp-post-image` — empty size tokens; use the `div.thumb` container, not the class). A banner image also exists at `div.bigcover div.bigbanner` via inline `style="background-image:url(...)"`.

### Rating

```html
<div class="rating bixbox">
  <div class="rating-prc" itemscope itemprop="aggregateRating" itemtype="//schema.org/AggregateRating">
    <meta itemprop="worstRating" content="1">
    <meta itemprop="bestRating" content="10">
    <meta itemprop="ratingCount" content="10">
    <div class="rtp"><div class="rtb"><span style="width:78%"></span></div></div>
    <div class="num" itemprop="ratingValue" content="7.80">7.80</div>
  </div>
</div>
```
Selectors:
- rating value: `div.rating .num[itemprop="ratingValue"]` (text or `content` attr = "7.80")
- best rating: `meta[itemprop="bestRating"]` content = "10"
- rating count: `meta[itemprop="ratingCount"]` content = "10"
- Followed count: `div.bmc` text "Followed by 516 people" (parse the integer).

### Synopsis

```html
<div class="seriestucontentr">
  <div class="seriestuhead">
    <div class="entry-content entry-content-single" itemprop="description">
      <p>Baca terus komik online komikindo dari series Piece A Boy With His Horse..</p>
    </div>
```
Selector: `div.entry-content.entry-content-single[itemprop="description"]` (text of inner `<p>`).
The same text is in `<meta property="og:description">` in `<head>` as a fallback.

### First / Latest chapter indicator

```html
<div class="lastend">
  <div class="inepcx"><a href="#/"><span>First:</span><span class="epcur epcurfirst">Chapter ?</span></a></div>
  <div class="inepcx"><a href="https://2.komikindo.shop/one-piece-a-boy-with-his-horse-chapter-01/"><span>Latest:</span><span class="epcur epcurlast">Chapter 01</span></a></div>
</div>
```
Optional convenience block; the authoritative chapter list is below.

### Info table (Status / Type / Released / Author / Artist / Serialization / dates / Views)

```html
<div class="seriestucont">
  <div class="seriestucontr">
    <table class="infotable">
      <tbody>
        <tr><td>Status</td><td>Ongoing</td></tr>
        <tr><td>Type</td><td>Manhwa</td></tr>
        <tr><td>Author</td><td>Wang Kang Cheol</td></tr>
        <tr><td>Artist</td><td>Mina-chan</td></tr>
        <tr><td>Posted By</td><td><span itemprop="author" class="author vcard"><i itemprop="name">Komikindo</i></span></td></tr>
        <tr><td>Posted On</td><td><time itemprop="datePublished">November 4, 2021</time></td></tr>
        <tr><td>Updated On</td><td><time itemprop="dateModified">October 30, 2026</time></td></tr>
        <tr><td>Views</td><td>?</td></tr>
      </tbody>
    </table>
```
Selector: `table.infotable tbody tr` — each row = `td:nth-child(1)` label, `td:nth-child(2)` value (strip inner tags).
**Parse by label, not by index — rows vary per manga:**
- `Status` → "Ongoing" | "Completed" (maps to manga status)
- `Type` → "Manga" | "Manhwa" | "Manhua" | "Comic"
- `Released` → year string (**optional**; one sample had garbage `Paodies`; `secret-class` had no Released row at all)
- `Author` → author name (optional)
- `Artist` → artist name (**optional**; present for manhwa like `secret-class`, absent for `one-piece`)
- `Serialization` → optional
- `Posted By` → uploader (usually "Komikindo")
- `Posted On` / `Updated On` → `<time>` dates
- `Views` → usually "?" (not useful)

### Genres

```html
<div class="seriestugenre">
  <a href="https://2.komikindo.shop/genres/action/" rel="tag">Action</a>
  <a href="https://2.komikindo.shop/genres/adult/" rel="tag">Adult</a>
  <a href="https://2.komikindo.shop/genres/manwha/" rel="tag">Manwha</a>
  <a href="https://2.komikindo.shop/genres/romance/" rel="tag">Romance</a>
</div>
```
Selector: `div.seriestugenre a[rel="tag"]` → text = genre name, `href` = `/genres/<slug>/` (slug usable for genre filtering).

### Chapter list (fully in HTML, descending)

```html
<div class="eplister" id="chapterlist">
  <ul class="clstyle">
    <li data-num="322" class="first-chapter">
      <div class="chbox">
        <div class="eph-num">
          <a href="https://2.komikindo.shop/secret-class-chapter-322/">
            <span class="chapternum">Chapter 322</span>
            <span class="chapterdate">October 30, 2026</span>
          </a>
        </div>
        <div class="dt">
          <a href="https://dl.linksaya.com?id=177835" rel="nofollow" class="dload" target="_blank" aria-label="Download Chapter 322"><i class="fas fa-cloud-download-alt"></i></a>
        </div>
      </div>
    </li>
    <li data-num="321"> ... </li>
    ...
  </ul>
</div>
```
Selectors:
- container: `#chapterlist` (= `div.eplister`)
- each chapter: `ul.clstyle > li[data-num]` (newest first; e.g. `secret-class` = 328 items, `data-num` 322 → 01)
- chapter page URL: `li .eph-num a[href]`
- chapter number text: `li .eph-num .chapternum` (e.g. "Chapter 322", "Chapter 118.1")
- chapter date: `li .eph-num .chapterdate` (e.g. "October 30, 2026")
- numeric id: `li[data-num]` attribute (string; decimal chapters use "-" in `data-num`/URL and "." in display, e.g. `118-1` → "Chapter 118.1")
- download link (optional, external): `li .dt a.dload[href]` → `dl.linksaya.com?id=…` (ignore for reading)

### Fields NOT available on the detail page
- **altTitle / alternative title / subtitle**: none (confirmed 0 occurrences across both samples).
- "Year" is only available when a `Released` row exists, and it is unreliable.

---

## 5. Q3 — Chapter / reader page (`/<slug>-chapter-<NUM>/`)

The page body contains an **empty** `<div id="readerarea"></div>` and a loading placeholder:

```html
<div id="readerarea"></div>
<div id="readerarea-loading" style="text-align: center;">
  <img src="https://2.komikindo.shop/wp-content/themes/mangareader/assets/img/readerarea.svg"/>
</div>
```

The actual image URLs are embedded as a JSON argument to `ts_reader.run(...)` inside an inline `<script>`:

```javascript
ts_reader.run({"post_id":52467,"noimagehtml":"<center><h4>NO IMAGE YET<\/h4><\/center>","prevUrl":"","nextUrl":"","mode":"full","sources":[{"source":"Server 1","images":["https:\/\/komik.fajarsumatera.com\/wp-content\/uploads\/2022\/12\/Tooncubus.site-A-Boy-With-His-Horse_00003-2081x1248.jpg","https:\/\/komik.fajarsumatera.com\/..._00004-scaled.jpg", ... ]}]});
```

**Extraction approach (cheerio + regex + JSON.parse):**
1. Load HTML with cheerio.
2. Find the `<script>` whose text contains `ts_reader.run(`. (Regex over `cheerio('script').text()` or the raw HTML.)
3. Capture the JSON: `ts_reader\.run\((\{[\s\S]*?\})\)\s*;?` — the captured group is valid JSON (slashes are escaped as `\/`).
4. `JSON.parse(captured)`. Read `sources` — an array of `{ source: "Server 1", images: [url, ...] }`. Use `sources[0].images` for the default server, or expose all servers.
5. `prevUrl` / `nextUrl` give prev/next chapter URLs (may be empty for single-chapter titles).

**Result:** chapter images = `data.sources[0].images` (ordered array of image URLs). No XHR, no browser. The images are hosted on a separate domain (`komik.fajarsumatera.com` for this chapter; also `linksaya.com` / `cdn.linksaya.com` / `img7.linksaya.com` elsewhere).

Other reader-page elements (mostly JS-driven, not needed for scraping):
- Chapter selector dropdown `#chapter` is empty in HTML (populated by `loadChList()` AJAX) — ignore; use the detail-page chapter list instead.
- Prev/next nav: `.ch-prev-btn` / `.ch-next-btn` (placeholders `#/prev/`, `#/next/`); prefer `ts_reader` `prevUrl`/`nextUrl` or the detail-page list.
- Page-mode selectors: `select.readingmode`, `#select-paged` (paged vs full) — irrelevant; images come from the same JSON.

The reader page also fires a `dynamic_view_ajax` POST to `admin-ajax.php` (view counter) — ignorable.

---

## 6. Q4 — Search endpoint

Yes. WordPress standard search via `GET /?s=<query>`, surfaced by the site search form (`<input name="s">`, action `https://2.komikindo.shop/`).

- Results page reuses the **same `.listupd > .bs > .bsx` card markup** as the `/manga/` archive — and crucially these cards **link to the manga detail page** (`/manga/<slug>/`), include `span.status`, `span.typename`, `.tt` title, `.epxs` latest chapter, and `.numscore` rating.
- Pagination: `https://2.komikindo.shop/page/N/?s=<query>` (observed 3 pages for "one piece", ~10 results/page).
  ```html
  <div class="pagination">
    <span aria-current="page" class="page-numbers current">1</span>
    <a class="page-numbers" href="https://2.komikindo.shop/page/2/?s=one+piece">2</a>
    <a class="page-numbers" href="https://2.komikindo.shop/page/3/?s=one+piece">3</a>
    <a class="next page-numbers" href="https://2.komikindo.shop/page/2/?s=one+piece">Next</a>
  </div>
  ```
- There is also an ajaxyLiveSearch autocomplete (`searchUrl: https://2.komikindo.shop/?s=%s`, `ajaxUrl: /wp-admin/admin-ajax.php`) but it is not needed; the HTML search is sufficient.

---

## 7. Q5 — Latest / update page

Yes — two good options:
1. **`GET /manga/?order=update&page=N`** (recommended). Cards link to **detail pages**, show `.epxs` latest chapter, type, status, rating. ~20/page, ~496 pages.
2. Homepage sections "Latest Update" / "Manhwa Terbaru" / "Manhua Terbaru" (paginated via `/page/N/`), but those cards link to **chapter pages** and only carry a relative date (`.epxdate`) + latest chapter (`.epxs`).

`/daftar-komik/` (requested in the brief) **returns 404** — the actual listing page is `/manga/` (the `manga` post-type archive; the nav menu literally labels it "Daftar Komik").

---

## 8. Q6 — Popular page

- `/popular/` → **404** (no dedicated popular page).
- **`/manga/?order=popular`** → 200; same `.listupd > .bs > .bsx` cards, links to detail pages, sorted by popularity (top result = `secret-class`). Use this. ~20/page.
- The sidebar "Popular" widget (Weekly/Monthly/All tabs, `div.serieslist.pop.wpop`) is rendered in HTML for the active "Weekly" tab; tab switching is AJAX. Not recommended over `?order=popular`.

---

## 9. Q7 — Genres list page

- **Genre index: `GET /genres/`** → A–Z list (classes `ulclear az-list`, `footer-az`, `ftaz`). Contains **449 distinct genre anchor links** of the form `https://2.komikindo.shop/genres/<slug>/`.
- **Per-genre archive: `GET /genres/<slug>/`** (e.g. `/genres/action/`) → reuses `.listupd > .bs > .bsx` (with status/type/rating), **~10 items/page**, paginated `/genres/<slug>/page/N/`.
- Alternative: the `/manga/` filter form posts `genre[]=ID` term IDs (e.g. `?genre[]=18`) to `/manga/` — useful if you only have term IDs, but the slug form (`/genres/<slug>/`) is cleaner and human-readable. Both work.
- On a manga detail page, genres are `div.seriestugenre a[rel="tag"]` → name + `/genres/<slug>/` href (reuse the slug for the genre archive).

---

## 10. Q8 — API endpoints (XHR/fetch) vs HTML scraping

**No JSON API is needed; it is pure HTML scraping (cheerio) with one regex/JSON extraction for the reader.**

- The only `admin-ajax.php` calls observed:
  - `dynamic_view_ajax` (POST, `post_id`) on the reader page → view counter. Ignore.
  - ajaxyLiveSearch (`?s=%s`) → live-search autocomplete. Ignore; use the HTML search.
  - Popular-widget tab switching (`wpop`) → ignore; use `/manga/?order=popular`.
- Reader images are **not** fetched via XHR; they are inline JSON in `ts_reader.run({...})` (see Q3). So cheerio + regex + `JSON.parse` suffices; no headless browser, no Playwright/Puppeteer.
- The chapter `#chapter` `<select>` on the reader page is populated by `loadChList()` (AJAX) but the authoritative chapter list is already in the detail-page HTML (`#chapterlist`) — use that.

---

## 11. Q9 — Pagination structure

Standard WordPress pagination markup (consistent across listing/search/genre):

```html
<div class="pagination">
  <span aria-current="page" class="page-numbers current">1</span>
  <a class="page-numbers" href="/manga/?page=2">2</a>
  <span class="page-numbers dots">&hellip;</span>
  <a class="page-numbers" href="/manga/?page=496">496</a>
  <a class="next page-numbers" href="/manga/?page=2">Next</a>
</div>
```

Selectors / parsing:
- container: `div.pagination`
- current page: `span.page-numbers.current` (text = page number)
- page links: `a.page-numbers[href]` (text = page number)
- next: `a.next.page-numbers[href]`; previous: `a.prev.page-numbers[href]` (appears when not on page 1)
- last numbered link → total page count (e.g. 496 for `/manga/`).

URL forms by endpoint:
- `/manga/` archive: `?page=N` (pagination links use this) — `/manga/page/N/` also works.
- Search: `/page/N/?s=<query>`.
- Genre archive: `/genres/<slug>/page/N/`.
- Homepage: `/page/N/`.
- Project: `/project/page/N/`.

Observed per-page item counts (parse dynamically; don't hard-code):
- `/manga/` archive & `?order=*`: ~20/page.
- Search & genre archives: ~10/page.
- `/project/`: ~20/page (29 pages total).
- `/manga/` total: 496 pages.

---

## 12. Q10 — robots.txt & sitemap

### robots.txt (`/robots.txt`)
```
User-agent: Googlebot   Allow: /
User-agent: Bingbot      Allow: /
User-agent: DuckDuckBot  Allow: /
User-agent: DotBot       Disallow: /
User-agent: PetalBot     Disallow: /
User-agent: SemrushBot   Disallow: /
User-agent: AhrefsBot    Disallow: /
User-agent: *            Disallow: /wp-admin/  Allow: /wp-admin/admin-ajax.php  Disallow: /wp-include/
```
Plain HTML pages are not disallowed for a generic crawler, but the site explicitly blocks aggressive SEO/scraping bots. **Recommendation:** identify your scraper with a descriptive `User-Agent`, set a polite rate limit (the site is behind Cloudflare-style protection and serves JuicyAds/Histats; heavy hammering risks blocking), and cache responses.

### Sitemaps (Yoast SEO)
- Index: `/sitemap.xml` (also `/sitemap_index.xml`, `/wp-sitemap.xml` — identical 10 KB index) → lists `post-sitemap.xml`, `post-sitemap2.xml`, … .
- **`/manga-sitemap.xml`** (267 KB) — full `<urlset>` of every manga: each `<url>` has `<loc>https://2.komikindo.shop/manga/<slug>/</loc>` and an `<image:image><image:loc>…cover…</image:loc></image:image>`. Useful as a fallback to enumerate all manga slugs + covers (no other metadata).

---

## 13. Field → selector reference (build sheet)

| Output field | Source page | Selector / method | Notes |
|---|---|---|---|
| manga id/slug | detail | canonical `<link rel="canonical" href="/manga/<slug>/">` or parse URL | slug = path segment |
| title | detail | `h1.entry-title[itemprop="name"]` | clean text |
| altTitle | — | **not available** | no field on site |
| cover | detail | `div.thumb img` (`src`) | strip `?resize=` for full res |
| banner | detail | `div.bigcover div.bigbanner` (inline `style` background-image) | optional |
| synopsis | detail | `div.entry-content-single[itemprop="description"]` | text of inner `<p>`; fallback `meta[property="og:description"]` |
| status | detail | `table.infotable tr` where first td = "Status" | "Ongoing"/"Completed" |
| type | detail | `table.infotable tr` where first td = "Type" | "Manga"/"Manhwa"/"Manhua"/"Comic" |
| year | detail | `table.infotable tr` where first td = "Released" | **optional & unreliable** |
| author | detail | infotable row "Author" | optional |
| artist | detail | infotable row "Artist" | **optional** (manhwa only) |
| genres | detail | `div.seriestugenre a[rel="tag"]` | name + `/genres/<slug>/` |
| rating | detail | `div.rating .num[itemprop="ratingValue"]` | also `meta[itemprop="bestRating"]`=10, `meta[itemprop="ratingCount"]` |
| followed count | detail | `div.bmc` | parse integer from "Followed by N people" |
| chapter list | detail | `#chapterlist ul.clstyle > li[data-num]` | newest first; per item: `.eph-num a[href]`, `.chapternum`, `.chapterdate` |
| chapter images | reader | parse `ts_reader.run({...})` JSON → `sources[0].images` | ordered image URL array |
| list card (browse/search/genre) | listing | `.listupd .bsx` | `a[href]`→detail, `.limit img.ts-post-image`→cover, `.tt`→title, `.epxs`→latest ch, `span.status`→status, `span.typename`→type, `.numscore`→rating |
| latest-update card (home) | home | `.listupd .bsx` | `a[href]`→**chapter** page; `.epxdate`→relative time; `.epxs`→latest ch; `.tt`→title; `.limit img`→cover |
| pagination | any listing | `div.pagination` → `a.page-numbers`, `a.next.page-numbers` | last numbered link = total pages |

---

## 14. Gotchas & recommendations

1. **Use `/manga/?order=update` (not the homepage) for "latest"** — its cards link to detail pages; homepage cards link to chapter pages.
2. **Don't construct chapter URLs.** Decimal chapters differ between URL and display (`118-1` vs "118.1"). Always take `href` from the detail-page chapter list.
3. **Reader images need JSON extraction**, not `#readerarea` (empty in HTML). Use the `ts_reader.run(...)` script. Multiple `sources` (servers) may exist — expose `sources[*].images` if you want server choice, else default to `sources[0]`.
4. **Parse `table.infotable` by label.** Rows vary; Artist/Released/Serialization are optional. Map `Released`→year but treat as best-effort.
5. **No altTitle** — leave it null/omitted in your model; don't waste a request looking for it.
6. **Cover URLs:** strip Photon `?resize=W,H` (and any `?fit=`) to get the original. Hosts vary: `i*.wp.com/2.komikindo.shop/...`, `linksaya.com`, `cdn.linksaya.com`, `img*.linksaya.com`, `komik.fajarsumatera.com`.
7. **Rate limiting & UA:** the site blocks SEO bots in robots.txt and is ad-monetized + stats-tracked; use a clear User-Agent, throttle requests (e.g. a few req/sec), and cache. Consider `Referer: https://2.komikindo.shop/` on image requests.
8. **External mirror domains** (`komikindo4.link`, `komikindo.link`, `komikindo.me`) appear in "View All" links — ignore them; only scrape `2.komikindo.shop`.
9. **Sitemap fallback:** if `/manga/?page=N` pagination ever changes, `/manga-sitemap.xml` enumerates every manga slug + cover.
10. **Encoding:** titles contain HTML entities (`&#8220;`, `&#8217;`, `&#8230;`) and sometimes stray quotes in image paths (`src="...images/&quot;/..."`) — decode entities and sanitize cover URLs.
11. **The `/project/` page** (`/project/page/N/`, 29 pages, ~20/page) is a curated "Project" grid using `div.listupd.cp > div.bs > div.bsx` linking to detail pages — usable as a "featured/recommended" source if wanted.

---

## 15. Evidence: raw files captured (TEMP, not committed)

Fetched via `Invoke-WebRequest` to `$env:TEMP`:
- `home.html` (homepage, 220 KB), `mangalist.html` (`/manga/`, 161 KB), `search.html` (`/?s=one+piece`, 88 KB),
  `manga.html` (`/manga/one-piece/`, 88 KB), `secret.html` (`/manga/secret-class/`, 357 KB),
  `chapter.html` (`/one-piece-a-boy-with-his-horse-chapter-01/`, 69 KB),
  `genres.html` (`/genres/`, 116 KB), `genre_action.html` (`/genres/action/`, 51 KB),
  `project.html` (`/project/`, 90 KB), `manga_popular.html` (`/manga/?order=popular`, 215 KB),
  plus probe output logs `probe*_out.txt` in TEMP.

All selectors above were derived from these captures; no line numbers are asserted (HTML is generated/cached and shifts).
