#!/usr/bin/env node
// Membuat build aplikasi untuk dipakai lewat proxy LAN -> folder dist-offline/.
// Build "dist" biasa (untuk Cloudflare) TIDAK disentuh.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER, parseEnvFile } from './shared.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = 'dist-offline';

function run(cmd, env = process.env) {
  const r = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true, env });
  if (r.status !== 0) {
    console.error(`\n[GAGAL] Perintah berikut berhenti dengan error: ${cmd}`);
    process.exit(r.status ?? 1);
  }
}

const envFile = parseEnvFile(path.join(root, '.env'));
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? envFile.VITE_SUPABASE_ANON_KEY ?? '').trim();
if (!anonKey) {
  console.error('[GAGAL] VITE_SUPABASE_ANON_KEY tidak ditemukan. Isi di file .env project (lihat .env.example).');
  process.exit(1);
}

if (!fs.existsSync(path.join(root, 'node_modules'))) {
  console.log('node_modules belum ada -> menjalankan npm install (butuh internet)...');
  run('npm install');
}

console.log(`Membuat build offline ke ${outDir}/ ...`);
run(`npx vite build --outDir ${outDir} --emptyOutDir`, {
  ...process.env,
  VITE_SUPABASE_URL: PLACEHOLDER, // variabel shell menang atas .env
  VITE_SUPABASE_ANON_KEY: anonKey,
});

// Pastikan placeholder benar-benar tertanam di bundle.
const assets = path.join(root, outDir, 'assets');
const found = fs.existsSync(assets) && fs.readdirSync(assets).some((f) => f.endsWith('.js') && fs.readFileSync(path.join(assets, f), 'utf8').includes(PLACEHOLDER));
if (!found) {
  console.error('[GAGAL] Placeholder tidak ditemukan di hasil build. Proxy tidak akan bisa mengalihkan alamat Supabase.');
  process.exit(1);
}
console.log(`\nSelesai. Jalankan proxy:  node proxy/server.mjs`);
