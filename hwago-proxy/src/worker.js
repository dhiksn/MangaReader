const TARGET_ORIGIN = 'https://02.hwago.xyz';

// Allowed origins that can call this proxy (set to '*' to allow all)
const ALLOWED_ORIGIN = '*';

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const url = new URL(request.url);

    // Strip the worker's own origin, proxy the rest to hwago
    const targetUrl = `${TARGET_ORIGIN}${url.pathname}${url.search}`;

    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: buildHeaders(request, url),
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow',
    });

    let response;
    try {
      response = await fetch(proxyRequest);
    } catch (err) {
      return jsonError(502, 'Upstream fetch failed: ' + err.message);
    }

    if (!response.ok) {
      return jsonError(response.status, `Upstream returned HTTP ${response.status}`);
    }

    // Stream the body back with original content-type + CORS headers
    const responseHeaders = new Headers(corsHeaders());
    const ct = response.headers.get('content-type');
    if (ct) responseHeaders.set('content-type', ct);

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  },
};

/**
 * Build spoofed browser headers to avoid 403 from hwago.
 */
function buildHeaders(request, url) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    Referer: `${TARGET_ORIGIN}/`,
    Origin: TARGET_ORIGIN,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}
