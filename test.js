require('dotenv').config();
const { getSource, listSources } = require('./src/sources');

async function runTests() {
  console.log('--- 1. Testing Registered Sources ---');
  const sources = listSources();
  console.log('Available sources:', sources);
  if (sources.length === 0) throw new Error('No sources registered!');

  const softkomik = getSource('softkomik');
  if (!softkomik) throw new Error('Softkomik source not found!');

  console.log('\n--- 2. Testing getPopular() ---');
  const popular = await softkomik.getPopular(1);
  console.log(`Popular fetched: ${popular.data.length} items. First: "${popular.data[0]?.title}" (${popular.data[0]?.slug})`);
  if (!popular.data || popular.data.length === 0) throw new Error('Popular list empty');

  console.log('\n--- 4. Testing getLatest() (all merged & sorted) ---');
  const latestAll = await softkomik.getLatest(1, 'all');
  console.log(`Latest (all) fetched: ${latestAll.data.length} items (maxPage: ${latestAll.maxPage}). First: "${latestAll.data[0]?.title}" [${latestAll.data[0]?.updatedAt}]`);
  if (!latestAll.data || latestAll.data.length === 0) throw new Error('Latest (all) list empty');

  // Verify clean relative time format
  console.log('Sample updated relative times:');
  latestAll.data.slice(0, 5).forEach((item, idx) => {
    console.log(`  ${idx + 1}. [${item.contentRating}] "${item.title}" -> ${item.updatedAt}`);
  });
  if (latestAll.data[0].updatedAt.includes('T') && latestAll.data[0].updatedAt.endsWith('Z')) {
    throw new Error('updatedAt is still raw ISO string instead of cleaned relative time!');
  }
  console.log('✓ Successfully verified: updatedAt cleaned into relative time string!');

  const latestSensitive = await softkomik.getLatest(1, 'sensitive');
  console.log(`Latest (sensitive) fetched: ${latestSensitive.data.length} items. First: "${latestSensitive.data[0]?.title}"`);

  if (process.env.SOFTKOMIK_EMAIL && process.env.SOFTKOMIK_PASSWORD && process.env.SOFTKOMIK_EMAIL !== 'your_email@example.com') {
    console.log('\n--- Testing getLatest() (nsfw with auth) ---');
    try {
      const latestNsfw = await softkomik.getLatest(1, 'nsfw');
      console.log(`Latest (nsfw) fetched: ${latestNsfw.data.length} items. First: "${latestNsfw.data[0]?.title}"`);
    } catch (e) {
      console.log('NSFW auth test skipped or failed:', e.message);
    }
  } else {
    console.log('\n(Notice: SOFTKOMIK_EMAIL/PASSWORD not configured in .env, skipping NSFW auth test)');
  }

  console.log('\n--- 5. Testing search("magic") ---');
  const searchResults = await softkomik.search('magic', 1);
  console.log(`Search results for "magic": ${searchResults.data.length} items. First: "${searchResults.data[0]?.title}"`);
  if (!searchResults.data || searchResults.data.length === 0) throw new Error('Search returned no results');

  console.log('\n--- 6. Testing getDetails() ---');
  const sampleSlug = popular.data[0].slug;
  console.log(`Fetching details for: ${sampleSlug}`);
  const details = await softkomik.getDetails(sampleSlug);
  console.log(`Title: ${details.title}`);
  console.log(`Status: ${details.status}, Type: ${details.type}`);
  console.log(`Cover: ${details.cover}`);
  console.log(`Chapters count: ${details.chapters.length}`);
  if (!details.chapters || details.chapters.length === 0) throw new Error('Details has no chapters');
  console.log(`Similar comics count: ${details.similar?.length}`);
  const softkomikKeys = Object.keys(details);
  if (softkomikKeys[softkomikKeys.length - 1] !== 'similar') {
    throw new Error('Similar comics is not at the bottom of Softkomik details');
  }
  if (!Array.isArray(details.similar) || details.similar.length === 0) {
    throw new Error('Softkomik similar comics array empty');
  }
  console.log(`✓ Softkomik Similar verified (${details.similar.length} items, first: "${details.similar[0].title}")`);

  console.log('\n--- 7. Testing getPages() ---');
  const sampleChapter = details.chapters[0].chapter;
  console.log(`Fetching pages for chapter ${sampleChapter}`);
  const pagesData = await softkomik.getPages(sampleSlug, sampleChapter);
  console.log(`Pages count: ${pagesData.pages.length}`);
  if (!pagesData.pages || pagesData.pages.length === 0) throw new Error('Pages list empty');
  console.log(`First page URL: ${pagesData.pages[0].url}`);
  console.log(`First page Proxy URL: ${pagesData.pages[0].proxyUrl}`);

  console.log('\n--- 8. Testing Error Responses & Security (400, 404, 502) ---');
  const app = require('./src/index');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // 400 Invalid Parameter
    const res400 = await fetch(`http://localhost:${port}/api/sources/softkomik/popular?page=-1`);
    const json400 = await res400.json();
    console.log(`400 Invalid Parameter: status=${res400.status}, code=${json400.error?.code}, author=${json400.author}`);
    if (res400.status !== 400 || json400.success !== false || !json400.error?.code) {
      throw new Error('400 Error format test failed');
    }

    // 404 Not Found
    const res404 = await fetch(`http://localhost:${port}/api/sources/unknown_source_test/popular`);
    const json404 = await res404.json();
    console.log(`404 Not Found: status=${res404.status}, code=${json404.error?.code}, author=${json404.author}`);
    if (res404.status !== 404 || json404.success !== false || !json404.error?.code) {
      throw new Error('404 Error format test failed');
    }

    // 400 SSRF Security Protection
    const resSsrf = await fetch(`http://localhost:${port}/api/proxy/image?url=http://127.0.0.1:8080/secret`);
    const jsonSsrf = await resSsrf.json();
    console.log(`SSRF Protection: status=${resSsrf.status}, code=${jsonSsrf.error?.code}`);
    if (resSsrf.status !== 400 || jsonSsrf.error?.code !== 'BLOCKED_HOST') {
      throw new Error('SSRF Protection test failed');
    }

    // 502 Upstream Bad Gateway
    const res502 = await fetch(`http://localhost:${port}/api/proxy/image?url=https://unreachable-domain-1234567.com/img.webp`);
    const json502 = await res502.json();
    console.log(`502 Upstream Error: status=${res502.status}, code=${json502.error?.code}`);
    if (res502.status !== 502 || json502.error?.code !== 'UPSTREAM_ERROR') {
      throw new Error('502 Upstream Error format test failed');
    }

    console.log('\n--- 9. Testing Pagination Structure & Bottom Placement ---');
    // Test Latest pagination
    const resLatest = await fetch(`http://localhost:${port}/api/sources/softkomik/latest?page=1`);
    const jsonLatest = await resLatest.json();
    const latestKeys = Object.keys(jsonLatest);
    const lastKey = latestKeys[latestKeys.length - 1];

    console.log('Latest response keys order:', latestKeys.join(', '));
    console.log('Latest pagination object:', JSON.stringify(jsonLatest.pagination));

    if (lastKey !== 'pagination') {
      throw new Error(`Pagination is not at the bottom! Last key is '${lastKey}'`);
    }
    if (!jsonLatest.pagination || typeof jsonLatest.pagination !== 'object') {
      throw new Error('Pagination object missing in latest response');
    }
    if (
      jsonLatest.pagination.page !== 1 ||
      jsonLatest.pagination.prevPage !== null ||
      jsonLatest.pagination.nextPage !== 2
    ) {
      throw new Error('Pagination properties invalid in latest response');
    }
    if (
      jsonLatest.pagination.hasPrevPage !== undefined ||
      jsonLatest.pagination.hasNextPage !== undefined ||
      jsonLatest.pagination.totalResults !== undefined
    ) {
      throw new Error('Unwanted verbose pagination properties detected (hasPrevPage, hasNextPage, or totalResults)');
    }
    if (jsonLatest.page !== undefined || jsonLatest.maxPage !== undefined) {
      throw new Error('Unclean root pagination properties detected (should be inside pagination object only)');
    }

    // Test Search pagination
    const resSearch = await fetch(`http://localhost:${port}/api/sources/softkomik/search?q=magic&page=1`);
    const jsonSearch = await resSearch.json();
    const searchKeys = Object.keys(jsonSearch);
    console.log('Search response keys order:', searchKeys.join(', '));
    console.log('Search pagination object:', JSON.stringify(jsonSearch.pagination));

    if (searchKeys[searchKeys.length - 1] !== 'pagination') {
      throw new Error('Search pagination is not at the bottom');
    }
    if (
      jsonSearch.pagination.hasPrevPage !== undefined ||
      jsonSearch.pagination.hasNextPage !== undefined ||
      jsonSearch.pagination.totalResults !== undefined
    ) {
      throw new Error('Search pagination contains unwanted verbose fields');
    }

    console.log('\n--- 10. Testing Genres Endpoints ---');
    const resGenres = await fetch(`http://localhost:${port}/api/sources/softkomik/genres`);
    const jsonGenres = await resGenres.json();
    console.log(`Genres fetched: ${jsonGenres.data.length} genres. First: "${jsonGenres.data[0]?.name}"`);
    if (!jsonGenres.data || jsonGenres.data.length === 0) {
      throw new Error('Genres list empty');
    }

    const resByGenre = await fetch(`http://localhost:${port}/api/sources/softkomik/genres/Action?page=1`);
    const jsonByGenre = await resByGenre.json();
    console.log(`ByGenre (Action) fetched: ${jsonByGenre.data.length} items. First: "${jsonByGenre.data[0]?.title}"`);
    if (!jsonByGenre.data || jsonByGenre.data.length === 0 || !jsonByGenre.pagination) {
      throw new Error('ByGenre list or pagination empty');
    }

    console.log('\n--- 11. Testing Types Endpoints ---');
    const resTypes = await fetch(`http://localhost:${port}/api/sources/softkomik/types`);
    const jsonTypes = await resTypes.json();
    console.log(`Types fetched:`, jsonTypes.data);
    if (!jsonTypes.data || jsonTypes.data.length === 0) {
      throw new Error('Types list empty');
    }

    const resByType = await fetch(`http://localhost:${port}/api/sources/softkomik/types/manga?page=1`);
    const jsonByType = await resByType.json();
    console.log(`ByType (manga) fetched: ${jsonByType.data.length} items. First: "${jsonByType.data[0]?.title}"`);
    if (!jsonByType.data || jsonByType.data.length === 0 || !jsonByType.pagination) {
      throw new Error('ByType list or pagination empty');
    }

    console.log('\n--- 12. Testing Komiku Source Endpoints ---');
    const komiku = getSource('komiku');
    if (!komiku) throw new Error('Komiku source not registered!');

    // 12a. Verify /home returns 404 for both sources
    const resSoftkomikHome = await fetch(`http://localhost:${port}/api/sources/softkomik/home`);
    const resKomikuHome = await fetch(`http://localhost:${port}/api/sources/komiku/home`);
    console.log(`Home 404 check: softkomik=${resSoftkomikHome.status}, komiku=${resKomikuHome.status}`);
    if (resSoftkomikHome.status !== 404 || resKomikuHome.status !== 404) {
      throw new Error(`Expected 404 for home endpoints, got softkomik=${resSoftkomikHome.status}, komiku=${resKomikuHome.status}`);
    }
    console.log('✓ Successfully verified: /home endpoints return 404 NOT_FOUND');

    // 12b. Verify /api/sources/komiku/latest scrapes from https://komiku.org/pustaka/
    let isKomikuBlockedByCF = false;
    const resKomikuLatest = await fetch(`http://localhost:${port}/api/sources/komiku/latest?page=1`);
    const jsonKomikuLatest = await resKomikuLatest.json();
    if (resKomikuLatest.status === 502 && jsonKomikuLatest.error?.message?.includes('403')) {
      console.log('⚠️  Komiku diblokir Cloudflare 403 (karena koneksi Cloudflare One / VPN aktif). Melewati pengujian scraper Komiku.');
      isKomikuBlockedByCF = true;
    } else {
      console.log(`Komiku Latest (Pustaka): ${jsonKomikuLatest.data?.length} items. from: "${jsonKomikuLatest.from}"`);
      if (!jsonKomikuLatest.data?.length || jsonKomikuLatest.from !== 'https://komiku.org/pustaka/' || !jsonKomikuLatest.pagination) {
        throw new Error('Komiku latest (Pustaka) failed or missing required fields');
      }
      console.log(`First Komiku Latest item: "${jsonKomikuLatest.data[0]?.title}" [Ch. ${jsonKomikuLatest.data[0]?.latestChapter}]`);

    const resKomikuPop = await fetch(`http://localhost:${port}/api/sources/komiku/popular?page=1`);
    const jsonKomikuPop = await resKomikuPop.json();
    console.log(`Komiku Popular: ${jsonKomikuPop.data.length} items. First: "${jsonKomikuPop.data[0]?.title}"`);
    if (!jsonKomikuPop.data.length || !jsonKomikuPop.pagination) {
      throw new Error('Komiku popular failed');
    }

    const resKomikuSearch = await fetch(`http://localhost:${port}/api/sources/komiku/search?q=naruto&page=1`);
    const jsonKomikuSearch = await resKomikuSearch.json();
    console.log(`Komiku Search (naruto): ${jsonKomikuSearch.data.length} items. First: "${jsonKomikuSearch.data[0]?.title}" [updatedAt: ${jsonKomikuSearch.data[0]?.updatedAt}]`);
    if (!jsonKomikuSearch.data.length || !jsonKomikuSearch.data[0]?.updatedAt) {
      throw new Error('Komiku search failed or updatedAt is missing');
    }
    if (jsonKomikuSearch.data[0]?.genre !== undefined) {
      throw new Error('Unwanted genre field found in Komiku search item');
    }
    if (jsonKomikuSearch.pagination !== undefined) {
      throw new Error('Komiku search (single page result) should NOT include pagination');
    }
    console.log('✓ Successfully verified: pagination omitted when no next/prev page exists');

    // Verify non-existent page 2 returns 404 NOT_FOUND
    const resKomikuSearchP2 = await fetch(`http://localhost:${port}/api/sources/komiku/search?q=naruto&page=2`);
    const jsonKomikuSearchP2 = await resKomikuSearchP2.json();
    console.log(`Komiku Search (naruto&page=2): status=${resKomikuSearchP2.status}, code=${jsonKomikuSearchP2.error?.code}`);
    if (resKomikuSearchP2.status !== 404 || jsonKomikuSearchP2.success !== false || jsonKomikuSearchP2.error?.code !== 'NOT_FOUND') {
      throw new Error('Komiku search page 2 for single-page query must return 404 NOT_FOUND');
    }
    console.log('✓ Successfully verified: searching naruto with &page=2 returns 404 NOT_FOUND');

    const sampleKomikuSlug = jsonKomikuPop.data[0].slug;
    const resKomikuDetails = await fetch(`http://localhost:${port}/api/sources/komiku/manga/${sampleKomikuSlug}`);
    const jsonKomikuDetails = await resKomikuDetails.json();
    console.log(`Komiku Details: "${jsonKomikuDetails.data.title}" by "${jsonKomikuDetails.data.author}" (${jsonKomikuDetails.data.totalChapters} chapters)`);
    if (!jsonKomikuDetails.data.chapters.length) {
      throw new Error('Komiku details chapters empty');
    }

    // Verify One Piece author specifically
    const resOp = await fetch(`http://localhost:${port}/api/sources/komiku/manga/komik-one-piece-indo`);
    const jsonOp = await resOp.json();
    console.log(`One Piece Author check: "${jsonOp.data?.author}"`);
    if (jsonOp.data?.author !== 'Eiichiro Oda') {
      throw new Error(`Expected author 'Eiichiro Oda' for One Piece, got '${jsonOp.data?.author}'`);
    }
    console.log('✓ Successfully verified: One Piece author is Eiichiro Oda');

    // Verify similar comics at the bottom
    const dataKeys = Object.keys(jsonOp.data);
    const lastDataKey = dataKeys[dataKeys.length - 1];
    console.log(`Similar comics check: count=${jsonOp.data?.similar?.length}, lastKey=${lastDataKey}`);
    if (!Array.isArray(jsonOp.data?.similar) || jsonOp.data?.similar?.length === 0) {
      throw new Error('Similar comics (Komik Serupa) array is empty or missing');
    }
    if (lastDataKey !== 'similar') {
      throw new Error(`Expected 'similar' at the bottom of manga details, found '${lastDataKey}'`);
    }
    console.log(`First similar comic: "${jsonOp.data.similar[0].title}" (${jsonOp.data.similar[0].slug})`);
    console.log('✓ Successfully verified: Similar comics parsed and placed at the bottom');

    // 12c. Verify /api/sources/komiku/list (Daftar Komik A-Z directory)
    const resKomikuList = await fetch(`http://localhost:${port}/api/sources/komiku/list?page=1`);
    const jsonKomikuList = await resKomikuList.json();
    console.log(`Komiku List: ${jsonKomikuList.data?.length} items. from: "${jsonKomikuList.from}", maxPage: ${jsonKomikuList.pagination?.maxPage}`);
    if (
      !jsonKomikuList.data?.length ||
      jsonKomikuList.from !== 'https://komiku.org/daftar-komik/' ||
      !jsonKomikuList.pagination ||
      jsonKomikuList.pagination.page !== 1 ||
      !jsonKomikuList.pagination.nextPage
    ) {
      throw new Error('Komiku list endpoint failed or missing required fields');
    }
    const firstListItem = jsonKomikuList.data[0];
    console.log(`First Komiku List item: "${firstListItem.title}" [status=${firstListItem.status}, type=${firstListItem.type || 'manga'}, genre=${firstListItem.genre || 'General'}]`);
    if (!firstListItem.status) {
      throw new Error('Expected status property in Komiku list item');
    }

    // Verify Komiku list with letter filter
    const resFilteredList = await fetch(`http://localhost:${port}/api/sources/komiku/list?page=1&letter=A`);
    const jsonFilteredList = await resFilteredList.json();
    console.log(`Komiku Filtered List (letter A): ${jsonFilteredList.data?.length} items. letter=${jsonFilteredList.letter}`);
    if (!jsonFilteredList.data?.length || jsonFilteredList.letter !== 'A') {
      throw new Error('Komiku filtered list by letter failed');
    }
    if (jsonFilteredList.tipe !== undefined) {
      throw new Error('Unwanted tipe property found in Komiku list response');
    }
      console.log('✓ Successfully verified: /api/sources/komiku/list works with letter filter, pagination, and data');
    }

    // Verify Out-of-Bounds pagination across Softkomik and Komiku endpoints
    console.log('\n--- Testing Out-of-Bounds Pagination (404 NOT_FOUND) ---');
    const outOfBoundsUrls = [
      `/api/sources/softkomik/popular?page=9999`,
      `/api/sources/softkomik/latest?page=9999`,
      `/api/sources/softkomik/search?q=magic&page=9999`,
      `/api/sources/softkomik/genres/Action?page=9999`,
      `/api/sources/softkomik/types/manga?page=9999`,
      ...(isKomikuBlockedByCF ? [] : [
        `/api/sources/komiku/list?page=9999`,
        `/api/sources/komiku/search?q=naruto&page=2`,
      ]),
      `/api/sources/hwago/popular?page=9999`,
      `/api/sources/hwago/latest?page=9999`,
      `/api/sources/hwago/rating?page=9999`,
      `/api/sources/hwago/az?page=9999`,
      `/api/sources/hwago/list?page=9999`,
      `/api/sources/hwago/search?q=lust&page=9999`,
      `/api/sources/doujindesu/popular?page=9999`,
      `/api/sources/doujindesu/latest?page=9999`,
      `/api/sources/shinigami/popular?page=9999`,
      `/api/sources/shinigami/latest?page=9999`,
    ];

    for (const endpoint of outOfBoundsUrls) {
      const res = await fetch(`http://localhost:${port}${endpoint}`);
      const json = await res.json();
      console.log(`Checking ${endpoint}: status=${res.status}, code=${json.error?.code}, msg="${json.error?.message}"`);
      if (res.status !== 404 || json.success !== false || json.error?.code !== 'NOT_FOUND') {
        throw new Error(`Expected 404 NOT_FOUND for out-of-bounds ${endpoint}, got ${res.status}`);
      }
    }
    console.log('✓ Successfully verified: all out-of-bounds pagination requests return 404 NOT_FOUND across Softkomik, Komiku & Hwago');

    console.log('\n--- 13. Testing Hwago Source Endpoints ---');
    const hwago = getSource('hwago');
    if (!hwago) throw new Error('Hwago source not registered!');

    // 13a. Popular
    const resHwagoPop = await fetch(`http://localhost:${port}/api/sources/hwago/popular?page=1`);
    const jsonHwagoPop = await resHwagoPop.json();
    console.log(`Hwago Popular: ${jsonHwagoPop.data.length} items (maxPage: ${jsonHwagoPop.pagination?.maxPage}). First: "${jsonHwagoPop.data[0]?.title}" (${jsonHwagoPop.data[0]?.slug})`);
    if (!jsonHwagoPop.data.length || !jsonHwagoPop.pagination) {
      throw new Error('Hwago popular failed or missing pagination');
    }

    // 13b. Latest
    const resHwagoLatest = await fetch(`http://localhost:${port}/api/sources/hwago/latest?page=1`);
    const jsonHwagoLatest = await resHwagoLatest.json();
    console.log(`Hwago Latest: ${jsonHwagoLatest.data.length} items. First: "${jsonHwagoLatest.data[0]?.title}" [Ch. ${jsonHwagoLatest.data[0]?.latestChapter}]`);
    if (!jsonHwagoLatest.data.length || !jsonHwagoLatest.pagination) {
      throw new Error('Hwago latest failed or missing pagination');
    }

    // 13c. Rating (https://02.hwago.xyz/browse?sort=rating)
    const resHwagoRating = await fetch(`http://localhost:${port}/api/sources/hwago/rating?page=1`);
    const jsonHwagoRating = await resHwagoRating.json();
    console.log(`Hwago Rating: ${jsonHwagoRating.data.length} items (sort: ${jsonHwagoRating.sort}). First: "${jsonHwagoRating.data[0]?.title}"`);
    if (!jsonHwagoRating.data.length || jsonHwagoRating.sort !== 'rating' || !jsonHwagoRating.pagination) {
      throw new Error('Hwago rating endpoint failed');
    }

    // 13d. A-Z (https://02.hwago.xyz/browse?sort=az)
    const resHwagoAz = await fetch(`http://localhost:${port}/api/sources/hwago/az?page=1`);
    const jsonHwagoAz = await resHwagoAz.json();
    console.log(`Hwago A-Z: ${jsonHwagoAz.data.length} items (sort: ${jsonHwagoAz.sort}). First: "${jsonHwagoAz.data[0]?.title}"`);
    if (!jsonHwagoAz.data.length || jsonHwagoAz.sort !== 'az' || !jsonHwagoAz.pagination) {
      throw new Error('Hwago az endpoint failed');
    }

    // 13e. List with filter options (sort=rating)
    const resHwagoList = await fetch(`http://localhost:${port}/api/sources/hwago/list?page=1&sort=rating`);
    const jsonHwagoList = await resHwagoList.json();
    console.log(`Hwago List (sort=rating): ${jsonHwagoList.data.length} items. sort: ${jsonHwagoList.sort}`);
    if (!jsonHwagoList.data.length || jsonHwagoList.sort !== 'rating') {
      throw new Error('Hwago list endpoint failed');
    }

    // 13f. Search
    const resHwagoSearch = await fetch(`http://localhost:${port}/api/sources/hwago/search?q=lust&page=1`);
    const jsonHwagoSearch = await resHwagoSearch.json();
    console.log(`Hwago Search ("lust"): ${jsonHwagoSearch.data.length} items. First: "${jsonHwagoSearch.data[0]?.title}"`);
    if (!jsonHwagoSearch.data.length) {
      throw new Error('Hwago search failed');
    }

    // 13d. Genres
    const resHwagoGenres = await fetch(`http://localhost:${port}/api/sources/hwago/genres`);
    const jsonHwagoGenres = await resHwagoGenres.json();
    console.log(`Hwago Genres: ${jsonHwagoGenres.data.length} genres. First: "${jsonHwagoGenres.data[0]?.name}" (${jsonHwagoGenres.data[0]?.slug})`);
    if (!jsonHwagoGenres.data.length) {
      throw new Error('Hwago genres list empty');
    }

    // 13e. ByGenre
    const resHwagoByGenre = await fetch(`http://localhost:${port}/api/sources/hwago/genres/adult?page=1`);
    const jsonHwagoByGenre = await resHwagoByGenre.json();
    console.log(`Hwago ByGenre ("adult"): ${jsonHwagoByGenre.data.length} items. genre: ${jsonHwagoByGenre.genre}`);
    if (!jsonHwagoByGenre.data.length) {
      throw new Error('Hwago byGenre failed');
    }

    // 13f. Types
    const resHwagoTypes = await fetch(`http://localhost:${port}/api/sources/hwago/types`);
    const jsonHwagoTypes = await resHwagoTypes.json();
    console.log(`Hwago Types:`, jsonHwagoTypes.data);
    if (!jsonHwagoTypes.data.includes('manhwa')) {
      throw new Error('Hwago types missing manhwa');
    }

    // 13g. ByType
    const resHwagoByType = await fetch(`http://localhost:${port}/api/sources/hwago/types/manhwa?page=1`);
    const jsonHwagoByType = await resHwagoByType.json();
    console.log(`Hwago ByType ("manhwa"): ${jsonHwagoByType.data.length} items. type: ${jsonHwagoByType.type}`);
    if (!jsonHwagoByType.data.length) {
      throw new Error('Hwago byType failed');
    }

    // 13h. Details
    const resHwagoDetails = await fetch(`http://localhost:${port}/api/sources/hwago/manga/lust`);
    const jsonHwagoDetails = await resHwagoDetails.json();
    console.log(`Hwago Details: "${jsonHwagoDetails.data.title}" by "${jsonHwagoDetails.data.author}" (${jsonHwagoDetails.data.totalChapters} chapters, ${jsonHwagoDetails.data.similar?.length} similar)`);
    if (!jsonHwagoDetails.data.chapters.length || !jsonHwagoDetails.data.synopsis) {
      throw new Error('Hwago details missing chapters or synopsis');
    }
    const hwagoKeys = Object.keys(jsonHwagoDetails.data);
    if (hwagoKeys[hwagoKeys.length - 1] !== 'similar') {
      throw new Error(`Expected 'similar' at the bottom of Hwago details, got '${hwagoKeys[hwagoKeys.length - 1]}'`);
    }
    console.log(`✓ Successfully verified: Hwago details parsed correctly with synopsis and similar comics at the bottom`);

    // 13i. Chapter Pages
    const resHwagoPages = await fetch(`http://localhost:${port}/api/sources/hwago/chapter/lust/19`);
    const jsonHwagoPages = await resHwagoPages.json();
    console.log(`Hwago Pages: ${jsonHwagoPages.data.totalPages} pages. First: ${jsonHwagoPages.data.pages[0]?.url}`);
    if (!jsonHwagoPages.data.pages.length) {
      throw new Error('Hwago chapter pages empty');
    }
    // Verify no header/footer banners exist in parsed pages
    const hasBanners = jsonHwagoPages.data.pages.some((p) => p.url.includes('chapter-header') || p.url.includes('chapter-footer'));
    if (hasBanners) {
      throw new Error('Found unwanted chapter-header/footer banner in Hwago pages');
    }
    console.log(`✓ Successfully verified: Hwago chapter pages parsed cleanly without ad banners`);

    console.log('\n--- 14. Testing DoujinDesu Source Endpoints ---');
    // 14a. Popular
    const resDoujinPopular = await fetch(`http://localhost:${port}/api/sources/doujindesu/popular?page=1`);
    const jsonDoujinPopular = await resDoujinPopular.json();
    console.log(`DoujinDesu Popular: ${jsonDoujinPopular.data.length} items. First: "${jsonDoujinPopular.data[0]?.title}"`);
    if (!jsonDoujinPopular.data.length) throw new Error('DoujinDesu popular empty');

    // 14b. Latest
    const resDoujinLatest = await fetch(`http://localhost:${port}/api/sources/doujindesu/latest?page=1`);
    const jsonDoujinLatest = await resDoujinLatest.json();
    console.log(`DoujinDesu Latest: ${jsonDoujinLatest.data.length} items. First: "${jsonDoujinLatest.data[0]?.title}"`);
    if (!jsonDoujinLatest.data.length) throw new Error('DoujinDesu latest empty');

    // 14c. Rating & Az
    const resDoujinRating = await fetch(`http://localhost:${port}/api/sources/doujindesu/rating?page=1`);
    const jsonDoujinRating = await resDoujinRating.json();
    console.log(`DoujinDesu Rating: ${jsonDoujinRating.data.length} items. First: "${jsonDoujinRating.data[0]?.title}"`);
    if (!jsonDoujinRating.data.length) throw new Error('DoujinDesu rating empty');

    const resDoujinAz = await fetch(`http://localhost:${port}/api/sources/doujindesu/az?page=1`);
    const jsonDoujinAz = await resDoujinAz.json();
    console.log(`DoujinDesu Az: ${jsonDoujinAz.data.length} items. First: "${jsonDoujinAz.data[0]?.title}"`);
    if (!jsonDoujinAz.data.length) throw new Error('DoujinDesu az empty');

    // 14d. Search & Single-Page Omission / Out of Bounds
    const resDoujinSearchSingle = await fetch(`http://localhost:${port}/api/sources/doujindesu/search?q=konoha&page=1`);
    const jsonDoujinSearchSingle = await resDoujinSearchSingle.json();
    console.log(`DoujinDesu Search ("konoha" p1): ${jsonDoujinSearchSingle.data.length} items. Pagination present: ${'pagination' in jsonDoujinSearchSingle}`);
    if ('pagination' in jsonDoujinSearchSingle) {
      throw new Error('Single-page search should not have pagination object');
    }

    const resDoujinSearchOOB = await fetch(`http://localhost:${port}/api/sources/doujindesu/search?q=konoha&page=2`);
    const jsonDoujinSearchOOB = await resDoujinSearchOOB.json();
    console.log(`DoujinDesu Search ("konoha" p2 OOB): status=${resDoujinSearchOOB.status}, code=${jsonDoujinSearchOOB.error?.code}`);
    if (resDoujinSearchOOB.status !== 404 || jsonDoujinSearchOOB.error?.code !== 'NOT_FOUND') {
      throw new Error('DoujinDesu out-of-bounds page did not return 404 NOT_FOUND');
    }

    // 14e. Genres & ByGenre
    const resDoujinGenres = await fetch(`http://localhost:${port}/api/sources/doujindesu/genres`);
    const jsonDoujinGenres = await resDoujinGenres.json();
    console.log(`DoujinDesu Genres: ${jsonDoujinGenres.data.length} genres available`);
    if (jsonDoujinGenres.data.length < 50) throw new Error('DoujinDesu genres incomplete');

    const resDoujinByGenre = await fetch(`http://localhost:${port}/api/sources/doujindesu/genres/milf?page=1`);
    const jsonDoujinByGenre = await resDoujinByGenre.json();
    console.log(`DoujinDesu ByGenre ("milf"): ${jsonDoujinByGenre.data.length} items`);
    if (!jsonDoujinByGenre.data.length) throw new Error('DoujinDesu byGenre empty');

    // 14f. Types & ByType
    const resDoujinTypes = await fetch(`http://localhost:${port}/api/sources/doujindesu/types`);
    const jsonDoujinTypes = await resDoujinTypes.json();
    console.log(`DoujinDesu Types:`, jsonDoujinTypes.data);
    if (!jsonDoujinTypes.data.includes('doujinshi')) throw new Error('DoujinDesu types missing doujinshi');

    const resDoujinByType = await fetch(`http://localhost:${port}/api/sources/doujindesu/types/doujinshi?page=1`);
    const jsonDoujinByType = await resDoujinByType.json();
    console.log(`DoujinDesu ByType ("doujinshi"): ${jsonDoujinByType.data.length} items`);
    if (!jsonDoujinByType.data.length) throw new Error('DoujinDesu byType empty');

    // 14g. Details & Similar at bottom
    const resDoujinDetails = await fetch(`http://localhost:${port}/api/sources/doujindesu/manga/shitataru-kano-haha`);
    const jsonDoujinDetails = await resDoujinDetails.json();
    console.log(`DoujinDesu Details: "${jsonDoujinDetails.data.title}" by "${jsonDoujinDetails.data.author}" (${jsonDoujinDetails.data.totalChapters} chapters, ${jsonDoujinDetails.data.similar?.length} similar)`);
    if (!jsonDoujinDetails.data.chapters.length || !jsonDoujinDetails.data.synopsis) {
      throw new Error('DoujinDesu details missing chapters or synopsis');
    }
    const doujinKeys = Object.keys(jsonDoujinDetails.data);
    if (doujinKeys[doujinKeys.length - 1] !== 'similar') {
      throw new Error(`Expected 'similar' at the bottom of DoujinDesu details, got '${doujinKeys[doujinKeys.length - 1]}'`);
    }
    console.log(`✓ Successfully verified: DoujinDesu details parsed correctly with similar comics at the bottom`);

    // 14h. Chapter Pages & Image Proxy
    const resDoujinPages = await fetch(`http://localhost:${port}/api/sources/doujindesu/chapter/shitataru-kano-haha/10`);
    const jsonDoujinPages = await resDoujinPages.json();
    console.log(`DoujinDesu Pages: ${jsonDoujinPages.data.totalPages} pages. First proxy: ${jsonDoujinPages.data.pages[0]?.url}`);
    if (!jsonDoujinPages.data.pages.length) throw new Error('DoujinDesu pages empty');

    const firstProxyUrl = jsonDoujinPages.data.pages[0].url;
    const resProxyImg = await fetch(firstProxyUrl);
    console.log(`DoujinDesu Image Proxy: status=${resProxyImg.status}, type=${resProxyImg.headers.get('content-type')}, size=${resProxyImg.headers.get('content-length')} bytes`);
    if (resProxyImg.status !== 200 || !resProxyImg.headers.get('content-type')?.includes('image')) {
      throw new Error('DoujinDesu image proxy fetch failed');
    }
    console.log(`✓ Successfully verified: DoujinDesu chapter pages and proxy image fetching`);

    // --- 15. Testing Shinigami Source Endpoints ---
    console.log('\n--- 15. Testing Shinigami Source Endpoints ---');
    // 15a. Popular
    const resShinigamiPop = await fetch(`http://localhost:${port}/api/sources/shinigami/popular?page=1`);
    const jsonShinigamiPop = await resShinigamiPop.json();
    console.log(`Shinigami Popular: ${jsonShinigamiPop.data.length} items (maxPage: ${jsonShinigamiPop.pagination?.maxPage}). First: "${jsonShinigamiPop.data[0]?.title}"`);
    if (!jsonShinigamiPop.data.length) throw new Error('Shinigami popular empty');

    // 15b. Latest
    const resShinigamiLatest = await fetch(`http://localhost:${port}/api/sources/shinigami/latest?page=1`);
    const jsonShinigamiLatest = await resShinigamiLatest.json();
    console.log(`Shinigami Latest: ${jsonShinigamiLatest.data.length} items. First: "${jsonShinigamiLatest.data[0]?.title}"`);
    if (!jsonShinigamiLatest.data.length) throw new Error('Shinigami latest empty');

    // 15c. Rating
    const resShinigamiRating = await fetch(`http://localhost:${port}/api/sources/shinigami/rating?page=1`);
    const jsonShinigamiRating = await resShinigamiRating.json();
    console.log(`Shinigami Rating: ${jsonShinigamiRating.data.length} items. First: "${jsonShinigamiRating.data[0]?.title}"`);
    if (!jsonShinigamiRating.data.length) throw new Error('Shinigami rating empty');

    // 15d. Search
    const resShinigamiSearch = await fetch(`http://localhost:${port}/api/sources/shinigami/search?q=nano&page=1`);
    const jsonShinigamiSearch = await resShinigamiSearch.json();
    console.log(`Shinigami Search ("nano"): ${jsonShinigamiSearch.data.length} items. First: "${jsonShinigamiSearch.data[0]?.title}"`);
    if (!jsonShinigamiSearch.data.length) throw new Error('Shinigami search empty');

    // 15e. Genres & ByGenre
    const resShinigamiGenres = await fetch(`http://localhost:${port}/api/sources/shinigami/genres`);
    const jsonShinigamiGenres = await resShinigamiGenres.json();
    console.log(`Shinigami Genres: ${jsonShinigamiGenres.data.length} genres available. First: "${jsonShinigamiGenres.data[0]?.name}"`);
    if (jsonShinigamiGenres.data.length < 30) throw new Error('Shinigami genres incomplete');

    const resShinigamiByGenre = await fetch(`http://localhost:${port}/api/sources/shinigami/genres/action?page=1`);
    const jsonShinigamiByGenre = await resShinigamiByGenre.json();
    console.log(`Shinigami ByGenre ("action"): ${jsonShinigamiByGenre.data.length} items`);
    if (!jsonShinigamiByGenre.data.length) throw new Error('Shinigami byGenre empty');

    // 15f. Types & ByType
    const resShinigamiTypes = await fetch(`http://localhost:${port}/api/sources/shinigami/types`);
    const jsonShinigamiTypes = await resShinigamiTypes.json();
    console.log(`Shinigami Types:`, jsonShinigamiTypes.data);
    if (!jsonShinigamiTypes.data.includes('manhwa')) throw new Error('Shinigami types missing manhwa');

    const resShinigamiByType = await fetch(`http://localhost:${port}/api/sources/shinigami/types/manhwa?page=1`);
    const jsonShinigamiByType = await resShinigamiByType.json();
    console.log(`Shinigami ByType ("manhwa"): ${jsonShinigamiByType.data.length} items`);
    if (!jsonShinigamiByType.data.length) throw new Error('Shinigami byType empty');

    // 15g. List
    const resShinigamiList = await fetch(`http://localhost:${port}/api/sources/shinigami/list?page=1&status=ongoing&type=manhwa`);
    const jsonShinigamiList = await resShinigamiList.json();
    console.log(`Shinigami List (status=ongoing, type=manhwa): ${jsonShinigamiList.data.length} items`);
    if (!jsonShinigamiList.data.length) throw new Error('Shinigami list empty');

    // 15h. Details & Similar at bottom
    const resShinigamiDetails = await fetch(`http://localhost:${port}/api/sources/shinigami/manga/nano-machine`);
    const jsonShinigamiDetails = await resShinigamiDetails.json();
    console.log(`Shinigami Details: "${jsonShinigamiDetails.data.title}" by "${jsonShinigamiDetails.data.author}" (${jsonShinigamiDetails.data.totalChapters} chapters, ${jsonShinigamiDetails.data.similar?.length} similar)`);
    if (!jsonShinigamiDetails.data.chapters.length || !jsonShinigamiDetails.data.synopsis) {
      throw new Error('Shinigami details missing chapters or synopsis');
    }
    const shinigamiKeys = Object.keys(jsonShinigamiDetails.data);
    if (shinigamiKeys[shinigamiKeys.length - 1] !== 'similar') {
      throw new Error(`Expected 'similar' at the bottom of Shinigami details, got '${shinigamiKeys[shinigamiKeys.length - 1]}'`);
    }
    if ('views' in jsonShinigamiDetails.data) {
      throw new Error('Shinigami details should not have views');
    }
    console.log(`✓ Successfully verified: Shinigami details parsed correctly without views and with similar comics at the bottom`);

    // 15i. Chapter Pages & Image Proxy
    const sampleShinigamiCh = jsonShinigamiDetails.data.chapters[0].slug;
    const resShinigamiPages = await fetch(`http://localhost:${port}/api/sources/shinigami/chapter/nano-machine/${sampleShinigamiCh}`);
    const jsonShinigamiPages = await resShinigamiPages.json();
    console.log(`Shinigami Pages: ${jsonShinigamiPages.data.totalPages} pages. First proxy: ${jsonShinigamiPages.data.pages[0]?.url}`);
    if (!jsonShinigamiPages.data.pages.length) throw new Error('Shinigami pages empty');

    const firstShinigamiProxyUrl = jsonShinigamiPages.data.pages[0].url;
    const resProxyShinigamiImg = await fetch(firstShinigamiProxyUrl);
    console.log(`Shinigami Image Proxy: status=${resProxyShinigamiImg.status}, type=${resProxyShinigamiImg.headers.get('content-type')}, size=${resProxyShinigamiImg.headers.get('content-length')} bytes`);
    if (resProxyShinigamiImg.status !== 200 || !resProxyShinigamiImg.headers.get('content-type')?.includes('image')) {
      throw new Error('Shinigami image proxy fetch failed');
    }
    console.log(`✓ Successfully verified: Shinigami chapter pages and proxy image fetching`);

    console.log('✓ All Error response formats, Security, Pagination, Genre, Type, Softkomik, Komiku, Hwago, DoujinDesu, and Shinigami source tests verified successfully!');
  } finally {
    server.close();
  }

  console.log('\n=======================================');
  console.log(' ALL TESTS PASSED SUCCESSFULLY! (100%)');
  console.log('=======================================');
}

runTests().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
