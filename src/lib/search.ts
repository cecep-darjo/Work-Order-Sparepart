/**
 * Membangun filter PostgREST `.or(...)` untuk pencarian teks (ILIKE) pada beberapa kolom.
 *
 * Teks dicari secara LITERAL dan aman terhadap karakter khusus:
 *  1) `\`, `%`, `_` di-escape agar tidak dianggap wildcard/escape milik LIKE;
 *  2) nilai dibungkus tanda kutip dan `\` / `"` di-escape untuk sintaks filter PostgREST,
 *     sehingga koma, kurung, titik, atau titik dua pada teks tidak merusak filter
 *     (tanpa ini pencarian "motor panas, bearing" menghasilkan error 400).
 */
export function buildIlikeOr(columns: string[], term: string): string {
  const literal = term.replace(/[\\%_]/g, '\\$&');
  const quoted = literal.replace(/[\\"]/g, '\\$&');
  return columns.map((c) => `${c}.ilike."%${quoted}%"`).join(',');
}
