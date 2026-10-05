# Proxy LAN - EngWO Inventory

Agar komputer **tanpa internet** bisa memakai aplikasi, satu komputer **yang punya internet**
menjadi perantara:

```
PC tanpa internet  --(jaringan lokal)-->  PC proxy (internet)  -->  Supabase
   cukup browser                           menyajikan aplikasi
                                           + meneruskan data
```

PC lain **tidak perlu menginstal apa pun**, cukup browser.

## 1. Pasang di PC yang punya internet (sekali saja)

Syarat: Node.js 18+ (https://nodejs.org). Salin folder `proxy/` ke **root project**
(sejajar dengan `package.json`). File `.env` project harus berisi
`VITE_SUPABASE_URL` dan `VITE_SUPABASE_ANON_KEY` (seperti biasa).

```
node proxy/build-offline.mjs     # membuat folder dist-offline/ (build "dist" biasa tidak terganggu)
node proxy/server.mjs            # menjalankan proxy
```

Atau cukup klik dua kali `proxy/start.bat` (Windows) / jalankan `proxy/start.sh` (Linux/Mac):
build dibuat otomatis bila belum ada.

Saat berjalan, layar menampilkan alamat seperti `http://192.168.1.10:8080`.

## 2. Pakai dari PC lain

Buka alamat itu di browser, lalu login seperti biasa. Alamat yang sama bisa dipakai dari PC
mana pun di jaringan; tidak perlu build ulang per PC.

## 3. Firewall (biasanya langkah yang terlewat)

Izinkan koneksi masuk ke port 8080 di PC proxy. Windows (CMD sebagai Administrator):

```
netsh advfirewall firewall add rule name="EngWO Proxy" dir=in action=allow protocol=TCP localport=8080
```

## Catatan penting

- **PC proxy harus menyala** dan proxy berjalan selama PC lain memakai aplikasi.
- **Gunakan IP tetap** untuk PC proxy (atur "DHCP reservation" di router atau IP statis),
  supaya alamatnya tidak berubah.
- Setelah ada perubahan kode aplikasi: jalankan lagi `node proxy/build-offline.mjs`, lalu
  restart proxy.
- Lalu lintas di jaringan lokal memakai **HTTP biasa** (tidak terenkripsi) antara PC lain dan PC
  proxy; dari PC proxy ke Supabase tetap HTTPS. Pakai hanya di jaringan internal yang dipercaya.
- Proxy **tidak menyimpan kunci rahasia** dan hanya meneruskan path Supabase
  (`/rest`, `/auth`, `/storage`, `/realtime`, `/functions`, `/graphql`); bukan proxy terbuka.
- Lampiran (foto WO, file GR/PR) tetap tersimpan di database sebagai alamat Supabase asli;
  proxy menerjemahkannya otomatis, jadi pengguna yang mengakses langsung maupun lewat proxy
  melihat data yang sama.
- Menjalankan otomatis saat PC menyala (opsional): pakai Task Scheduler / NSSM (Windows)
  atau `pm2 start proxy/server.mjs --name engwo-proxy`.

## Pengaturan opsional

Lihat `proxy/.env.proxy.example` (salin menjadi `proxy/.env.proxy`): ganti port, alamat Supabase,
folder build, atau aktifkan log permintaan (`LOG_REQUESTS=1`).

## Jika ada masalah

Buka `http://<IP-PC-proxy>:8080/__proxy/health` di PC lain:

| Hasil | Arti |
|---|---|
| halaman tidak terbuka | proxy mati, IP salah, atau firewall belum dibuka |
| `appBuilt: false` | jalankan `node proxy/build-offline.mjs` |
| `upstreamReachable: false` | PC proxy tidak bisa menjangkau Supabase (cek internet PC proxy) |
| login gagal padahal health OK | pastikan `.env` berisi anon key yang benar, lalu build ulang |
| upload foto / tambah baris / simpan gagal HANYA di PC lain (normal di PC server) | aplikasi memanggil fitur browser yang hanya ada di HTTPS/localhost (lihat catatan pengembang); pastikan memakai versi terbaru lalu build ulang dan tekan Ctrl+F5 |

Tambahkan ke `.gitignore` project: `dist-offline` dan `proxy/.env.proxy`.

## Catatan untuk pengembang: HTTP bukan "secure context"

Di PC lain aplikasi dibuka lewat `http://192.168.x.x:8080`. Browser **menonaktifkan** sejumlah API
di alamat seperti itu (di `localhost` dan HTTPS semuanya normal, sehingga bug baru terlihat di PC lain):

- `crypto.randomUUID()` -> pakai helper `uuid()` di `src/lib/uuid.ts`
- `navigator.clipboard`, `crypto.subtle`, `navigator.locks`, Service Worker, `Notification`

Aturannya: jangan memanggil API di atas langsung. Selalu uji fitur baru dengan membukanya dari
PC lain lewat proxy, bukan hanya dari `localhost`.
