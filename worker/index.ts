export interface Env {
  CBP_CACHE: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/fetch') return new Response('Not found', { status: 404 });
    
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing url', { status: 400 });
    
    const preload = url.searchParams.has('preload');
    const cacheKey = target;
    
    const cached = await env.CBP_CACHE.get(cacheKey, 'json');
    if (cached && !preload) {
      return new Response(cached.body, {
        status: cached.status,
        headers: new Headers(cached.headers),
      });
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(target, { signal: controller.signal });
    clearTimeout(timeout);
    
    const body = await response.text();
    const headers = Object.fromEntries(response.headers);
    delete headers['content-encoding'];
    delete headers['content-length'];
    
    if (!preload) {
      await env.CBP_CACHE.put(cacheKey, JSON.stringify({ body, status: response.status, headers }), {
        expirationTtl: 300
      });
    }
    
    return new Response(body, {
      status: response.status,
      headers: new Headers(headers)
    });
  }
};
