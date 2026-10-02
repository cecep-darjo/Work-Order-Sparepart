#!/usr/bin/env node
/**
 * Proxy LAN untuk EngWO Inventory.
 *
 * Dijalankan di komputer yang punya internet. Komputer lain di jaringan lokal (tanpa internet)
 * cukup membuka  http://<IP-komputer-ini>:8080  di browser:
 *   1) Server menyajikan aplikasi (hasil `node proxy/build-offline.mjs`).
 *   2) Permintaan data (/rest, /auth, /storage, ...) diteruskan ke Supabase.
 *
 * Tanpa dependency: hanya modul bawaan Node 18+.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER, parseEnvFile } from './shared.mjs';

/* ------------------------------------------------------------------ */
/* Konfigurasi                                                         */
/* ------------------------------------------------------------------ */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fileEnv = { ...parseEnvFile(path.join(root, '.env')), ...parseEnvFile(path.join(here, '.env.proxy')) };
const cfg = (key, fallback) => {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === '' ? fallback : v;
};

const SUPABASE_URL = String(cfg('SUPABASE_URL', cfg('VITE_SUPABASE_URL', ''))).trim().replace(/\/+$/, '');
const PORT = Number(cfg('PORT', 8080));
const HOST = cfg('HOST', '0.0.0.0');
const PUBLIC_ORIGIN = String(cfg('PUBLIC_ORIGIN', '')).trim().replace(/\/+$/, '');
const DIST = path.resolve(here, String(cfg('DIST_DIR', '../dist-offline')));
const LOG_REQUESTS = cfg('LOG_REQUESTS', '0') === '1';

if (!/^https?:\/\/[^/]+$/i.test(SUPABASE_URL) || SUPABASE_URL === PLACEHOLDER) {
  console.error(
    '[GAGAL] Alamat Supabase belum benar.\n' +
      '  Isi VITE_SUPABASE_URL di file .env project (contoh: https://abcd1234.supabase.co),\n' +
      '  atau set SUPABASE_URL di proxy/.env.proxy.',
  );
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('[GAGAL] PORT tidak valid.');
  process.exit(1);
}

const up = new URL(SUPABASE_URL);
const upIsHttps = up.protocol === 'https:';
const upPort = Number(up.port || (upIsHttps ? 443 : 80));
const upModule = upIsHttps ? https : http;
const upAgent = new upModule.Agent({ keepAlive: true, maxSockets: 64 });

/** Hanya path Supabase ini yang diteruskan: server ini BUKAN proxy terbuka. */
const PROXY_PREFIXES = ['/rest/v1', '/auth/v1', '/storage/v1', '/realtime/v1', '/functions/v1', '/graphql/v1'];
const isProxied = (url) => {
  const p = String(url).split('?')[0];
  return PROXY_PREFIXES.some((x) => p === x || p.startsWith(x + '/'));
};

const UPSTREAM_TIMEOUT_MS = 120_000;
const MAX_REST_BODY = 50 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function publicOrigin(req) {
  return PUBLIC_ORIGIN || `http://${req.headers.host || `localhost:${PORT}`}`;
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

function sendJson(res, status, obj) {
  sendText(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body terlalu besar'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeStream(stream, encoding) {
  switch (String(encoding || '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return stream.pipe(zlib.createGunzip());
    case 'deflate':
      return stream.pipe(zlib.createInflate());
    case 'br':
      return stream.pipe(zlib.createBrotliDecompress());
    default:
      return stream;
  }
}

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* Penulisan ulang URL file (Storage)                                  */
/* ------------------------------------------------------------------ */
/*
 * Aplikasi menyimpan URL publik file lampiran (foto WO, lampiran GR/PR) ke database.
 * Agar database tetap berisi alamat Supabase asli (bisa dibuka juga oleh pengguna yang
 * mengakses langsung), proxy menerjemahkan:
 *   - jawaban  /rest/v1 : https://xxx.supabase.co/storage/v1/object/...  ->  http://<proxy>/storage/v1/object/...
 *   - kiriman  /rest/v1 : http://<alamat proxy mana pun>/storage/v1/object/... -> https://xxx.supabase.co/storage/v1/object/...
 */
const STORAGE_MARK = '/storage/v1/object/';
const FOREIGN_STORAGE_URL = /https?:\/\/[^/"'\\\s]+(?=\/storage\/v1\/object\/)/g;

function urlsToPublic(text, pub) {
  return text.split(SUPABASE_URL + STORAGE_MARK).join(pub + STORAGE_MARK);
}

function urlsToUpstream(text) {
  return text.replace(FOREIGN_STORAGE_URL, (m) => (m === SUPABASE_URL ? m : SUPABASE_URL));
}

/* ------------------------------------------------------------------ */
/* Proxy HTTP                                                          */
/* ------------------------------------------------------------------ */
function forwardHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (HOP_BY_HOP.has(k) || k === 'host' || k === 'origin' || k === 'referer' || k === 'expect') continue;
    out[k] = v;
  }
  out.host = up.host;
  const prior = incoming['x-forwarded-for'];
  return { headers: out, prior };
}

async function proxyHttp(req, res) {
  const pub = publicOrigin(req);
  const pathOnly = req.url.split('?')[0];
  const isRest = pathOnly === '/rest/v1' || pathOnly.startsWith('/rest/v1/');
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

  const { headers, prior } = forwardHeaders(req.headers);
  const remote = req.socket.remoteAddress ?? '';
  headers['x-forwarded-for'] = prior ? `${prior}, ${remote}` : remote;
  if (isRest) headers['accept-encoding'] = 'identity'; // jawaban REST perlu dibaca untuk ditulis ulang

  let bodyBuf = null;
  if (isRest && hasBody) {
    bodyBuf = await readBody(req, MAX_REST_BODY);
    const ct = String(req.headers['content-type'] || '');
    if (/json|text/i.test(ct) && bodyBuf.includes(STORAGE_MARK)) {
      bodyBuf = Buffer.from(urlsToUpstream(bodyBuf.toString('utf8')), 'utf8');
    }
    headers['content-length'] = String(bodyBuf.length);
    delete headers['transfer-encoding'];
  }

  const preq = upModule.request(
    { protocol: up.protocol, hostname: up.hostname, port: upPort, method: req.method, path: req.url, headers, agent: upAgent },
    async (pres) => {
      try {
        const outHeaders = {};
        for (const [k, v] of Object.entries(pres.headers)) if (!HOP_BY_HOP.has(k)) outHeaders[k] = v;

        const ct = String(pres.headers['content-type'] || '');
        const rewrite =
          isRest && req.method !== 'HEAD' && pres.statusCode !== 204 && pres.statusCode !== 304 && /json|text|csv/i.test(ct);

        if (rewrite) {
          const raw = await collect(decodeStream(pres, pres.headers['content-encoding']));
          const text = raw.toString('utf8');
          const out = text.includes(SUPABASE_URL) ? Buffer.from(urlsToPublic(text, pub), 'utf8') : raw;
          delete outHeaders['content-encoding'];
          delete outHeaders['etag'];
          outHeaders['content-length'] = String(out.length);
          res.writeHead(pres.statusCode ?? 502, outHeaders);
          res.end(out);
        } else {
          res.writeHead(pres.statusCode ?? 502, outHeaders);
          pres.pipe(res);
        }
        if (LOG_REQUESTS) console.log(`${req.method} ${req.url} -> ${pres.statusCode}`);
      } catch (e) {
        console.error('[proxy] gagal memproses jawaban:', e.message);
        sendJson(res, 502, { message: 'Proxy gagal memproses jawaban dari Supabase.' });
      }
    },
  );

  preq.setTimeout(UPSTREAM_TIMEOUT_MS, () => preq.destroy(new Error('timeout menunggu Supabase')));
  preq.on('error', (e) => {
    console.error(`[proxy] ${req.method} ${pathOnly} gagal: ${e.message}`);
    sendJson(res, 502, { message: `Proxy tidak dapat menghubungi Supabase: ${e.message}` });
  });
  res.on('close', () => {
    if (!res.writableFinished) preq.destroy();
  });

  if (bodyBuf) preq.end(bodyBuf);
  else if (hasBody) req.pipe(preq);
  else preq.end();
}

/* ------------------------------------------------------------------ */
/* Proxy WebSocket (Realtime)                                          */
/* ------------------------------------------------------------------ */
function proxyUpgrade(req, socket, head) {
  if (!isProxied(req.url)) {
    socket.destroy();
    return;
  }
  const upSocket = upIsHttps
    ? tls.connect({ host: up.hostname, port: upPort, servername: up.hostname })
    : net.connect({ host: up.hostname, port: upPort });

  upSocket.on(upIsHttps ? 'secureConnect' : 'connect', () => {
    const headers = { ...req.headers, host: up.host };
    delete headers.origin;
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const item of Array.isArray(v) ? v : [v]) raw += `${k}: ${item}\r\n`;
    }
    upSocket.write(raw + '\r\n');
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upSocket.on('error', () => socket.destroy());
  socket.on('error', () => upSocket.destroy());
  socket.on('close', () => upSocket.destroy());
  upSocket.on('close', () => socket.destroy());
}

/* ------------------------------------------------------------------ */
/* File statis (aplikasi)                                              */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map']);
const REWRITTEN = new Set(['.html', '.js', '.mjs']);
const staticCache = new Map();

const statSafe = (f) => fs.promises.stat(f).catch(() => null);

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }

  let file = path.normalize(path.join(DIST, pathname));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return sendText(res, 403, 'Forbidden');

  let st = await statSafe(file);
  if (st?.isDirectory()) {
    file = path.join(file, 'index.html');
    st = await statSafe(file);
  }
  if (!st) {
    // Rute SPA (mis. /workorders) -> index.html; file aset yang hilang -> 404.
    if (path.extname(pathname)) return sendText(res, 404, 'Not found');
    file = path.join(DIST, 'index.html');
    st = await statSafe(file);
  }
  if (!st) {
    return sendText(
      res,
      503,
      'Aplikasi belum dibuild untuk mode offline.\nJalankan di komputer server:  node proxy/build-offline.mjs',
    );
  }

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && COMPRESSIBLE.has(ext);
  const rewrite = REWRITTEN.has(ext);

  if (rewrite || wantsGzip) {
    const pub = publicOrigin(req);
    const key = `${pub}|${file}`;
    let ent = staticCache.get(key);
    if (!ent || ent.mtimeMs !== st.mtimeMs) {
      let buf = await fs.promises.readFile(file);
      if (rewrite) buf = Buffer.from(buf.toString('utf8').split(PLACEHOLDER).join(pub), 'utf8');
      ent = { mtimeMs: st.mtimeMs, buf, gz: COMPRESSIBLE.has(ext) ? zlib.gzipSync(buf) : null };
      if (staticCache.size > 200) staticCache.clear();
      staticCache.set(key, ent);
    }
    const body = wantsGzip && ent.gz ? ent.gz : ent.buf;
    const headers = {
      'content-type': type,
      'content-length': String(body.length),
      'cache-control': rewrite ? 'no-cache' : 'public, max-age=3600',
      vary: 'Accept-Encoding',
    };
    if (body === ent.gz) headers['content-encoding'] = 'gzip';
    res.writeHead(200, headers);
    return req.method === 'HEAD' ? res.end() : res.end(body);
  }

  res.writeHead(200, { 'content-type': type, 'content-length': String(st.size), 'cache-control': 'public, max-age=3600' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ */
/* Health check                                                        */
/* ------------------------------------------------------------------ */
async function health(res) {
  let reachable = false;
  let status = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/health`, { signal: AbortSignal.timeout(5000) });
    reachable = true; // dapat jawaban HTTP apa pun = Supabase terjangkau
    status = r.status;
  } catch {
    /* tidak terjangkau */
  }
  sendJson(res, 200, {
    ok: true,
    upstream: up.host,
    upstreamReachable: reachable,
    upstreamStatus: status,
    appBuilt: fs.existsSync(path.join(DIST, 'index.html')),
  });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  try {
    const p = req.url.split('?')[0];
    if (p === '/__proxy/health') return await health(res);
    if (isProxied(req.url)) return await proxyHttp(req, res);
    return await serveStatic(req, res);
  } catch (e) {
    if (e?.status === 413) return sendJson(res, 413, { message: 'Permintaan terlalu besar.' });
    console.error('[server] error:', e);
    sendText(res, 500, 'Internal Server Error');
  }
});
server.on('upgrade', proxyUpgrade);
server.on('clientError', (_e, socket) => socket.destroy());

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`[GAGAL] Port ${PORT} sudah dipakai. Ganti dengan PORT=xxxx (proxy/.env.proxy).`);
  else console.error('[GAGAL]', e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  console.log('EngWO Inventory - Proxy LAN berjalan');
  console.log(`  Supabase : ${SUPABASE_URL}`);
  console.log(`  Aplikasi : ${DIST}${fs.existsSync(path.join(DIST, 'index.html')) ? '' : '  (BELUM ADA - jalankan: node proxy/build-offline.mjs)'}`);
  console.log('\nBuka dari komputer lain di jaringan yang sama:');
  if (PUBLIC_ORIGIN) console.log(`  ${PUBLIC_ORIGIN}`);
  else if (ips.length) for (const ip of ips) console.log(`  http://${ip}:${PORT}`);
  else console.log(`  http://<IP-komputer-ini>:${PORT}`);
  console.log(`\nCek koneksi : http://localhost:${PORT}/__proxy/health`);
  console.log('Hentikan    : Ctrl + C\n');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nProxy dihentikan.');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
