import { woWorkTimes } from '@/lib/woHistory';
import { STATUS_LABELS, PRIORITY_LABELS, WORK_TYPE_LABELS, type WorkOrder, type WorkOrderHistory, type WorkOrderPart } from '@/lib/supabase';

type WoCompletionReportInput = {
  wo: WorkOrder;
  parts: WorkOrderPart[];
  history: WorkOrderHistory[];
  technicians: string[];
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  generatedBy?: string | null;
};

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtQty(n: number): string {
  return Number(n).toLocaleString('id-ID', { maximumFractionDigits: 3 });
}

async function imageUrlToJpegData(url: string): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = objectUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      URL.revokeObjectURL(objectUrl);
      return null;
    }
    ctx.drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    URL.revokeObjectURL(objectUrl);

    return {
      dataUrl,
      width: canvas.width,
      height: canvas.height,
    };
  } catch {
    return null;
  }
}

export async function downloadWoCompletionReport(input: WoCompletionReportInput): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);

  const { wo, parts, history, technicians, generatedBy, verifiedBy, verifiedAt } = input;
  const workTimes = woWorkTimes(history, wo.status);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 15;

  const finalY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  const techText = technicians.length > 0 ? technicians.join(', ') : '-';
  const areaEquipment = [wo.area?.name, wo.equipment?.name].filter(Boolean).join(' / ') || '-';
  const workTypeText =
    (wo.work_types ?? []).length > 0 ? (wo.work_types ?? []).map((t) => WORK_TYPE_LABELS[t] ?? t).join(', ') : '-';

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('LAPORAN PENYELESAIAN WORK ORDER', pageW / 2, 16, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(`No WO: ${wo.wo_number}`, pageW / 2, 21.5, { align: 'center' });
  doc.setTextColor(0);
  doc.setDrawColor(60);
  doc.setLineWidth(0.5);
  doc.line(M, 25, pageW - M, 25);

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
    body: [
      ['No. WO', wo.wo_number, 'Status', STATUS_LABELS[wo.status] ?? wo.status],
      ['Tanggal WO', new Date(wo.date_created).toLocaleDateString('id-ID'), 'Prioritas', PRIORITY_LABELS[wo.priority] ?? wo.priority],
      ['Jenis Pekerjaan', workTypeText, '', ''],
      ['Peminta', wo.requester_name || '-', 'Dept. Peminta', wo.requester_department || '-'],
      ['Departemen', wo.department?.name ?? '-', 'Area / Equipment', areaEquipment],
      ['SPV', wo.spv?.full_name ?? '-', 'Teknisi', techText],
      ['Mulai Dikerjakan', fmtDateTime(workTimes.startedAt), 'Selesai', fmtDateTime(workTimes.finishedAt)],
      ['Disetujui SPV', verifiedBy ?? wo.spv?.full_name ?? '-', 'Waktu Approval', fmtDateTime(verifiedAt)],
      ['Deskripsi Masalah', wo.problem_description],
      ['Analisa', wo.analysis ?? '-'],
      ['Tindakan', wo.action_taken ?? '-'],
      ['Hasil', wo.result ?? '-'],
    ],
  });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Spare Part Terpakai', M, finalY() + 8);

  autoTable(doc, {
    startY: finalY() + 10,
    theme: 'grid',
    margin: { left: M, right: M },
    styles: { fontSize: 9, cellPadding: 2, lineColor: [150, 150, 150], lineWidth: 0.2, valign: 'middle' },
    headStyles: { fillColor: [51, 65, 85], textColor: 255, halign: 'center', fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 30 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 18, halign: 'right' },
      4: { cellWidth: 18, halign: 'center' },
    },
    head: [['No', 'Kode', 'Nama Barang', 'Qty', 'Satuan']],
    body:
      parts.length > 0
        ? parts.map((p, idx) => [
            String(idx + 1),
            p.spare_part?.code ?? '-',
            p.spare_part?.name ?? '-',
            fmtQty(p.quantity),
            p.spare_part?.unit ?? '-',
          ])
        : [['-', '-', 'Tidak ada spare part terpakai', '-', '-']],
  });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Riwayat Work Order', M, finalY() + 8);

  const timeline = [...history]
    .sort((a, b) => new Date(a.performed_at).getTime() - new Date(b.performed_at).getTime())
    .map((h, idx) => [
      String(idx + 1),
      fmtDateTime(h.performed_at),
      STATUS_LABELS[h.status as keyof typeof STATUS_LABELS] ?? h.status,
      h.action ?? '-',
      h.performer?.full_name ?? '-',
      h.notes ?? '-',
    ]);

  autoTable(doc, {
    startY: finalY() + 10,
    theme: 'grid',
    margin: { left: M, right: M, bottom: 20 },
    styles: { fontSize: 8, cellPadding: 1.8, lineColor: [150, 150, 150], lineWidth: 0.2, valign: 'top' },
    headStyles: { fillColor: [51, 65, 85], textColor: 255, halign: 'center', fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 9, halign: 'center' },
      1: { cellWidth: 30 },
      2: { cellWidth: 22 },
      3: { cellWidth: 40 },
      4: { cellWidth: 28 },
      5: { cellWidth: 'auto' },
    },
    head: [['No', 'Waktu', 'Status', 'Aksi', 'Oleh', 'Catatan']],
    body: timeline.length ? timeline : [['-', '-', '-', '-', '-', '-']],
  });

  const attachmentUrls = (wo.attachments ?? []).filter((u): u is string => Boolean(u));
  if (attachmentUrls.length > 0) {
    let y = finalY() + 8;
    if (y > pageH - 28) {
      doc.addPage();
      y = M;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Lampiran Foto WO', M, y);
    y += 3;

    const gap = 4;
    const boxW = (pageW - M * 2 - gap) / 2;
    const boxH = 52;

    for (let i = 0; i < attachmentUrls.length; i++) {
      const col = i % 2;
      const x = col === 0 ? M : M + boxW + gap;

      if (col === 0 && y + boxH + 8 > pageH - 14) {
        doc.addPage();
        y = M;
      }

      const imgData = await imageUrlToJpegData(attachmentUrls[i]);
      if (imgData) {
        const ratio = imgData.width > 0 && imgData.height > 0 ? imgData.width / imgData.height : 1;
        let drawW = boxW;
        let drawH = drawW / ratio;
        if (drawH > boxH) {
          drawH = boxH;
          drawW = drawH * ratio;
        }
        const padX = (boxW - drawW) / 2;
        const padY = (boxH - drawH) / 2;
        doc.rect(x, y, boxW, boxH);
        doc.addImage(imgData.dataUrl, 'JPEG', x + padX, y + padY, drawW, drawH);
      } else {
        doc.rect(x, y, boxW, boxH);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(120);
        doc.text('Gagal memuat foto', x + boxW / 2, y + boxH / 2, { align: 'center' });
        doc.setTextColor(0);
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(100);
      doc.text(`Foto ${i + 1}`, x, y + boxH + 3);
      doc.setTextColor(0);

      if (col === 1 || i === attachmentUrls.length - 1) {
        y += boxH + 8;
      }
    }
  }

  const pages = doc.getNumberOfPages();
  const printedAt = fmtDateTime(new Date().toISOString());
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Dicetak: ${printedAt} | Oleh: ${generatedBy ?? '-'}`, M, pageH - 8);
    doc.text(`Halaman ${p} / ${pages}`, pageW - M, pageH - 8, { align: 'right' });
  }

  const safeNo = wo.wo_number.replace(/[^A-Za-z0-9_-]+/g, '-');
  doc.save(`Laporan-WO-${safeNo}.pdf`);
}
