# Cleann Backend Protocol (CBP)

Ultra‑fast proxy backend with predictive preloading, binary WebSocket framing, delta compression, and DNS pre‑resolve.

## Deployment

- Vercel: `vercel --prod`
- Cloudflare Worker: `wrangler deploy worker/index.ts`

## Environment Variables

- `PORT`: (optional) default 8080
- For Cloudflare Worker: bind a KV namespace named `CBP_CACHE`

## Integration

Connect your client using WebSocket at `/cbp`. Send binary frames:
- Header: 4 bytes id (uint32 BE) + 4 bytes type (uint32 BE) + payload
- Type 0: HTTP request (JSON payload: {method, url, headers})
- Type 1: HTTP response (JSON payload: {status, headers, body(base64), cached})

CBP will return preload hints (type 4) automatically.
