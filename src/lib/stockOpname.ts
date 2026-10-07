/**
 * Lembar Stock Opname spare part: PDF (siap cetak) dan Excel (.xls).
 *
 * - PDF  : tabel hitung dengan kolom Stok Fisik kosong untuk diisi tangan + kotak tanda tangan.
 * - Excel: kolom Stok Fisik bisa diisi langsung; kolom Selisih terhitung otomatis (rumus).
 *          Format SpreadsheetML 2003 (.xls) ditulis sendiri sehingga tidak perlu paket tambahan.
 *
 * "Hitung buta": stok sistem disembunyikan agar penghitung tidak terpengaruh angka sistem.
 *  - PDF  : kolom Stok Sistem & Selisih tidak dicetak.
 *  - Excel: kolom Stok Sistem disembunyikan (bisa ditampilkan lagi) agar Selisih tetap terhitung.
 */

import type { SparePart } from '@/lib/supabase';
import { fmtQty } from '@/lib/slipPdf';

export type OpnameMeta = {
  /** Tanggal opname (YYYY-MM-DD). */
  date: string;
  /** Deskripsi cakupan, mis. "Semua spare part" atau "Lokasi: Rak A". */
  scopeLabel: string;
  /** Sembunyikan stok sistem dari lembar hitung. */
  blind: boolean;
  /** Nama pencetak (opsional). */
  printedBy?: string | null;
};

const SHEET = 'Stock Opname';

/** Urut per lokasi lalu nama, agar penghitung berjalan searah rak. */
export function sortForCounting(parts: SparePart[]): SparePart[] {
  return [...parts].sort(
    (a, b) =>
      // Part tanpa lokasi diletakkan paling akhir.
      Number(!a.location) - Number(!b.location) ||
      (a.location ?? '').localeCompare(b.location ?? '', 'id') ||
      a.name.localeCompare(b.name, 'id') ||
      a.code.localeCompare(b.code, 'id')
  );
}

export function opnameDocNo(date: string): string {
  return `SO-${date.replace(/-/g, '').slice(2)}`;
}

export function opnameFileName(meta: OpnameMeta, ext: 'pdf' | 'xls'): string {
  return `StockOpname_${meta.date.replace(/-/g, '')}.${ext}`;
}

function fmtDateId(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('id-ID', { dateStyle: 'long' });
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

export async function exportOpnamePdf(partsIn: SparePart[], meta: OpnameMeta): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const parts = sortForCounting(partsIn);
  const docNo = opnameDocNo(meta.date);

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 12;
  const finalY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  // ---- Kop ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('LEMBAR STOCK OPNAME SPARE PART', pageW / 2, 14, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(docNo, pageW / 2, 19.5, { align: 'center' });
  doc.setTextColor(0);
  doc.setDrawColor(60);
  doc.setLineWidth(0.5);
  doc.line(M, 22.5, pageW - M, 22.5);

  // ---- Informasi ----
  autoTable(doc, {
    startY: 25,
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: { top: 0.9, bottom: 0.9, left: 1, right: 1 } },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 32 }, 1: { cellWidth: 90 }, 2: { fontStyle: 'bold', cellWidth: 32 }, 3: { cellWidth: 'auto' } },
    margin: { left: M, right: M },
    body: [
      ['Tanggal Opname', fmtDateId(meta.date), 'Jumlah Item', `${parts.length} item`],
      ['Cakupan', meta.scopeLabel, 'Mode', meta.blind ? 'Hitung buta (stok sistem disembunyikan)' : 'Stok sistem ditampilkan'],
    ],
  });

  // ---- Tabel hitung ----
  const head = ['No', 'Kode', 'Nama Barang', 'Kategori', 'Lokasi', 'Satuan'];
  if (!meta.blind) head.push('Stok Sistem');
  head.push('Stok Fisik');
  if (!meta.blind) head.push('Selisih');
  head.push('Keterangan');

  const body = parts.map((p, i) => {
    const r = [String(i + 1), p.code, p.name, p.category ?? '-', p.location ?? '-', p.unit];
    if (!meta.blind) r.push(fmtQty(p.current_stock));
    r.push('');
    if (!meta.blind) r.push('');
    r.push('');
    return r;
  });

  // Indeks kolom setelah "Satuan" bergantung pada mode.
  const colStyles: Record<number, Record<string, unknown>> = {
    0: { cellWidth: 10, halign: 'center' },
    1: { cellWidth: 28 },
    2: { cellWidth: 'auto' },
    3: { cellWidth: 28 },
    4: { cellWidth: 28 },
    5: { cellWidth: 14, halign: 'center' },
  };
  let c = 6;
  if (!meta.blind) colStyles[c++] = { cellWidth: 22, halign: 'right' };
  colStyles[c++] = { cellWidth: 24 };
  if (!meta.blind) colStyles[c++] = { cellWidth: 20 };
  colStyles[c++] = { cellWidth: 38 };

  autoTable(doc, {
    startY: finalY() + 3,
    theme: 'grid',
    margin: { left: M, right: M, bottom: 16 },
    styles: { fontSize: 8.5, cellPadding: 1.8, lineColor: [150, 150, 150], lineWidth: 0.2, valign: 'middle', minCellHeight: 8 },
    headStyles: { fillColor: [51, 65, 85], textColor: 255, halign: 'center', fontStyle: 'bold' },
    columnStyles: colStyles,
    head: [head],
    body,
    showHead: 'everyPage',
  });

  // ---- Tanda tangan ----
  const boxH = 34;
  let y = finalY() + 10;
  if (y + boxH > pageH - 16) {
    doc.addPage();
    y = 20;
  }
  const gap = 8;
  const boxW = (pageW - 2 * M - 2 * gap) / 3;
  const sig = (x: number, title: string) => {
    doc.setDrawColor(120);
    doc.setLineWidth(0.3);
    doc.rect(x, y, boxW, boxH);
    doc.line(x, y + 8, x + boxW, y + 8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(0);
    doc.text(title, x + boxW / 2, y + 5.5, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text('Tanggal : ........ / ........ / ............', x + 4, y + 13);
    doc.setDrawColor(90);
    doc.line(x + 8, y + 27, x + boxW - 8, y + 27);
    doc.setFontSize(8.5);
    doc.text('(................................)', x + boxW / 2, y + 31, { align: 'center' });
    doc.setTextColor(0);
  };
  sig(M, 'Penghitung');
  sig(M + boxW + gap, 'Inventory Control');
  sig(M + 2 * (boxW + gap), 'Mengetahui (SPV / SS)');

  // ---- Footer ----
  const pages = doc.getNumberOfPages();
  const printed = new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`${docNo}  |  Dicetak ${printed}${meta.printedBy ? ` oleh ${meta.printedBy}` : ''}`, M, pageH - 7);
    doc.text(`Halaman ${p} / ${pages}`, pageW - M, pageH - 7, { align: 'right' });
  }

  doc.save(opnameFileName(meta, 'pdf'));
}

/* ------------------------------------------------------------------ */
/* Excel (.xls, SpreadsheetML 2003)                                    */
/* ------------------------------------------------------------------ */

const esc = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // karakter kontrol yang tidak valid di XML 1.0
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const str = (v: string, style: string) => `<Cell ss:StyleID="${style}"><Data ss:Type="String">${esc(v)}</Data></Cell>`;
const num = (v: number, style: string) => `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${Number.isFinite(v) ? v : 0}</Data></Cell>`;
const blank = (style: string) => `<Cell ss:StyleID="${style}"/>`;

const HEADER_ROW = 7; // baris judul kolom (1-based)

export function buildOpnameXls(partsIn: SparePart[], meta: OpnameMeta): string {
  const parts = sortForCounting(partsIn);
  const docNo = opnameDocNo(meta.date);
  const LAST_COL = 10;

  // Kolom: 1 No | 2 Kode | 3 Nama | 4 Kategori | 5 Lokasi | 6 Satuan | 7 Stok Sistem | 8 Stok Fisik | 9 Selisih | 10 Keterangan
  const widths = [30, 90, 210, 100, 100, 50, 80, 80, 70, 170];
  const cols = widths
    .map((w, i) => `<Column ss:Index="${i + 1}" ss:AutoFitWidth="0" ss:Width="${w}"${meta.blind && i === 6 ? ' ss:Hidden="1"' : ''}/>`)
    .join('');

  const info = (label: string, value: string) =>
    `<Row><Cell ss:StyleID="lbl" ss:MergeAcross="1"><Data ss:Type="String">${esc(label)}</Data></Cell>` +
    `<Cell ss:Index="3" ss:StyleID="val" ss:MergeAcross="4"><Data ss:Type="String">${esc(value)}</Data></Cell></Row>`;

  const headers = ['No', 'Kode', 'Nama Barang', 'Kategori', 'Lokasi', 'Satuan', 'Stok Sistem', 'Stok Fisik', 'Selisih', 'Keterangan'];

  const rows = parts
    .map(
      (p, i) =>
        `<Row>` +
        num(i + 1, 'ctr') +
        str(p.code, 'txt') +
        str(p.name, 'txt') +
        str(p.category ?? '-', 'txt') +
        str(p.location ?? '-', 'txt') +
        str(p.unit, 'ctr') +
        num(Number(p.current_stock), 'qty') +
        blank('input') +
        // Selisih = Fisik - Sistem; kosong selama Stok Fisik belum diisi.
        `<Cell ss:StyleID="qty" ss:Formula="=IF(RC[-1]=&quot;&quot;,&quot;&quot;,RC[-1]-RC[-2])"><Data ss:Type="String"></Data></Cell>` +
        blank('txt') +
        `</Row>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="10"/></Style>
  <Style ss:ID="title"><Font ss:FontName="Calibri" ss:Size="15" ss:Bold="1"/></Style>
  <Style ss:ID="sub"><Font ss:FontName="Calibri" ss:Size="9" ss:Color="#595959"/></Style>
  <Style ss:ID="lbl"><Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1"/></Style>
  <Style ss:ID="val"><Font ss:FontName="Calibri" ss:Size="10"/></Style>
  <Style ss:ID="head"><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
   <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders>
   <Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#334155" ss:Pattern="Solid"/></Style>
  <Style ss:ID="txt"><Alignment ss:Vertical="Center" ss:WrapText="1"/>
   <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/></Borders></Style>
  <Style ss:ID="ctr"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/></Borders></Style>
  <Style ss:ID="qty"><Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/></Borders>
   <NumberFormat ss:Format="#,##0.###"/></Style>
  <Style ss:ID="input"><Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A6A6A6"/></Borders>
   <Interior ss:Color="#FFF2CC" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0.###"/></Style>
 </Styles>
 <Worksheet ss:Name="${SHEET}">
  <Names><NamedRange ss:Name="Print_Titles" ss:RefersTo="='${SHEET}'!R${HEADER_ROW}"/></Names>
  <Table ss:DefaultRowHeight="18">
   ${cols}
   <Row ss:Height="24"><Cell ss:StyleID="title" ss:MergeAcross="${LAST_COL - 1}"><Data ss:Type="String">LEMBAR STOCK OPNAME SPARE PART</Data></Cell></Row>
   <Row><Cell ss:StyleID="sub" ss:MergeAcross="${LAST_COL - 1}"><Data ss:Type="String">${esc(docNo)}</Data></Cell></Row>
   ${info('Tanggal Opname', fmtDateId(meta.date))}
   ${info('Cakupan', meta.scopeLabel)}
   ${info('Mode', meta.blind ? 'Hitung buta (kolom Stok Sistem disembunyikan; tampilkan kembali bila perlu)' : 'Stok sistem ditampilkan')}
   <Row ss:Height="6"/>
   <Row ss:Height="26">${headers.map((h) => str(h, 'head')).join('')}</Row>
   ${rows}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <PageSetup><Layout x:Orientation="Landscape"/><Header x:Data="&amp;L${esc(docNo)}&amp;RHalaman &amp;P / &amp;N"/></PageSetup>
   <FitToPage/>
   <Print><ValidPrinterInfo/><PaperSizeIndex>9</PaperSizeIndex><FitWidth>1</FitWidth><FitHeight>0</FitHeight></Print>
   <FreezePanes/><FrozenNoSplit/><SplitHorizontal>${HEADER_ROW}</SplitHorizontal><TopRowBottomPane>${HEADER_ROW}</TopRowBottomPane><ActivePane>2</ActivePane>
  </WorksheetOptions>
 </Worksheet>
</Workbook>`;
}

export function exportOpnameXls(parts: SparePart[], meta: OpnameMeta): void {
  const xml = buildOpnameXls(parts, meta);
  const blob = new Blob(['\ufeff', xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opnameFileName(meta, 'xls');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
