import { supabase } from '@/lib/supabase';
import { renderSlipPdf, fmtDateTime, fmtQty } from '@/lib/slipPdf';
import { fetchSlipSignatures } from '@/lib/signatures';

type TxRow = {
  id: string;
  transaction_no: string | null;
  quantity: number;
  reference: string | null;
  notes: string | null;
  destination: string | null;
  recipient: string | null;
  issue_slip_no: string | null;
  created_by: string;
  created_at: string;
  spare_part: { code: string; name: string; unit: string } | null;
};

const TX_SELECT =
  'id, transaction_no, quantity, reference, notes, destination, recipient, issue_slip_no, created_by, created_at, spare_part:spare_parts(code, name, unit)';

async function buildAndDownload(slipNo: string, rows: TxRow[]): Promise<void> {
  if (rows.length === 0) throw new Error('Data pengeluaran tidak ditemukan.');
  const first = rows[0];

  // created_by mengacu ke auth.users, jadi nama petugas diambil dari profiles secara terpisah.
  const { data: issuer } = await supabase.from('profiles').select('full_name').eq('id', first.created_by).maybeSingle();

  // Penerima diketik bebas (belum tentu user terdaftar) -> tanda tangan basah; petugas = user pembuat transaksi.
  const sigs = await fetchSlipSignatures([first.created_by]);

  await renderSlipPdf({
    docNo: slipNo,
    subtitle: 'Spare Part - pengeluaran manual',
    fileName: `Pengeluaran-${slipNo}.pdf`,
    infoRows: [
      ['No. Dokumen', slipNo, 'Tanggal', fmtDateTime(first.created_at)],
      ['Dikeluarkan oleh', issuer?.full_name ?? '-', 'Tujuan', first.destination ?? '-'],
      ['Penerima', first.recipient ?? '-', 'Referensi', first.reference ?? '-'],
      ['Keperluan', first.notes ?? '-'],
    ],
    items: rows.map((r) => [
      r.spare_part?.code ?? '-',
      r.spare_part?.name ?? '-',
      fmtQty(r.quantity),
      r.spare_part?.unit ?? '-',
      r.transaction_no ?? '-',
    ]),
    signatures: [
      { title: 'Penerima', name: first.recipient },
      { title: 'Bagian Spare Part', name: issuer?.full_name, image: sigs[first.created_by] },
    ],
  });
}

/** Cetak lembar untuk satu dokumen pengeluaran (semua barang dengan nomor dokumen yang sama). */
export async function printIssueSlipByNo(slipNo: string): Promise<void> {
  const { data, error } = await supabase
    .from('inventory_transactions')
    .select(TX_SELECT)
    .eq('issue_slip_no', slipNo)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  await buildAndDownload(slipNo, (data as unknown as TxRow[]) ?? []);
}

/** Cetak lembar untuk pengeluaran manual lama (sebelum ada nomor dokumen): satu barang per lembar. */
export async function printLegacyIssue(txId: string): Promise<void> {
  const { data, error } = await supabase.from('inventory_transactions').select(TX_SELECT).eq('id', txId).maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as unknown as TxRow | null;
  if (!row) throw new Error('Transaksi tidak ditemukan.');
  await buildAndDownload(row.transaction_no ?? 'OUT', [row]);
}
