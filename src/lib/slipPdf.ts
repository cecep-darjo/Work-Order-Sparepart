/**
 * Mesin PDF bersama untuk "Lembar Pengeluaran Barang".
 * Dipakai oleh lembar permintaan WO (partRequests.ts) dan pengeluaran manual (manualIssue.ts)
 * agar tampilannya seragam. jsPDF dimuat lazy supaya tidak membebani bundel awal.
 */

/** Baris info: [label, nilai] selebar penuh, atau [label, nilai, label, nilai] dua kolom. */
export type SlipInfoRow = [string, string] | [string, string, string, string];

export type SlipSignature = { title: string; name?: string | null };

export type SlipOptions = {
  docNo: string;
  subtitle: string;
  infoRows: SlipInfoRow[];
  /** Tiap baris: [kode, nama barang, qty, satuan, keterangan]. Nomor urut ditambahkan otomatis. */
  items: [string, string, string, string, string][];
  signatures: [SlipSignature, SlipSignature];
  fileName: string;
};

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtQty(n: number): string {
  return Number(n).toLocaleString('id-ID', { maximumFractionDigits: 3 });
}

export async function renderSlipPdf(opts: SlipOptions): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 15;
  const finalY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  // ---- Kop ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('LEMBAR PENGELUARAN BARANG', pageW / 2, 16, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(opts.subtitle, pageW / 2, 21.5, { align: 'center' });
  doc.setTextColor(0);
  doc.setDrawColor(60);
  doc.setLineWidth(0.5);
  doc.line(M, 25, pageW - M, 25);

  // ---- Informasi dokumen ----
  autoTable(doc, {
    startY: 28,
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: { top: 1.1, bottom: 1.1, left: 1, right: 1 }, valign: 'top' },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 30 },
      1: { cellWidth: 57 },
      2: { fontStyle: 'bold', cellWidth: 30 },
      3: { cellWidth: 'auto' },
    },
    margin: { left: M, right: M },
    body: opts.infoRows.map((r) =>
      r.length === 2 ? [r[0], { content: r[1], colSpan: 3 }] : [r[0], r[1], r[2], r[3]]
    ),
  });

  // ---- Tabel barang ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Daftar Barang', M, finalY() + 8);

  autoTable(doc, {
    startY: finalY() + 10,
    theme: 'grid',
    margin: { left: M, right: M },
    styles: { fontSize: 9, cellPadding: 2, lineColor: [150, 150, 150], lineWidth: 0.2, valign: 'middle' },
    headStyles: { fillColor: [51, 65, 85], textColor: 255, halign: 'center', fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 28 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 16, halign: 'right' },
      4: { cellWidth: 18, halign: 'center' },
      5: { cellWidth: 42 },
    },
    head: [['No', 'Kode', 'Nama Barang', 'Qty', 'Satuan', 'Keterangan']],
    body: opts.items.map((it, idx) => [String(idx + 1), ...it]),
  });

  // ---- Tanda tangan ----
  const boxH = 46;
  let y = finalY() + 14;
  if (y + boxH > pageH - 18) {
    doc.addPage();
    y = 22;
  }
  const gap = 10;
  const boxW = (pageW - 2 * M - gap) / 2;

  const sigBox = (x: number, sig: SlipSignature) => {
    doc.setDrawColor(120);
    doc.setLineWidth(0.3);
    doc.rect(x, y, boxW, boxH);
    doc.line(x, y + 9, x + boxW, y + 9);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(0);
    doc.text(sig.title, x + boxW / 2, y + 6, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text('Tanggal : ........ / ........ / ............', x + 5, y + 14);
    doc.text('Tanda tangan', x + boxW / 2, y + 20, { align: 'center' });
    doc.setTextColor(0);
    doc.setDrawColor(90);
    doc.line(x + 10, y + 38, x + boxW - 10, y + 38);
    doc.setFontSize(9);
    doc.text(sig.name && sig.name.trim() ? sig.name : '(................................)', x + boxW / 2, y + 42.5, {
      align: 'center',
    });
  };

  sigBox(M, opts.signatures[0]);
  sigBox(M + boxW + gap, opts.signatures[1]);

  // ---- Footer tiap halaman ----
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`${opts.docNo}  |  Dicetak ${fmtDateTime(new Date().toISOString())}`, M, pageH - 8);
    doc.text(`Halaman ${p} / ${pages}`, pageW - M, pageH - 8, { align: 'right' });
  }

  doc.save(opts.fileName);
}
