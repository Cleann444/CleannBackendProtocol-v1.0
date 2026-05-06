import { WebSocketServer } from 'ws';
import { LRUCache } from 'lru-cache';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { Predictor } from './protocol/predictor.js';
import { DeltaCalculator } from './protocol/delta.js';
import { DNSPreResolver } from './protocol/dns-cache.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const wss = new WebSocketServer({ noServer: true });

interface CacheEntry {
  body: Buffer;
  headers: Record<string, string>;
  status: number;
  heat: number;
  lastHit: number;
}

const cache = new LRUCache<string, CacheEntry>({
  max: 10000,
  ttl: 1000 * 60 * 2,
  updateAgeOnGet: true
});

const predictor = new Predictor();
const deltaCalc = new DeltaCalculator();
const dnsResolver = new DNSPreResolver();

setInterval(() => {
  const topDomains = Array.from(cache.keys())
    .map(url => {
      try { return new URL(url).hostname; } catch { return ''; }
    })
    .filter(Boolean)
    .slice(0, 100);
  dnsResolver.preResolve(topDomains);
}, 60000);

// Simple binary framing (no protobuf to keep deps minimal)
function encodeFrame(id: number, type: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(id, 0);
  header.writeUInt32BE(type, 4);
  return Buffer.concat([header, payload]);
}

function decodeFrame(data: Buffer): { id: number; type: number; payload: Buffer } {
  const id = data.readUInt32BE(0);
  const type = data.readUInt32BE(4);
  const payload = data.subarray(8);
  return { id, type, payload };
}

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    if (typeof data === 'string') return;
    const { id, type, payload } = decodeFrame(data);
    if (type === 0) { // HTTP_REQUEST
      const payloadStr = payload.toString();
      let method, url, headers;
      try {
        const parsed = JSON.parse(payloadStr);
        method = parsed.method;
        url = parsed.url;
        headers = parsed.headers;
      } catch {
        return;
      }
      
      const cacheKey = `${method} ${url}`;
      let entry = cache.get(cacheKey);
      
      if (entry && entry.heat > 3) {
        entry.heat++;
        entry.lastHit = Date.now();
        const responsePayload = JSON.stringify({
          status: entry.status,
          headers: entry.headers,
          body: entry.body.toString('base64'),
          cached: true
        });
        ws.send(encodeFrame(id, 1, Buffer.from(responsePayload)));
        return;
      }
      
      // Fetch from origin via Cloudflare Worker (replace URL later)
      const edgeUrl = `https://cbp-edge-worker.workers.dev/fetch?url=${encodeURIComponent(url)}`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(edgeUrl, { method, headers, signal: controller.signal });
        clearTimeout(timeout);
        const bodyBuffer = Buffer.from(await res.arrayBuffer());
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => { responseHeaders[k] = v; });
        
        cache.set(cacheKey, {
          body: bodyBuffer,
          headers: responseHeaders,
          status: res.status,
          heat: 1,
          lastHit: Date.now()
        });
        
        const responsePayload = JSON.stringify({
          status: res.status,
          headers: responseHeaders,
          body: bodyBuffer.toString('base64'),
          cached: false
        });
        ws.send(encodeFrame(id, 1, Buffer.from(responsePayload)));
        
        const predictions = predictor.predict(url);
        if (predictions.length) {
          const hintPayload = predictions.join(',');
          ws.send(encodeFrame(id, 4, Buffer.from(hintPayload))); // type 4 = PRELOAD_HINT
          Promise.all(predictions.map(p => fetch(`${edgeUrl}&preload=1`).catch(()=>{})));
        }
      } catch (err) {
        const errorPayload = JSON.stringify({ error: String(err) });
        ws.send(encodeFrame(id, 1, Buffer.from(errorPayload)));
      }
    }
  });
});

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const { pathname } = parse(req.url || '/');
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('CBP Online');
    return;
  }
  if (pathname === '/cbp') {
    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`Cleann Backend Protocol listening on port ${PORT}`);
});
