// Dipakai bersama oleh server.mjs dan build-offline.mjs.
import fs from 'node:fs';

/**
 * Alamat sementara yang "ditanam" ke hasil build. Saat file JS disajikan, server mengganti
 * teks ini dengan alamat server itu sendiri (mis. http://192.168.1.10:8080), sehingga satu
 * hasil build bisa dipakai dari alamat/IP berapa pun tanpa build ulang.
 */
export const PLACEHOLDER = 'http://supabase-proxy.local';

/** Baca file .env sederhana (KEY=VALUE, komentar #, tanda kutip opsional). */
export function parseEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
