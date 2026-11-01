# Investigation: https://01.apkomik.com/ — Manga Source Structure

Status: READ-ONLY investigation. No code was changed. Findings below are grounded in raw HTML
fetched live from the site (Chrome User-Agent; see "Fetch notes" at the bottom) and in the
existing project source (`src/routes/manga.routes.js`, `src/sources/*`, `src/utils/httpClient.js`).

---

## 1. Executive summary (answers to the brief's 10 questions)

1. **Homepage HTML structure:** WordPress + **Themesia "mangastream 12.0"** theme (presence of
   `ts_config`, `ts_reader`, `ts-ajax-cache`, and the theme path
   `/wp-content/themes/mangastream12.0/`). Manga cards everywhere use the Themesia pattern
   `div.listupd > div.bs > div.bsx > a[href*="/manga/"]`. See §4.1 for full card selectors.
2. **Manga detail page** (`/manga/{slug}/`): selectors differ from the komikindo source. apkomik
   uses `div.tsinfo div.imptdt` for Status/Type and `div.flex-wrap div.fmed` (with `<b>` labels)
   for Author/Released/etc. — **not** a `table.infotable`. Genres live in `span.mgen a[rel="tag"]`,
   not `div.seriestugenre`. Chapter list is `#chapterlist > ul > li[data-num]` (the `<ul>` has no
   `clstyle` class). See §4.2.
3. **Chapter/reader page:** images are delivered as **inline JSON** in a `<script>ts_reader.run({...})</script>`
   tag; `#readerarea` is **empty in the raw HTML** (images are injected client-side). Parse the
   JSON and read `sources[].images[]`; `sources[].source` is the server name ("Server 1"),
   `prevUrl`/`nextUrl` give chapter navigation. See §4.3.
4. **Search endpoint:** standard WordPress search `/?s={query}` (form input `name="s"`). Results
   container `.bixbox .releases h1` ("Search '…'") + `.listupd .bs .bsx` cards. Pagination via
   `/page/{N}/?s={query}`. See §4.4.
5. **Latest/update page:** `/manga/?order=update` (verified working — first result "The Terminally
   Ill Lady…"). This is the canonical "latest updates" feed.
6. **Popular page:** `/manga/?order=popular` (verified working — first result "Martial Peak",
   matching the sidebar "Terpopuler / All" list). Also `/manga/?order=latest` for "newest added".
7. **Genres list page:** there is **no** genres index page — `/genres/` and `/genre/` return **404**.
   Genre **detail** pages `/genres/{slug}/` exist (200) **but ignore the `order` query param**
   (always alphabetical A‑Z). The genre catalog (name + numeric ID) is obtainable from the
   filter form on `/manga/` (`input[name="genre[]"][value="ID"]` + sibling `label`). See §3 & §5.
8. **Platform:** WordPress + Themesia/Madara family (mangastream variant), confirmed by `robots.txt`
   (`/wp-admin/`), `wp-content/themes/mangastream12.0/`, `ts_config`, `ts_reader`, `.bs/.bsx/.utao/.listupd`.
9. **Pagination:** `/manga/` list uses `?page={N}` via a single "Next" link `div.hpage > a.r`
   (href like `?page=2`). **No numbered page links**, so only `hasNextPage` is reliably derivable;
   `maxPage` is unknown. The homepage/search use the path form `/page/{N}/`. See §4.5.
10. **API endpoints (XHR/fetch):** no manga-listing JSON API. `wp-admin/admin-ajax.php` exists (the
    `ts_config.ajaxurl` and the comment system `KDC_DATA.ajaxUrl`) but is used for comments/voting,
    not for manga listings. The manga lists are fully server-rendered HTML. Reader images come from
    inline `ts_reader.run` JSON, not a separate XHR. See §6.

### ⭐ Critical actionable finding (directly matches user messages #1 & #2)
The `/genres/{slug}/` archive **silently ignores the `order` parameter** — `order=update`,
`order=popular`, `order=latest` all return the identical A‑Z order. Only the
`/manga/?genre[]={ID}&order=…` form honors `order`. **Therefore the apkomik source's
genre-filtered listings MUST use `/manga/?genre[]={genreId}&order=update` (or chosen order), NOT
`/genres/{slug}/`.** This is the same conclusion the user reached for komikindo in message #2,
and the existing `KomikindoSource.getByGenre` already implements it correctly (use that as the
template). Full evidence in §5.

---

## 2. Platform & theme identification

- `robots.txt` (67 bytes): `User-agent: * / Disallow: /wp-admin/ / Allow: /wp-admin/admin-ajax.php` → WordPress.
- Homepage `<script>const ts_config = {"general":{"ajaxurl":"https://01.apkomik.com/wp-admin/admin-ajax.php", ...}}` → Themesia config object.
- Reader lazy-load placeholder: `https://01.apkomik.com/wp-content/themes/mangastream12.0/assets/img/readerarea.svg` → theme = **mangastream 12.0** (Themesia family).
- Card classes present: `bs`, `bsx`, `utao`, `uta`, `listupd`, `bigcontent`, `eplister`, `eph-num`, `epxs`, `numscore`, `ts-post-image` → classic Themesia/Madara vocabulary.
- `lang="id"`; site language Indonesian; color theme `#8b4513` (saddle brown).
- **Blocks default/empty User-Agents with HTTP 403.** The project's `src/utils/httpClient.js` already sends a Chrome UA (`Chrome/124.0.0.0`) + `Accept-Language: id-ID,id;q=0.9`, which satisfies the site (verified — fetched pages return 200). No special UA handling is needed in the source, but it must rely on `getHtml` rather than a raw fetch.

---

## 3. URL map (endpoints to expose)

| Purpose | Upstream URL | Notes |
|---|---|---|
| Latest updates | `https://01.apkomik.com/manga/?order=update&page={N}` | `getLatest` |
| Popular | `https://01.apkomik.com/manga/?order=popular&page={N}` | `getPopular` |
| Newest added | `https://01.apkomik.com/manga/?order=latest&page={N}` | `getNewest`/`getList(sort=newest)` |
| A‑Z / Z‑A | `/manga/?order=title&page={N}` / `?order=titlereverse&page={N}` | `getAz`/`getZa` |
| Filtered list (status/type/order/genre) | `/manga/?status={s}&type={t}&order={o}&genre[]={id}&page={N}` | `getList` |
| Search | `/?s={q}` (page 1) or `/page/{N}/?s={q}` (page ≥2) | `search` |
| Genre catalog | parsed from `/manga/` filter form (`input[name="genre[]"]`) | `getGenres` |
| Genre-filtered list | `/manga/?genre[]={id}&order=update&page={N}` | `getByGenre` — **do NOT use `/genres/{slug}/`** |
| Types catalog | parsed from `/manga/` filter form (`input[name="type"]`) | `getTypes` → manga/manhwa/manhua/comic/novel |
| Type-filtered list | `/manga/?type={t}&order=update&page={N}` | `getByType` |
| Manga detail | `/manga/{slug}/` | `getDetails` |
| Chapter images | `{chapter-href}` (full chapter URL from detail list) | `getPages` — parse `ts_reader.run` JSON |

Filter parameter values (from the `/manga/` filter form, §4.1.2):
- `order`: `` (Default/A‑Z-ish), `title` (A‑Z), `titlereverse` (Z‑A), `update` (Update), `latest` (Added), `popular` (Popular). Note "Added" maps to value `latest`, not `added`.
- `status`: `` (All), `ongoing`, `completed`, `hiatus`.
- `type`: `` (All), `manga`, `manhwa`, `manhua`, `comic`, `novel`.
- `genre[]`: numeric term IDs, e.g. `14`=Action, `2268`=4-Koma, `2`=Comedy, `16`=Fantasy. Multiple allowed.

---

## 4. Selectors (with HTML evidence)

### 4.1 Listing / card pages (homepage, `/manga/`, `/genres/{slug}/`, search, genre filter)

Card markup (verbatim, from the homepage and `/manga/`):
```html
<div class="bs">
  <div class="bsx">
    <a href="https://01.apkomik.com/manga/magic-emperor-demonic-emperor/" title="Magic Emperor (Demonic Emperor)">
      <div class="limit">
        <div class="ply"></div>
        <span class="type Manhua">Manhua</span>
        <img src="https://01.apkomik.com/wp-content/uploads/2019/10/magic-emperor.jpg"
             class="ts-post-image wp-post-image attachment-medium size-medium"
             loading="lazy" itemprop="image" title="…" alt="…" width="320" height="424"/>
      </div>
      <div class="bigor">
        <div class="tt">Magic Emperor (Demonic Emperor)</div>
        <div class="adds">
          <div class="epxs">Chapter 930</div>
          <div class="rt"><div class="rating">…<div class="numscore">7.00</div></div></div>
        </div>
        <div class="titleheading"><h2>Magic Emperor (Demonic Emperor)</h2></div>
      </div>
    </a>
  </div>
</div>
```
Status badge (only present on non-ongoing manga; absent → ongoing):
```html
<span class="status Completed">Completed</span>   <!-- inside .limit, before span.type -->
```
Card selectors:
- Container: `div.listupd > div.bs > div.bsx` (also `div.listupd.popularslider div.popconslide` on the homepage; search uses `div.bixbox div.listupd`).
- Link/title/slug: `div.bsx > a` → `href` (slug = last path segment of `/manga/{slug}/`), `title` attr; visible title `.tt` text.
- Cover: `.limit img.ts-post-image` (or `.limit img`) `src`.
- Type: `.limit span.type` text (also class carries the type, e.g. `type Manhua`). **Note:** apkomik uses `span.type`, whereas `KomikindoSource._parseCardList` reads `span.typename` — apkomik needs `span.type`.
- Status: `.limit span.status` (text; absent ⇒ "ongoing").
- Latest chapter: `.adds .epxs` text → parse `Chapter\s+([0-9.]+)`.
- Rating: `.adds .numscore` text → parseFloat.

#### 4.1.1 Filter form (on `/manga/` only — gives genre IDs + type/status/order values)
```html
<div class="quickfilter">
  <form action="https://01.apkomik.com/manga" class="filters " method="GET">
    <div class="filter dropdown">
      <ul class="dropdown-menu c4 genrez">
        <li><input class="genre-item" type="checkbox" id="genre-14" name="genre[]" value="14">
            <label for="genre-14">Action</label></li>
        …
      </ul>
    </div>
    <div class="filter dropdown">
      <ul class="dropdown-menu c1">
        <li><input type="radio" id="anime_status-ongoing" name="status" value="ongoing"><label for="anime_status-ongoing">Ongoing</label></li>
        … completed / hiatus …
      </ul>
    </div>
    <div class="filter dropdown">
      <ul class="dropdown-menu c1">
        <li><input type="radio" id="type-manhwa" name="type" value="manhwa"><label for="type-manhwa">Manhwa</label></li>
        … manga / manhua / comic / novel …
      </ul>
    </div>
    <div class="filter dropdown">
      <ul class="dropdown-menu c1">
        <li><input type="radio" name="order" value="title">…</li>
        <li><input type="radio" name="order" value="titlereverse">…</li>
        <li><input type="radio" name="order" value="update">…</li>
        <li><input type="radio" name="order" value="latest">… (label "Added")</li>
        <li><input type="radio" name="order" value="popular">…</li>
      </ul>
    </div>
    <div class="filter submit"><button type="submit" class="btn btn-custom-search">…Search</button></div>
  </form>
</div>
```
This is the canonical source for the genre catalog (id + label) and the type/status/order vocabularies. The existing `KomikindoSource.getGenres` parses `input[name="genre[]"]` exactly this way and can be reused almost verbatim (derive `slug` from the label via `label.toLowerCase().replace(/\s+/g,'-')`).

### 4.2 Manga detail page (`/manga/{slug}/`)

Container: `div.bixbox.animefull > div.bigcontent.nobigcover`.
- Cover: `div.thumbook div.thumb img` `src` (also `itemprop="image"`).
- Rating: `div.thumbook div.rt div.rating div.numscore` text → parseFloat. Also `meta[itemprop="ratingCount|bestRating|worstRating"]` and aggregateRating block. Followed count: `div.bmc` ("Followed by 5372 people").
- Status & Type (NOT a table):
```html
<div class="tsinfo">
  <div class="imptdt">Status <i>Ongoing</i></div>
  <div class="imptdt">Type <a href="/manga/?order=title&type=Manhua">Manhua</a></div>
</div>
```
  → Status: `div.tsinfo .imptdt:contains("Status") i` text (lowercase). Type: `div.tsinfo .imptdt:contains("Type") a` text (lowercase).
- Title: `div.infox h1.entry-title[itemprop="name"]`.
- Alternative titles:
```html
<div class="infox"><h1 …>Magic Emperor (Demonic Emperor)</h1>
  <div class="wd-full"><b>Alternative Titles</b><span>Devil Housekeeper, Demonic Emperor</span></div>
```
  → `div.infox div.wd-full:has(b:contains("Alternative Titles")) span` text (komikindo does not parse this; apkomik can).
- Synopsis: `div.infox div.entry-content.entry-content-single[itemprop="description"]` (first `<p>`).
- Released/Author/Serialization/Posted/Updated — all `div.flex-wrap div.fmed` with a `<b>` label and a `<span>` value:
```html
<div class="flex-wrap">
  <div class="fmed"><b>Released</b><span>-</span></div>     <!-- year; often "-" -->
  <div class="fmed"><b>Author</b><span>Nightingale (original) + No two comics</span></div>
</div>
<div class="flex-wrap">
  <div class="fmed"><b>Posted On</b><span><time itemprop="datePublished" datetime="2026-05-03T09:48:27+07:00">…</time></span></div>
  <div class="fmed"><b>Updated On</b><span><time itemprop="dateModified" datetime="2026-11-01T07:11:52+07:00">…</time></span></div>
</div>
```
  → Parse `.fmed` by its `<b>` label text. **There is no separate "Artist" field** on apkomik (the Author span often contains art credits inline) — map `artist` to `null`.
- Genres (NOT `.seriestugenre`):
```html
<div class="wd-full"><b>Genres</b>
  <span class="mgen">
    <a href="https://01.apkomik.com/genres/action/" rel="tag">Action</a>
    <a href="https://01.apkomik.com/genres/adventure/" rel="tag">Adventure</a>
    …
  </span>
</div>
```
  → `div.infox span.mgen a[rel="tag"]`: `href` `/genres/{slug}/` → genre slug; text → genre name. (This satisfies user message #7 "di detail untuk genre nya kasih slug nya" — the slug is right there in the href.)
- Chapter list (descending: latest first):
```html
<div class="eplister" id="chapterlist">
  <ul>
    <li data-num="930">
      <div class="chbox"><div class="eph-num">
        <a href="https://01.apkomik.com/magic-emperor-demonic-emperor-chapter-930-bahasa-indonesia/">
          <span class="chapternum">Chapter 930</span>
          <span class="chapterdate">November 1, 2026</span>
        </a>
      </div></div>
    </li>
    <li data-num="929">…</li>
  </ul>
</div>
```
  → `#chapterlist > ul > li[data-num]`: chapter number from `data-num` or `.chapternum` (parse `Chapter\s+([0-9.]+)`); date `.chapterdate`; URL `.eph-num a` `href` (full chapter URL). **The `<ul>` has no class** — komikindo selects `#chapterlist ul.clstyle`, which will NOT match apkomik; use `#chapterlist > ul > li[data-num]`.
- Related series (user message #8 "ada related di detail"):
```html
<div class="bixbox">
  <div class="releases"><h2><span>Related Series</span></h2></div>
  <div class="listupd">
    <div class="bs"><div class="bsx"><a href="https://01.apkomik.com/manga/boruto-two-blue-vortex/" title="Boruto: Two Blue Vortex">…</a></div></div>
    …
  </div>
</div>
```
  → Find the `.bixbox` whose heading (`.releases h2/h3 span`) contains "Related", then parse its `.listupd .bs .bsx` with the same card parser. `KomikindoSource.getDetails` already does this (search `.bixbox` headings for "related"); reuse the approach — but note apkomik's heading is `<h2><span>Related Series</span></h2>` (text "related series"), which komikindo's `heading.includes('related')` will match.

### 4.3 Chapter / reader page

`#readerarea` is **empty** in the raw HTML:
```html
<div id="readerarea"></div>
<div id="readerarea-loading" style="text-align:center;">
  <img src="https://01.apkomik.com/wp-content/themes/mangastream12.0/assets/img/readerarea.svg" />
</div>
```
The actual images are in an inline `<script>`:
```html
<script>ts_reader.run({
  "post_id":710781,
  "noimagehtml":"<h2>NO IMAGE YET<\/h2>",
  "prevUrl":"https://01.apkomik.com/magic-emperor-demonic-emperor-chapter-929-bahasa-indonesia/",
  "nextUrl":"",
  "mode":"full",
  "sources":[
    {"source":"Server 1","images":[
      "https://cdnap.site/media/2026/11/2026_11_01_07_11_43_000000_1e18dec30558_0000.webp",
      "https://cdnap.site/media/2026/11/2026_11_01_07_11_43_000000_424c49b62cc8_0001.webp",
      …
    ]}
  ],
  "lazyload":false,
  "defaultSource":"Server 1",
  "contentmode":"advanced",
  "protected":false,
  "is_novel":false
});</script>
```
- Extract with the same regex `KomikindoSource.getPages` uses: `/ts_reader\.run\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;/`, then `JSON.parse`.
- Images: `tsData.sources[serverIndex].images[]` (1-indexed `server` param → `sources[server-1]`). `sources[].source` is the server label (user message #11 "available server" = these `sources[]` entries; apkomik typically exposes only "Server 1", but the code must handle multiples and clamp the index).
- Chapter navigation: `prevUrl` / `nextUrl` (next is `""` on the latest chapter).
- Build pages with `proxyUrl: /api/proxy/image?url=${encodeURIComponent(imgUrl)}` — identical to every other source (see §6).

### 4.4 Search

- Endpoint: `https://01.apkomik.com/?s={query}` (page 1); `/page/{N}/?s={query}` for page ≥2 (standard WP).
- Results header: `div.bixbox div.releases h1` → `Search 'magic'`. Results: `div.listupd div.bs div.bsx` (same card parser).
- The header search form: `<input … name="s"/>`.

### 4.5 Pagination

- `/manga/` (and all `/manga/?…` filter URLs): a single next link, no numbered pages:
```html
<div class="hpage">
  <a href="?page=2" class="r">Next <span class="dashicons dashicons-arrow-right-alt2"></span></a>
</div>
```
  → `hasNextPage = !!$('div.hpage a.r').length`; the next page number is parseable from the `href` `?page={N}`. **`maxPage` is NOT available** (no numbered links). `KomikindoSource._parsePagination` reads `div.pagination a.page-numbers`, which does **not** exist on apkomik — apkomik needs its own `_parsePagination` based on `div.hpage a.r`. Set `maxPage = null`; the route's `validatePageBounds` only 404s when `page > 1 && (maxPage && page>maxPage || data.length===0)`, so a null `maxPage` with non-empty data is safe.
- Homepage / search archives: `/page/{N}/` path form (the homepage main grid is `.listupd.popularslider`, not a paginated endpoint the API needs to expose).

---

## 5. The genre-order finding (evidence)

First 6 result titles for each URL (live fetch):

| URL | #1 | #2 | #3 |
|---|---|---|---|
| `/genres/action/` | .hack//G.U.+ | "Honyaku"… | "Jako ni wa…" |
| `/genres/action/?order=update` | .hack//G.U.+ | "Honyaku"… | "Jako ni wa…" |
| `/genres/action/?order=popular` | .hack//G.U.+ | "Honyaku"… | "Jako ni wa…" |
| `/genres/action/?order=latest` | .hack//G.U.+ | "Honyaku"… | "Jako ni wa…" |
| `/manga/?genre[]=14` (no order) | .hack//G.U.+ | "Honyaku"… | "Jako ni wa…" |
| `/manga/?genre[]=14&order=update` | **The Regressed Life Of A Back Alley Mage** | Kuro no Jiku | Noumin Kanren… |
| `/manga/?genre[]=14&order=popular` | **Martial Peak** | Eleceed | Magic Emperor (Demonic Emperor) |

Conclusion: the `/genres/{slug}/` archive and the bare `/manga/?genre[]=ID` both default to A‑Z and
**ignore `order`**. Only `/manga/?genre[]={ID}&order={value}` applies the order. This is exactly
user messages #1 ("genre detail pake order ap, harusnya pake order update") and #2 ("genre detail
harusnya di ambil dari …/manga/?genre%5B%5D=7525&order=update"). The apkomik `getByGenre` must build
`/manga/?genre[]={id}&order={order}&page={N}` (mirror `KomikindoSource.getByGenre`), and the genre
catalog (id ↔ slug/name) must come from the `/manga/` filter form so the ID is available.

Verified working order URLs (all HTTP 200, distinct first results):
`/manga/?order=popular` → Martial Peak · `/manga/?order=update` → "The Terminally Ill Lady…" ·
`/manga/?order=latest` → "The illegitimate son became a monster summoner" ·
`/manga/?status=completed&order=update` → "Otomege no Mobu…" · `/manga/?order=update&page=2` → 200.

---

## 6. Image hosting & proxy

- Reader images are served from an external CDN, e.g. `https://cdnap.site/media/2026/11/…webp`.
- **Hotlink protection confirmed:** fetching an image with no `Referer` → **HTTP 403**. With `Referer: https://cdnap.site/` (the image's own origin) → **200**. With `Referer: https://01.apkomik.com/` → **200**. (Tested HEAD against `…/2026_11_01_07_11_43_000000_1e18dec30558_0000.webp`.)
- The existing proxy `GET /api/proxy/image?url=…` (`src/routes/proxy.routes.js`) derives a Referer from the image hostname; `cdnap.site` is not in its known-host list, so it falls back to the `else` branch → `https://cdnap.site/` (the origin), **which works (200)**. So apkomik images will proxy correctly **without any change to `proxy.routes.js`**.
- Belt-and-suspenders: the source may pass an explicit referer by appending `&referer=${encodeURIComponent('https://01.apkomik.com/')}` to `proxyUrl` (the proxy honors `req.query.referer`), or a `cdnap.site` branch can be added to `proxy.routes.js`. Either also yields 200. (User message #10 was about image proxying generally; this confirms apkomik images are proxyable provided a Referer is sent.)

---

## 7. Recommendations for the apkomik source

Create `src/sources/apkomik/ApkomikSource.js` extending `BaseSource`, register it in
`src/sources/index.js` (`require` + `registerSource(new ApkomikSource())`). Mirror the
`KomikindoSource` structure (it is the same Themesia family) but adjust the divergent selectors
identified above. Suggested shape:

- `constructor`: `super('apkomik', 'Apkomik')`; `this.baseUrl = 'https://01.apkomik.com'`; `this.icon` = the site logo (`https://01.apkomik.com/wp-content/uploads/2024/02/logo.png`, found in `<link rel="icon">`).
- `getSupportedSorts()`: latest/popular/az/za (the route's `/rating` will 404 gracefully since `getRating` is not defined — apkomik has no rating-sort endpoint; rating is per-manga only).
- `_parseCardList($)`: container `div.listupd div.bsx` (or `div.listupd div.bs div.bsx`); slug from `/manga/([^/]+)/`; cover `.limit img.ts-post-image`/`.limit img` `src`; **type from `.limit span.type`** (not `span.typename`); status from `.limit span.status` (absent ⇒ "ongoing"); latest chapter `.epxs`; rating `.numscore`.
- `_parsePagination($, currentPage)`: `hasNextPage = $('div.hpage a.r').length > 0`; `maxPage = null` (optionally compute a running max from any page number seen in the `?page=` href). Do **not** use `div.pagination a.page-numbers`.
- `getLatest(page)` → `/manga/?order=update&page={N}`.
- `getPopular(page)` → `/manga/?order=popular&page={N}`.
- `getAz(page)` → `/manga/?order=title&page={N}`; `getZa(page)` → `?order=titlereverse&page={N}`.
- `getList(page, options)` → combine `status`, `type`, `genre[]` (resolve genre name/slug→id via `getGenres`), `order`, `page`. (Satisfies user messages #3/#4/#6 — these all work on `/manga/`.)
- `search(query, page)` → `/?s={q}` (page 1) or `/page/{N}/?s={q}` (page ≥2).
- `getGenres()` → parse `input[name="genre[]"]` on `/manga/` (id from `value`, name from sibling `label`, slug = slugify(name)); cache like komikindo does. (No `/genres/` index exists.)
- `getByGenre(genre, page, options)` → resolve id(s), then `/manga/?genre[]={id}&order={order}&page={N}` (**never** `/genres/{slug}/`). Default order `update` (user message #1/#2).
- `getTypes()` → `['manga','manhwa','manhua','comic','novel']` (override the BaseSource default of 3 — apkomik has 5; the route validates `/types/:type` against this list, so comic/novel must be included).
- `getByType(type, page, options)` → `/manga/?type={t}&order={order}&page={N}`.
- `getDetails(slug)` → `/manga/{slug}/`; use the §4.2 selectors (`div.tsinfo .imptdt`, `div.flex-wrap .fmed`, `span.mgen a[rel="tag"]` with slug from `/genres/{slug}/`, `#chapterlist > ul > li[data-num]`, "Related Series" `.bixbox`). Include altTitle (komikindo omits it). Set `artist = null`. Chapter `slug` = full chapter `href`; expose `endpoint: /api/sources/apkomik/chapter/${encodeURIComponent(href)}`.
- `getPages(slug, chapter, server=1)` → reuse `KomikindoSource.getPages` logic: if `slug` is a full URL use it; else resolve the chapter href from `getDetails`. Fetch, extract `ts_reader.run` JSON via regex, pick `sources[server-1].images`, map to `{page, url, directUrl, proxyUrl: /api/proxy/image?url=…}`. Address user message #9 ("chapter 10 instead of 1") by resolving the chapter href from the detail list and matching on the **numeric** `data-num`/`Chapter N` value precisely (parseFloat-equality with the requested number), independent of list order — the list is descending so do not index by position.

### Divergences from `KomikindoSource` that must change (do not copy blindly)
| Concern | Komikindo | apkomik |
|---|---|---|
| Card type selector | `span.typename` | `span.type` |
| Detail status/type | `table.infotable tbody tr` (label/value) | `div.tsinfo div.imptdt` |
| Detail author/year | `table.infotable` rows | `div.flex-wrap div.fmed` (`<b>` label + `<span>`) |
| Genres container | `div.seriestugenre a[rel="tag"]` | `span.mgen a[rel="tag"]` |
| Rating selector | `div.rating .num[itemprop="ratingValue"]` | `.thumbook .rt .rating .numscore` (text) |
| Chapter list | `#chapterlist ul.clstyle > li[data-num]` | `#chapterlist > ul > li[data-num]` (no `clstyle`) |
| Pagination | `div.pagination a.page-numbers` (numbered) | `div.hpage a.r` (Next-only; no maxPage) |
| Types | 3 (manga/manhwa/manhua) | 5 (adds comic, novel) |
| Alt title | not parsed | available (`.wd-full` "Alternative Titles" `span`) |
| Artist | parsed from table | no field — set null |

---

## 8. Gaps / assumptions

- **Year/released** is frequently `"-"` on apkomik detail pages (this manga had none). The source should return `year: null` when absent rather than failing.
- **Genre slug derivation:** `KomikindoSource.getGenres` slugifies the label. On apkomik the `/genres/{slug}/` detail links confirm the real slugs (e.g. "Martial Arts"→`martial-arts`, "Si-fi"→`si-fi`); slugify matches these, but a few labels are lowercase in the form ("apocalypse", "dungeons", "monsters", "sepernatural", "sh", "si-fi") — slugify still produces a usable slug, and since `getByGenre` resolves by **id** (not slug) for the order-respecting query, slug accuracy only matters for the genre-catalog display and the detail-page genre slugs (which come from the `/genres/{slug}/` href, so they are always correct there).
- **maxPage unknown** for `/manga/` listings: acceptable per the route contract; only `hasNextPage` is reported.
- Only one chapter was sampled (`Magic Emperor` ch.930); the `ts_reader.run` shape is the standard Themesia reader contract and matches komikindo, so the same parser is expected to hold across all chapters, but a small set of additional chapters should be sampled during implementation to confirm no `protected`/token-gated variations appear (the JSON includes `"protected":false`, `"is_novel":false`, `"unlock_token":null` fields that indicate gating is possible).
- No manga-listing JSON API was found; if one is desired, `wp-admin/admin-ajax.php` would need an action name reverse-engineered — not needed since HTML scraping covers all endpoints.

---

## Fetch notes (methodology, for traceability)

- Raw HTML was fetched with PowerShell `Invoke-WebRequest` using a Chrome desktop User-Agent
  (`Mozilla/5.0 … Chrome/120 …`) and `Accept-Language: en-US,en;q=0.9`. The site returns **403** to
  the default/no User-Agent, which is why `web_fetch` (text extraction) succeeded but the first
  raw-fetch attempts failed until the UA was set. The project's `httpClient.js` already sets an
  equivalent Chrome UA, so production scraping via `getHtml` is unaffected.
- Pages fetched & inspected: `/`, `/manga/`, `/manga/?order=popular|update|latest`, `/manga/?genre[]=14[&order=…]`, `/manga/?status=completed&order=update`, `/genres/action/[?order=…]`, `/manga/magic-emperor-demonic-emperor/` (detail), `/magic-emperor-demonic-emperor-chapter-930-bahasa-indonesia/` (reader), `/?s=magic` (search), `/page/2/`, `robots.txt`.
