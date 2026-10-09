/**
 * Update tabel `spare_parts` dari file CSV (dump interpolasi).
 * - Membaca CSV dengan delimiter `;` dan quoted field (double-quote).
 * - Login via Supabase Auth (akun aplikasi, username dipetakan ke <u>@wo-sparepart.app).
 * - Upsert per baris berdasarkan primary key `id` (trim trailling whitespace).
 *
 * Penggunaan:
 *   1) Baca VITE_SUPABASE_URL & VITE_SUPABASE_ANON_KEY dari .env.
 *   2) Password dibaca dari file `.env.admin` (format: ADMIN_PASSWORD=xxx)
 *      atau env var ADMIN_PASSWORD. JANGAN letakkan password di kode/argumen.
 *   3) Jalankan:
 *        node scripts/update-spareparts.mjs <path-csv> [--dry-run] [--flush]
 */
import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const CSV_PATH = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');

if (!CSV_PATH) {
  console.error('Usage: node scripts/update-spareparts.mjs <csv> [--dry-run]');
  process.exit(1);
}

/* ---------- baca .env ---------- */
function loadDotEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadDotEnv('.env');
const adminEnv = loadDotEnv('.env.admin');

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL || adminEnv.VITE_SUPABASE_URL;
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || adminEnv.VITE_SUPABASE_ANON_KEY;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || adminEnv.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || adminEnv.ADMIN_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error('ERROR: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY tidak ditemukan di .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

/* ---------- parser CSV (delimiter `;`, quoted dengan "") ---------- */
function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const c = content.split('');
  while (i < c.length) {
    const ch = c[i];
    if (inQuotes) {
      if (ch === '"') {
        if (c[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ';') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && c[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += ch;
      }
    }
    i++;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

function toNum(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

/* ---------- proses CSV ---------- */
const csvContent = readFileSync(CSV_PATH, 'utf8');
const rows = parseCsv(csvContent);
const header = rows[0].map((h) => h.trim());
const idx = (name) => header.indexOf(name);

const cols = ['id', 'code', 'name', 'category', 'unit', 'min_stock', 'max_stock',
  'current_stock', 'location', 'created_at', 'updated_at', 'group_id', 'inventory_code'];
const colIdx = {};
for (const c of cols) colIdx[c] = idx(c);

console.log(`CSV: ${rows.length - 1} baris data, kolom: ${header.join(', ')}`);

/* ---------- bangun payload ---------- */
const payloads = [];
for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const payload = {};
  for (const c of cols) {
    const I = colIdx[c];
    if (I < 0) continue;
    const raw = (row[I] ?? '').trim();
    if (['min_stock', 'max_stock', 'current_stock'].includes(c)) {
      const num = toNum(raw);
      // kolom numerik NOT NULL DEFAULT 0 → jika kosong isi 0 agar insert baru aman.
      payload[c] = num === null ? 0 : num;
    } else if (c === 'unit') {
      // kolom unit NOT NULL → jaga agar tidak menjadi null (default konsisten 'PCS').
      payload[c] = raw === '' ? 'PCS' : raw;
    } else if (raw !== '') {
      payload[c] = raw;
    }
    // field kosong tidak disertakan → DB memakai DEFAULT (saat insert) atau
    // mempertahankan nilai existing (saat update), menghindari NOT NULL violation.
  }
  payloads.push(payload);
}

console.log(`Payload siap: ${payloads.length} baris`);

/* ---------- tampilkan statistik stok yg akan berubah? ---------- */
const CHUNK = 500;
async function run() {
  if (DRY_RUN) {
    console.log('[dry-run] 3 baris contoh:');
    for (const p of payloads.slice(0, 3)) console.log(JSON.stringify(p));
    console.log(`[dry-run] Total ${payloads.length} baris (tidak ditulis, tidak login).`);
    return;
  }

  console.log(`Login sebagai ${ADMIN_USERNAME}@wo-sparepart.app ...`);
  if (!ADMIN_PASSWORD) {
    console.error('ERROR: ADMIN_PASSWORD tidak ditemukan. Buat file .env.admin dengan ADMIN_PASSWORD=xxx (diketik sendiri).');
    process.exit(1);
  }
  const { error: e } = await supabase.auth.signInWithPassword({
    email: `${ADMIN_USERNAME.trim().toLowerCase()}@wo-sparepart.app`,
    password: ADMIN_PASSWORD,
  });
  if (e) {
    console.error('Login gagal:', e.message);
    process.exit(1);
  }
  console.log('Login berhasil.');

  let ok = 0, fail = 0;
  for (let i = 0; i < payloads.length; i += CHUNK) {
    const chunk = payloads.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('spare_parts')
      .upsert(chunk, { onConflict: 'id', ignoreDuplicates: false, count: 'exact' });
    if (error) {
      fail += chunk.length;
      console.error(`Chunk ${i}-${i + chunk.length} GAGAL:`, error.message);
    } else {
      ok += chunk.length;
      console.log(`Chunk ${i}-${i + chunk.length} OK (${chunk.length})`);
    }
  }
  console.log(`Selesai. Berhasil ${ok}, gagal ${fail}.`);
  await supabase.auth.signOut();
}

run().catch((err) => { console.error(err); process.exit(1); });