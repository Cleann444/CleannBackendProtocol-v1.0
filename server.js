import { WebSocketServer } from 'ws';
import { LRUCache } from 'lru-cache';
import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { parse } from 'url';
import crypto from 'crypto';

const PORT = process.env.PORT || 8080;
const OBFUSCATION_SECRET = process.env.OBFUSCATION_SECRET || 'change-this-to-a-long-random-string';

function getEncryptionKey() {
  const interval = 10 * 60 * 1000;
  const epoch = Math.floor(Date.now() / interval);
  const derived = crypto.createHash('sha256')
    .update(`${OBFUSCATION_SECRET}:${epoch}`)
    .digest();
  return derived;
}

function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decrypt(ciphertext) {
  const key = getEncryptionKey();
  const iv = ciphertext.subarray(0, 12);
  const authTag = ciphertext.subarray(12, 28);
  const encrypted = ciphertext.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

const cache = new LRUCache({
  max: 5000,
  ttl: 1000 * 60 * 2,
  updateAgeOnGet: true
});

class Predictor {
  transitions = new Map();
  history = [];

  recordTransition(from, to) {
    if (!this.transitions.has(from)) this.transitions.set(from, new Map());
    const map = this.transitions.get(from);
    map.set(to, (map.get(to) || 0) + 1);
  }

  predict(url) {
    const candidates = this.transitions.get(url);
    if (!candidates) return [];
    const sorted = Array.from(candidates.entries()).sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, 3).map(([url]) => url);
  }

  onNavigate(url) {
    if (this.history.length) {
      this.recordTransition(this.history[this.history.length - 1], url);
    }
    this.history.push(url);
    if (this.history.length > 100) this.history.shift();
  }
}
const predictor = new Predictor();

import dns from 'dns/promises';
const dnsCache = new Map();

async function preResolve(hostnames) {
  const unique = [...new Set(hostnames)];
  await Promise.allSettled(unique.map(async (host) => {
    try {
      const addresses = await dns.resolve(host);
      dnsCache.set(host, addresses);
    } catch(e) {}
  }));
}

setInterval(() => {
  const hosts = Array.from(cache.keys())
    .map(url => {
      try { return new URL(url).hostname; } catch { return null; }
    })
    .filter(Boolean)
    .slice(0, 50);
  if (hosts.length) preResolve(hosts);
}, 60000);

function computeDelta(oldBuf, newBuf) {
  if (oldBuf.length !== newBuf.length) return newBuf;
  const diff = Buffer.alloc(oldBuf.length);
  for (let i = 0; i < oldBuf.length; i++) diff[i] = oldBuf[i] ^ newBuf[i];
  return diff;
}

function encodeFrame(id, type, payload) {
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(id, 0);
  header.writeUInt32BE(type, 4);
  return Buffer.concat([header, payload]);
}

function decodeFrame(data) {
  const id = data.readUInt32BE(0);
  const type = data.readUInt32BE(4);
  const payload = data.subarray(8);
  return { id, type, payload };
}

const CF_WORKER_URL = process.env.CF_WORKER_URL || null;

async function fetchViaEdge(url, method, headers, body) {
  if (CF_WORKER_URL) {
    const edgeUrl = `${CF_WORKER_URL}/fetch?url=${encodeURIComponent(url)}`;
    const res = await fetch(edgeUrl, { method, headers, body });
    const buffer = Buffer.from(await res.arrayBuffer());
    const responseHeaders = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });
    return { status: res.status, headers: responseHeaders, body: buffer };
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method || 'GET',
      headers: headers || {}
    };
    const req = lib(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const responseHeaders = {};
        for (const [key, value] of Object.entries(res.headers)) {
          responseHeaders[key] = value;
        }
        resolve({ status: res.statusCode, headers: responseHeaders, body: buffer });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const server = createServer((req, res) => {
  const { pathname } = parse(req.url || '/');
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('CBP Online');
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server });
const pendingRequests = new Map();
let nextId = 0;

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    if (typeof data === 'string') return;
    let decrypted;
    try {
      decrypted = decrypt(data);
    } catch(e) {
      console.error('Decryption failed', e);
      return;
    }
    const { id, type, payload } = decodeFrame(decrypted);
    if (type === 0) {
      const payloadStr = payload.toString();
      let request;
      try {
        request = JSON.parse(payloadStr);
      } catch(e) { return; }
      const { method, url, headers, bodyBase64 } = request;
      const cacheKey = `${method} ${url}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.heat > 3) {
        cached.heat++;
        const responsePayload = JSON.stringify({
          status: cached.status,
          headers: cached.headers,
          bodyBase64: cached.body.toString('base64'),
          cached: true
        });
        const frame = encodeFrame(id, 1, Buffer.from(responsePayload));
        const encrypted = encrypt(frame);
        ws.send(encrypted);
        return;
      }
      try {
        const edgeResult = await fetchViaEdge(url, method, headers, bodyBase64 ? Buffer.from(bodyBase64, 'base64') : null);
        cache.set(cacheKey, {
          body: edgeResult.body,
          headers: edgeResult.headers,
          status: edgeResult.status,
          heat: 1,
          lastHit: Date.now()
        });
        const responsePayload = JSON.stringify({
          status: edgeResult.status,
          headers: edgeResult.headers,
          bodyBase64: edgeResult.body.toString('base64'),
          cached: false
        });
        const frame = encodeFrame(id, 1, Buffer.from(responsePayload));
        const encrypted = encrypt(frame);
        ws.send(encrypted);
        
        const predictions = predictor.predict(url);
        if (predictions.length) {
          const hintFrame = encodeFrame(id, 4, Buffer.from(predictions.join(',')));
          ws.send(encrypt(hintFrame));
          if (CF_WORKER_URL) {
            predictions.forEach(p => fetch(`${CF_WORKER_URL}/fetch?url=${encodeURIComponent(p)}&preload=1`).catch(()=>{}));
          }
        }
      } catch(err) {
        const errorPayload = JSON.stringify({ error: err.message });
        const frame = encodeFrame(id, 1, Buffer.from(errorPayload));
        ws.send(encrypt(frame));
      }
    }
  });
  ws.on('close', () => {});
});

server.listen(PORT, () => {
  console.log(`CBP listening on port ${PORT}`);
});
