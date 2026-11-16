'use strict';
// Swipe → PC : reçoit sur le PC les photos glissées depuis l'iPhone.
// Lancement : node server.js  (aucune dépendance à installer)

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync, spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 8765;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const MAX_BYTES = 300 * 1024 * 1024;
const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|gif|tiff?|dng)$/i;
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic',
  '.heif': 'image/heif', '.webp': 'image/webp', '.gif': 'image/gif', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.dng': 'image/x-adobe-dng',
};
const EXT_FOR_TYPE = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/heif': '.heif',
  'image/webp': '.webp', 'image/gif': '.gif', 'image/tiff': '.tif',
};

// ---------- Configuration : clé d'appairage + dossier de réception (créée au 1er lancement) ----------

function picturesFolder() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyPictures')"],
      { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
      if (out) return out;
    } catch { /* on retombe sur le dossier par défaut */ }
  }
  return path.join(os.homedir(), 'Pictures');
}

function loadConfig() {
  let cfg = {};
  let raw = null;
  try { raw = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch { /* premier lancement */ }
  if (raw !== null) {
    try {
      cfg = JSON.parse(raw.replace(/^﻿/, ''));
    } catch (err) {
      console.error(`\n  config.json est mal formé (${err.message}).`);
      console.error('  Astuce : dans le chemin du dossier, écris les \\ en double (\\\\) ou remplace-les par des /.\n');
      process.exit(1);
    }
  }
  const missing = !cfg.cle || !cfg.dossier;
  cfg.cle ||= crypto.randomBytes(9).toString('base64url');
  cfg.dossier ||= path.join(picturesFolder(), 'Swipe iPhone');
  if (missing) fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

const config = loadConfig();
const KEY = config.cle;
const DEST = path.resolve(process.env.SWIPE_DIR || config.dossier);
fs.mkdirSync(DEST, { recursive: true });

// ---------- Réseau ----------

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Bluetooth|Tailscale|ZeroTier|docker/i.test(name);
      const wifi = /wi-?fi|wlan|wireless/i.test(name);
      out.push({ name, address: a.address, rank: virtual ? 2 : wifi ? 0 : 1 });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ name, address }) => ({ name, address, url: phoneUrl(address) }));
}

function phoneUrl(address) {
  return `http://${address}:${PORT}/?k=${KEY}`;
}

// Le PC lui-même (navigateur local) n'a pas besoin de clé et a accès au tableau de bord.
function isLocal(req) {
  const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  return Object.values(os.networkInterfaces()).flat().some((i) => i && i.address === a);
}

function keyOk(k) {
  if (typeof k !== 'string' || !k) return false;
  const a = Buffer.from(k);
  const b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Petits utilitaires ----------

const pad = (n) => String(n).padStart(2, '0');
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function clock() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtSize(bytes) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1).replace('.', ',')} Mo`
    : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

function pickExt(type, name) {
  const fromName = path.extname(name || '').toLowerCase();
  if (IMAGE_EXT.test(fromName)) return fromName === '.jpeg' ? '.jpg' : fromName;
  return EXT_FOR_TYPE[String(type || '').split(';')[0].trim().toLowerCase()] || '.jpg';
}

function fileInDest(name) {
  if (!name || name !== path.basename(name) || !IMAGE_EXT.test(name)) return null;
  return path.join(DEST, name);
}

function send(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

async function sendPage(res, file) {
  try {
    send(res, 200, await fsp.readFile(path.join(PUBLIC_DIR, file)), 'text/html; charset=utf-8');
  } catch {
    send(res, 404, 'Introuvable');
  }
}

function openWithSystem(target) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [target], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

// ---------- Icône de l'appli (PNG généré, flèche vers la gauche) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const icons = new Map();
function icon(size) {
  if (icons.has(size)) return icons.get(size);
  const bg = [17, 17, 20];
  const fg = [74, 222, 128];
  const inArrow = (x, y) => { // repère de 180 × 180
    if (x >= 88 && x <= 142 && y >= 76 && y <= 104) return true;
    if (x >= 38 && x <= 96) return Math.abs(y - 90) <= (x - 38) * (48 / 58);
    return false;
  };
  const S = 4; // sur-échantillonnage pour des bords lisses
  const scale = size / 180;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          if (inArrow((x + (sx + 0.5) / S) / scale, (y + (sy + 0.5) / S) / scale)) hits++;
        }
      }
      const t = hits / (S * S);
      const i = y * stride + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[i + c] = Math.round(bg[c] + (fg[c] - bg[c]) * t);
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  icons.set(size, png);
  return png;
}

function manifest(k) {
  return JSON.stringify({
    name: 'Swipe → PC',
    short_name: 'Swipe',
    start_url: keyOk(k) ? `/?k=${encodeURIComponent(k)}` : '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0c0c0e',
    theme_color: '#0c0c0e',
    icons: [
      { src: '/icon.png', sizes: '180x180', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
}

// ---------- Événements en direct pour la page du PC ----------

const clients = new Set();
let lastPhone = 0;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(': ok\n\n'); }, 25000).unref();

function phoneSeen() {
  const now = Date.now();
  if (now - lastPhone > 15000) console.log(`  · ${clock()}  iPhone connecté`);
  lastPhone = now;
  broadcast('phone', { at: now });
}

// ---------- Réception d'une photo ----------

async function reserve(base, ext) {
  for (let i = 1; i < 1000; i++) {
    const name = `${base}${i > 1 ? `_${i}` : ''}${ext}`;
    try {
      return { name, fh: await fsp.open(path.join(DEST, name), 'wx') };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Trop de fichiers portent déjà ce nom');
}

async function handleUpload(req, res, url) {
  const declared = Number(req.headers['content-length']) || 0;
  if (declared > MAX_BYTES) {
    req.resume();
    return json(res, 413, { error: 'Fichier trop volumineux' });
  }
  const t = Number(url.searchParams.get('t'));
  const when = t > 946684800000 && t < Date.now() + 86400000 ? t : Date.now();
  const ext = pickExt(req.headers['content-type'], url.searchParams.get('name'));
  const { name, fh } = await reserve(`IMG_${stamp(when)}`, ext);
  const full = path.join(DEST, name);

  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      cb(size > MAX_BYTES ? new Error('Fichier trop volumineux') : null, chunk);
    },
  });

  try {
    await pipeline(req, counter, fh.createWriteStream());
    if (!size) throw new Error('Fichier vide');
    if (declared && size !== declared) throw new Error('Envoi incomplet');
  } catch (err) {
    await fh.close().catch(() => {});
    await fsp.unlink(full).catch(() => {});
    console.log(`  ✗ ${clock()}  réception interrompue (${err.message})`);
    if (!res.headersSent && !res.destroyed) json(res, 400, { error: err.message });
    return;
  }

  const item = { name, size, at: Date.now() };
  console.log(`  ✓ ${clock()}  ${name}  (${fmtSize(size)})`);
  broadcast('photo', item);
  json(res, 200, { ok: true, ...item });
}

async function recent(limit = 80) {
  const names = (await fsp.readdir(DEST)).filter((n) => IMAGE_EXT.test(n));
  const items = await Promise.all(names.map(async (name) => {
    try {
      const s = await fsp.stat(path.join(DEST, name));
      return s.isFile() && s.size > 0 ? { name, size: s.size, at: s.mtimeMs } : null;
    } catch {
      return null;
    }
  }));
  const all = items.filter(Boolean).sort((a, b) => b.at - a.at);
  return { total: all.length, items: all.slice(0, limit) };
}

// ---------- Routes ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const local = isLocal(req);
    const authed = local || keyOk(req.headers['x-swipe-key'] || url.searchParams.get('k'));

    // Accessible depuis l'iPhone
    if (req.method === 'GET' && p === '/') {
      if (local && !url.searchParams.has('k')) return send(res, 302, '', 'text/plain', { Location: '/pc' });
      return sendPage(res, 'index.html');
    }
    if (p === '/app.webmanifest') return send(res, 200, manifest(url.searchParams.get('k')), 'application/manifest+json');
    if (p === '/icon.png') return send(res, 200, icon(180), 'image/png', { 'Cache-Control': 'max-age=86400' });
    if (p === '/icon-512.png') return send(res, 200, icon(512), 'image/png', { 'Cache-Control': 'max-age=86400' });
    if (p === '/favicon.ico') return send(res, 200, icon(64), 'image/png', { 'Cache-Control': 'max-age=86400' });

    if (p === '/api/ping') {
      if (!authed) return json(res, 403, { error: 'Clé invalide' });
      if (!local) phoneSeen();
      return json(res, 200, { ok: true, pc: os.hostname() });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      if (!authed) {
        req.resume();
        return json(res, 403, { error: 'Clé invalide' });
      }
      if (!local) phoneSeen();
      return await handleUpload(req, res, url);
    }

    // Réservé au PC lui-même
    if (!local) return send(res, 404, 'Introuvable');

    if (p === '/pc') return sendPage(res, 'pc.html');
    if (p === '/api/info') {
      return json(res, 200, {
        pc: os.hostname(),
        port: PORT,
        dossier: DEST,
        urls: lanAddresses(),
        phoneAgo: lastPhone ? Date.now() - lastPhone : null,
      });
    }
    if (p === '/api/recent') return json(res, 200, await recent());
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/open-folder' && req.method === 'POST') {
      openWithSystem(DEST);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/open' && req.method === 'POST') {
      const full = fileInDest(url.searchParams.get('name'));
      if (!full) return json(res, 400, { error: 'Nom invalide' });
      openWithSystem(full);
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/files/')) {
      let name;
      try { name = decodeURIComponent(p.slice('/files/'.length)); } catch { name = ''; }
      const full = fileInDest(name);
      if (!full) return send(res, 400, 'Nom invalide');
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat) return send(res, 404, 'Introuvable');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'max-age=3600',
      });
      return fs.createReadStream(full).pipe(res);
    }

    return send(res, 404, 'Introuvable');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Erreur interne');
    else res.destroy();
  }
});

// ---------- Démarrage ----------

function openDashboard() {
  if (!process.env.NO_OPEN) openWithSystem(`http://localhost:${PORT}/pc`);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  Le port ${PORT} est déjà utilisé : Swipe → PC est sans doute déjà lancé.`);
    console.log('  J\'ouvre sa page sur le PC.\n');
    openDashboard();
    setTimeout(() => process.exit(0), 500);
    return;
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const addrs = lanAddresses();
  const lines = ['', '  Swipe → PC est lancé.', '', `  Photos enregistrées dans : ${DEST}`, ''];
  if (addrs.length) {
    lines.push(
      '  Sur l\'iPhone (même réseau Wi-Fi), scanne le QR code de la page qui vient',
      '  de s\'ouvrir, ou ouvre cette adresse dans Safari :', '',
      ...addrs.map((a) => `    ${a.url}${addrs.length > 1 ? `   (${a.name})` : ''}`),
    );
  } else {
    lines.push('  Aucun réseau détecté : connecte le PC au Wi-Fi puis relance.');
  }
  lines.push('', '  Garde cette fenêtre ouverte. Ctrl+C pour arrêter.', '');
  console.log(lines.join('\n'));
  openDashboard();
});
