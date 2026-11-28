const { getJson, getHtml } = require('./src/utils/httpClient');
const headers = { Referer: 'https://s2.soulscans.fit/', Origin: 'https://s2.soulscans.fit' };

// Test 2: cover image access
const https = require('https');
const url = 'https://imgk.soulscans.fit/api/uploads/series/covers/my-god-tier-leveling-system/cover-1efd6eca-1eaa-11f1-9ab1-02420a000b03-ebd9aad3-3ec5-446c-9b59-e57cca106e90.jpg';
const req = https.request(url, { method: 'HEAD', headers: { 'Referer': 'https://s2.soulscans.fit/', 'User-Agent': 'Mozilla/5.0' } }, res => {
  console.log('Cover HEAD status:', res.statusCode, 'CT:', res.headers['content-type']);
});
req.on('error', e => console.error('Cover error:', e.message));
req.end();

// Test 3: icon
const iconUrl = 'https://imgk.soulscans.fit/api/uploads/site-branding/favicon-1783217076495-izt4sc.png';
const req2 = https.request(iconUrl, { method: 'HEAD', headers: { 'Referer': 'https://s2.soulscans.fit/', 'User-Agent': 'Mozilla/5.0' } }, res => {
  console.log('Icon HEAD status:', res.statusCode, 'CT:', res.headers['content-type']);
});
req2.on('error', e => console.error('Icon error:', e.message));
req2.end();

// Test 4: details endpoint
getJson('https://s2.soulscans.fit/api/series/comic/my-god-tier-leveling-system', { headers })
  .then(r => console.log('DETAILS OK, title:', r.title, 'chapters:', r.units?.length))
  .catch(e => console.error('DETAILS ERROR:', e.message, e.statusCode));
