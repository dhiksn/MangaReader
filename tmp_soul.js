const { getJson } = require('./src/utils/httpClient');
const headers = { Referer: 'https://s2.soulscans.fit/', Origin: 'https://s2.soulscans.fit' };

// Test 1: list latest
getJson('https://s2.soulscans.fit/api/search?type=COMIC&limit=5&sort=latest&order=desc&page=1', { headers })
  .then(r => {
    console.log('LIST OK, total:', r.total, 'items:', r.data?.length);
    if (r.data?.[0]) {
      const m = r.data[0];
      console.log('Sample cover:', m.poster_image_url);
      console.log('Sample slug:', m.slug);
    }
  })
  .catch(e => console.error('LIST ERROR:', e.message, e.statusCode));
