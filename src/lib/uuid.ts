/**
 * UUID v4 yang aman dipakai di HTTP biasa.
 *
 * `crypto.randomUUID()` hanya tersedia di "secure context" (HTTPS atau localhost). Saat aplikasi
 * dibuka lewat proxy LAN (http://192.168.x.x:8080) fungsi itu TIDAK ada dan memicu TypeError,
 * sehingga upload file dan penambahan baris gagal. `crypto.getRandomValues` tersedia di semua
 * konteks, jadi dipakai sebagai cadangan.
 *
 * Gunakan helper ini, bukan `crypto.randomUUID()` langsung.
 */
export function uuid(): string {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();

  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(b);
  } else {
    // Sangat jarang: browser tanpa Web Crypto. Cukup unik untuk nama file / key React.
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40; // versi 4
  b[8] = (b[8] & 0x3f) | 0x80; // varian RFC 4122
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}
