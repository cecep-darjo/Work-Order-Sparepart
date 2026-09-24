// Supabase Auth secara internal butuh identitas berbentuk email. Pengguna hanya memakai
// username; username dipetakan ke <username>@AUTH_EMAIL_DOMAIN (tidak pernah dikirimi email).
// Nilai ini harus sama dengan yang dipakai di migrasi 006.
export const AUTH_EMAIL_DOMAIN = 'wo-sparepart.app';

export const USERNAME_HINT = 'Username 3-30 karakter: huruf kecil, angka, titik, garis bawah atau strip.';
export const PASSWORD_HINT = 'Password minimal 6 karakter dan harus berisi huruf dan angka.';

const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9._-]{1,28})[a-z0-9]$/;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function usernameToEmail(username: string): string {
  return `${normalizeUsername(username)}@${AUTH_EMAIL_DOMAIN}`;
}

export function validateUsername(username: string): string | null {
  const u = normalizeUsername(username);
  if (!u) return 'Username wajib diisi.';
  if (!USERNAME_REGEX.test(u)) return USERNAME_HINT;
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 6) return PASSWORD_HINT;
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return PASSWORD_HINT;
  return null;
}

export function translateAuthError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (message.toLowerCase().includes('invalid login credentials')) return 'Username atau password salah.';
  return message || 'Terjadi kesalahan.';
}
