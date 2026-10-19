from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Flowable,
    PageTemplate,
    PageBreak,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    KeepTogether,
)


ROOT = Path(r"D:\Monitoring\Work Order\project")
OUTPUT = ROOT / "output" / "pdf" / "Manual-Pengguna-Inventory.pdf"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)

pdfmetrics.registerFont(TTFont("Arial", r"C:\Windows\Fonts\arial.ttf"))
pdfmetrics.registerFont(TTFont("Arial-Bold", r"C:\Windows\Fonts\arialbd.ttf"))

NAVY = colors.HexColor("#10233F")
BLUE = colors.HexColor("#2563EB")
TEAL = colors.HexColor("#0F766E")
PALE = colors.HexColor("#EFF6FF")
PALE_TEAL = colors.HexColor("#ECFDF5")
INK = colors.HexColor("#172033")
MUTED = colors.HexColor("#5B677A")
LINE = colors.HexColor("#D8E1EC")
AMBER = colors.HexColor("#B45309")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="BodyCustom", fontName="Arial", fontSize=9.2, leading=13.3,
    textColor=INK, spaceAfter=5.5, alignment=TA_LEFT,
))
styles.add(ParagraphStyle(
    name="SmallCustom", fontName="Arial", fontSize=8, leading=11,
    textColor=MUTED, spaceAfter=3,
))
styles.add(ParagraphStyle(
    name="H1Custom", fontName="Arial-Bold", fontSize=18, leading=22,
    textColor=NAVY, spaceBefore=2, spaceAfter=10,
))
styles.add(ParagraphStyle(
    name="H2Custom", fontName="Arial-Bold", fontSize=12, leading=15,
    textColor=BLUE, spaceBefore=8, spaceAfter=5,
))
styles.add(ParagraphStyle(
    name="H3Custom", fontName="Arial-Bold", fontSize=9.5, leading=12,
    textColor=NAVY, spaceBefore=4, spaceAfter=3,
))
styles.add(ParagraphStyle(
    name="CoverTitle", fontName="Arial-Bold", fontSize=29, leading=33,
    textColor=colors.white, alignment=TA_LEFT, spaceAfter=9,
))
styles.add(ParagraphStyle(
    name="CoverSub", fontName="Arial", fontSize=12, leading=17,
    textColor=colors.HexColor("#DCEAFE"), alignment=TA_LEFT,
))
styles.add(ParagraphStyle(
    name="CardTitle", fontName="Arial-Bold", fontSize=8.1, leading=10,
    textColor=NAVY, spaceAfter=2,
))
styles.add(ParagraphStyle(
    name="CardBody", fontName="Arial", fontSize=7.2, leading=9.2,
    textColor=MUTED,
))
styles.add(ParagraphStyle(
    name="FlowText", fontName="Arial-Bold", fontSize=7.3, leading=9,
    textColor=NAVY, alignment=TA_CENTER,
))
styles.add(ParagraphStyle(
    name="Step", fontName="Arial", fontSize=9, leading=13,
    textColor=INK, leftIndent=15, firstLineIndent=-15, spaceAfter=5,
))


class ProcessFlow(Flowable):
    def __init__(self, steps, accent=BLUE, height=82):
        super().__init__()
        self.steps = steps
        self.accent = accent
        self.height = height

    def wrap(self, avail_width, avail_height):
        self.width = avail_width
        return avail_width, self.height

    def draw(self):
        c = self.canv
        n = len(self.steps)
        gap = 13
        box_w = (self.width - gap * (n - 1)) / n
        box_h = 54
        y = (self.height - box_h) / 2
        for i, label in enumerate(self.steps):
            x = i * (box_w + gap)
            c.setFillColor(colors.white)
            c.setStrokeColor(LINE)
            c.roundRect(x, y, box_w, box_h, 7, fill=1, stroke=1)
            c.setFillColor(self.accent)
            c.circle(x + 12, y + box_h - 12, 8, fill=1, stroke=0)
            c.setFillColor(colors.white)
            c.setFont("Arial-Bold", 7)
            c.drawCentredString(x + 12, y + box_h - 14.5, str(i + 1))
            p = Paragraph(label, styles["FlowText"])
            _, ph = p.wrap(box_w - 12, box_h - 19)
            p.drawOn(c, x + 6, y + 7 + max(0, ((box_h - 20) - ph) / 2))
            if i < n - 1:
                ax1 = x + box_w + 2
                ax2 = x + box_w + gap - 2
                ay = y + box_h / 2
                c.setStrokeColor(self.accent)
                c.setFillColor(self.accent)
                c.setLineWidth(1.3)
                c.line(ax1, ay, ax2, ay)
                c.line(ax2, ay, ax2 - 4, ay + 3)
                c.line(ax2, ay, ax2 - 4, ay - 3)


class MenuMap(Flowable):
    def __init__(self, cards):
        super().__init__()
        self.cards = cards

    def wrap(self, avail_width, avail_height):
        self.width = avail_width
        self.height = 205
        return self.width, self.height

    def draw(self):
        c = self.canv
        cols = 3
        gap_x, gap_y = 9, 8
        card_w = (self.width - gap_x * 2) / 3
        card_h = 59
        top = self.height - card_h
        for i, (title, body, color) in enumerate(self.cards):
            col = i % cols
            row = i // cols
            x = col * (card_w + gap_x)
            y = top - row * (card_h + gap_y)
            c.setFillColor(colors.white)
            c.setStrokeColor(LINE)
            c.roundRect(x, y, card_w, card_h, 7, fill=1, stroke=1)
            c.setFillColor(color)
            c.roundRect(x, y, 4, card_h, 2, fill=1, stroke=0)
            title_p = Paragraph(title, styles["CardTitle"])
            _, th = title_p.wrap(card_w - 20, 20)
            title_p.drawOn(c, x + 11, y + card_h - 9 - th)
            body_p = Paragraph(body, styles["CardBody"])
            _, bh = body_p.wrap(card_w - 20, 30)
            body_p.drawOn(c, x + 11, y + 8)


def P(text, style="BodyCustom"):
    return Paragraph(text, styles[style])


def section(title, body=None):
    out = [P(title, "H2Custom")]
    if body:
        out.append(P(body))
    return out


def steps(items):
    return [P(f"<b>{i}.</b> {txt}", "Step") for i, txt in enumerate(items, 1)]


def bullets(items):
    return [P(f"- {txt}", "BodyCustom") for txt in items]


def callout(title, text, background=PALE, accent=BLUE):
    content = [P(title, "H3Custom"), P(text, "SmallCustom")]
    t = Table([[content]], colWidths=[None])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), background),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("LINEBEFORE", (0, 0), (0, -1), 3, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 11),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


class InventoryManualDoc(BaseDocTemplate):
    def __init__(self, filename):
        super().__init__(filename, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                         topMargin=18 * mm, bottomMargin=18 * mm, title="Panduan Pengguna Inventory")
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="main")
        self.addPageTemplates([PageTemplate(id="manual", frames=[frame], onPage=self.decorate)])

    def decorate(self, canvas, doc):
        canvas.saveState()
        w, h = A4
        if doc.page == 1:
            canvas.setFillColor(NAVY)
            canvas.rect(0, h - 82 * mm, w, 82 * mm, fill=1, stroke=0)
            canvas.setFillColor(TEAL)
            canvas.rect(0, h - 84 * mm, w, 2 * mm, fill=1, stroke=0)
        else:
            canvas.setStrokeColor(LINE)
            canvas.setLineWidth(0.5)
            canvas.line(self.leftMargin, h - 12 * mm, w - self.rightMargin, h - 12 * mm)
            canvas.setFont("Arial-Bold", 7.5)
            canvas.setFillColor(NAVY)
            canvas.drawString(self.leftMargin, h - 9 * mm, "ENGWO INVENTORY  /  PANDUAN USER INVENTORY")
        canvas.setStrokeColor(LINE)
        canvas.line(self.leftMargin, 12 * mm, w - self.rightMargin, 12 * mm)
        canvas.setFont("Arial", 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(self.leftMargin, 8 * mm, "Panduan pengguna - Inventory Control")
        canvas.drawRightString(w - self.rightMargin, 8 * mm, f"Halaman {doc.page}")
        canvas.restoreState()


story = []

# Cover and map
story += [Spacer(1, 12 * mm), P("PANDUAN PENGGUNA", "CoverSub"), Spacer(1, 3 * mm),
          P("Inventory<br/>Control", "CoverTitle"),
          P("EngWO Inventory - panduan operasional untuk pengelolaan spare part, transaksi stok, PR, dan GR.", "CoverSub"),
          Spacer(1, 31 * mm), P("MENU YANG TERSEDIA", "H1Custom"),
          P("Akun Inventory melihat menu sesuai tanggung jawab berikut:")]
story.append(MenuMap([
    ("Dashboard", "Ringkasan dan pintasan notifikasi.", BLUE),
    ("Bon Sparepart", "Lihat bon; proses pengeluaran di Transactions.", AMBER),
    ("Spare Parts", "Cari master, kelola part, stok, dan stock opname.", TEAL),
    ("Inventory Transactions", "Catat pemasukan dan pengeluaran stok.", BLUE),
    ("Daftar GR", "Cari dan periksa penerimaan bernomor GR.", TEAL),
    ("Low Stock Alerts", "Pantau part di bawah batas stok minimum.", AMBER),
    ("Purchase Requirements", "Buat PR, isi nomor SAP dan nomor PR.", BLUE),
    ("Master Data Inventory", "Kelola kategori, supplier, lokasi, grup, satuan.", TEAL),
    ("User Settings", "Ubah nama lengkap dan password akun sendiri.", AMBER),
]))
story += [Spacer(1, 4 * mm), callout("Fokus utama", "Pastikan setiap perubahan stok dicatat sebagai transaksi. Dengan begitu saldo, referensi dokumen, dan histori pergerakan tetap dapat ditelusuri.", PALE_TEAL, TEAL),
          Spacer(1, 5 * mm), P("ALUR PENGADAAN DAN PENERIMAAN", "H2Custom"),
          ProcessFlow(["Buat Purchase<br/>Requirement", "Isi nomor<br/>SAP dan PR", "Terima melalui<br/>Pemasukan", "Periksa di<br/>Daftar GR"], TEAL),
          P("Akun Inventory juga dapat memproses pengeluaran dari Bon Sparepart dan permintaan WO yang sudah disetujui.", "SmallCustom"),
          PageBreak()]

# PR
story += [P("1. Purchase Requirements", "H1Custom"),
          P("Role Inventory dapat membuat Purchase Requirement dan mengisi nomor SAP serta nomor PR.")]
story += section("Membuat PR")
story += steps([
    "Buka <b>Purchase Requirements</b> dan gunakan panel <b>Buat Purchase Requirement</b>.",
    "Cari spare part dari master menggunakan nama atau kode, isi jumlah, lalu tekan <b>Tambah</b>. Tambahkan item lainnya dengan cara yang sama.",
    "Untuk jasa yang tidak memakai stok master, masukkan uraian jasa dan satuannya pada bagian Jasa / Service, lalu tambahkan.",
    "Lengkapi pemesan, supplier bila diketahui, mesin bila relevan, serta lampiran. Lampiran menerima JPG, PNG, WEBP, atau PDF, maksimal 5 MB per file.",
    "Periksa item dan jumlah, kemudian simpan PR. PR akan menunggu nomor SAP dan nomor PR.",
])
story += section("Mengisi nomor SAP dan nomor PR")
story += steps([
    "Cari PR dengan status <b>Menunggu Nomor SAP/PR</b>.",
    "Masukkan nomor SAP dan nomor PR yang sesuai dokumen pembelian.",
    "Tekan <b>Simpan Nomor</b>. Status berubah menjadi <b>Sudah Dinomori</b> dan PR dapat dipanggil saat penerimaan.",
])
story += [Spacer(1, 2 * mm), callout("Penerimaan sebagian", "Jika barang diterima bertahap, masukkan jumlah yang benar-benar diterima. Jumlah tidak boleh melewati sisa PR; sisanya dapat diproses pada penerimaan berikutnya.", PALE, BLUE),
          Spacer(1, 4 * mm), P("ALUR PR KE STOK", "H2Custom"),
          ProcessFlow(["PR dibuat", "Nomor SAP/PR<br/>diisi", "Item PR dipanggil<br/>di Pemasukan", "Barang masuk<br/>ke saldo stok"], BLUE),
          PageBreak()]

# Transactions
story += [P("2. Inventory Transactions", "H1Custom"),
          P("Gunakan halaman ini untuk mencatat pemasukan dan pengeluaran. Filter jenis transaksi, cari dokumen atau spare part, dan tekan Refresh untuk memuat data terbaru.")]
story += section("Pemasukan barang atau jasa")
story += steps([
    "Tekan <b>Pemasukan</b>, lalu pilih jenis GR: Kredit (SKSB), Cash (STSB), atau Import (SKIS).",
    "Isi supplier bila tersedia. Isi nomor GR sendiri, atau tekan <b>Generate No. GR</b> lalu edit nomor tersebut bila diperlukan. Nomor harus unik.",
    "Untuk penerimaan PR, pilih pemesan dan tambahkan seluruh atau sebagian item PR yang masih memiliki sisa. Untuk penerimaan lain, cari spare part pada bagian Tambah Manual dan tambahkan jumlahnya.",
    "Barang dan jasa dapat digabung pada satu penerimaan. Barang memperbarui stok; jasa tercatat pada GR tanpa mengubah stok.",
    "Lengkapi referensi, keterangan, dan lampiran bila ada. Periksa kembali daftar item lalu tekan <b>Simpan Pemasukan</b>.",
])
story += [callout("Nomor GR", "Jika nomor yang dimasukkan telah dipakai, sistem menolak penyimpanan. Gunakan nomor lain atau generate nomor baru. Kolom nomor boleh dikosongkan untuk penomoran otomatis.", PALE, BLUE)]
story += section("Pengeluaran barang")
story += steps([
    "Tekan <b>Pengeluaran</b> dan isi Nama Penerima. Lengkapi tujuan, referensi, dan keterangan sesuai kebutuhan.",
    "Pilih item dari <b>Panggil dari Bon Sparepart</b>, proses permintaan WO yang telah disetujui, atau tambahkan spare part manual.",
    "Periksa jumlah dan ketersediaan stok. Jika stok permintaan WO tidak cukup, proses tidak dapat dilanjutkan.",
    "Simpan pengeluaran. Stok berkurang dan lembar pengeluaran PDF dibuat sebagai bukti distribusi.",
])
story += [Spacer(1, 2 * mm), ProcessFlow(["Pilih sumber<br/>pengeluaran", "Periksa penerima,<br/>item, dan qty", "Simpan dan<br/>kurangi stok", "Unduh bukti<br/>pengeluaran PDF"], AMBER),
          PageBreak()]

# Stock, GR, Bon
story += [P("3. Stok, GR, dan Bon", "H1Custom")]
story += section("Spare Parts")
story += [P("Cari berdasarkan nama, kode, kode inventori, grup, kategori, atau lokasi. Gunakan filter status stok dan klik judul kolom untuk mengurutkan. Status stok membandingkan saldo dengan batas minimum dan maksimum.")]
story += bullets([
    "Low Stock - saldo berada di bawah batas minimum.",
    "Normal - saldo berada dalam rentang yang ditetapkan.",
    "Over Stock - saldo melebihi batas maksimum.",
])
story += [P("Inventory dapat menambah atau mengubah data master spare part. Untuk mengubah saldo, gunakan ikon Transaction pada baris part: pilih Stock In, Stock Out, Adjustment, atau Stock Opname, isi jumlah/referensi/keterangan, lalu konfirmasi. Stock In menambah saldo, Stock Out mengurangi, dan Adjustment/Stock Opname menetapkan saldo aktual yang baru.")]
story += [callout("Stock Opname", "Tombol Stock Opname membuat lembar hitung PDF atau Excel untuk lingkup yang dipilih. Mengunduh lembar tidak otomatis mengubah saldo; catat hasil fisik dengan transaksi Adjustment/Stock Opname bila diperlukan.", PALE_TEAL, TEAL)]
story += section("Daftar GR")
story += [P("Buka Daftar GR untuk meninjau penerimaan tersimpan. Cari berdasarkan nomor GR, jenis, sumber/supplier, referensi atau PR, spare part, kode inventori, maupun pembuat. Buka detail untuk memeriksa item dan lampiran. Pemasukan lama tanpa nomor GR tidak ditampilkan sebagai GR bernomor.")]
story += section("Bon Sparepart")
story += [P("Role Inventory dapat melihat semua bon, mencari, dan memfilter berdasarkan status. Role ini tidak membuat bon atas nama peminta. Untuk memproses bon, buka <b>Inventory Transactions → Pengeluaran → Panggil dari Bon Sparepart</b>. Bon aktif mencakup status menunggu dan sebagian.")]
story += [PageBreak()]

# Master and profile
story += [P("4. Master Data dan akun", "H1Custom")]
story += section("Master Data Inventory")
master_rows = [
    [P("Tab", "CardTitle"), P("Kegunaan", "CardTitle")],
    [P("Categories", "SmallCustom"), P("Kategori spare part.", "SmallCustom")],
    [P("Units", "SmallCustom"), P("Satuan yang digunakan pada spare part dan PR.", "SmallCustom")],
    [P("Locations", "SmallCustom"), P("Lokasi penyimpanan spare part.", "SmallCustom")],
    [P("Suppliers", "SmallCustom"), P("Data pemasok; daftar bisa diurutkan menurut nama atau kode.", "SmallCustom")],
    [P("Inventory Groups", "SmallCustom"), P("Grup untuk pengelompokan dan pembentukan kode part; daftar dapat diurutkan menurut nama atau kode.", "SmallCustom")],
    [P("GR Numbering", "SmallCustom"), P("Menampilkan nomor awal dan nomor GR terakhir per jenis. Perubahan nomor awal hanya untuk Admin atau Senior Supervisor.", "SmallCustom")],
]
table = Table(master_rows, colWidths=[38 * mm, 132 * mm], repeatRows=1)
table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), PALE),
    ("TEXTCOLOR", (0, 0), (-1, 0), NAVY),
    ("GRID", (0, 0), (-1, -1), 0.4, LINE),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
]))
story += [table, Spacer(1, 3 * mm), callout("Perhatian", "Sebelum menghapus data master, pastikan data tersebut tidak lagi digunakan oleh spare part atau transaksi yang sudah tercatat.", PALE, AMBER)]
story += section("User Settings dan tanda tangan")
story += [P("User Settings hanya mengubah akun yang sedang login. Nama lengkap dapat diedit. Untuk mengganti password, masukkan password saat ini, password baru, dan konfirmasi. Password baru minimal 6 karakter dan harus memuat huruf serta angka."),
          P("Tombol Tanda Tangan ada di bagian bawah sidebar. Gunakan untuk mendaftarkan atau mengganti tanda tangan yang akan dipakai pada dokumen yang mendukungnya.")]
story += section("Jika terjadi kendala")
story += bullets([
    "Data belum terlihat - tekan Refresh dan periksa filter serta kata kunci pencarian.",
    "Stok tidak cukup - periksa saldo di Spare Parts atau Stock Card.",
    "Nomor GR ditolak - gunakan nomor unik atau generate nomor baru.",
    "PR tidak muncul saat penerimaan - pastikan PR sudah bernomor dan item masih memiliki sisa penerimaan.",
    "Permintaan WO tidak dapat diproses - pastikan permintaan sudah disetujui dan stok mencukupi.",
    "Akses ditolak - hubungi Admin untuk memeriksa role serta hak akses akun.",
])
story += [Spacer(1, 2 * mm), callout("Kebiasaan pencatatan yang baik", "Pilih item yang benar, cocokkan jumlah fisik dan dokumen, isi referensi yang mudah ditelusuri, dan simpan bukti pengeluaran/penerimaan sesuai prosedur internal.", PALE_TEAL, TEAL)]

doc = InventoryManualDoc(str(OUTPUT))
doc.build(story)
print(OUTPUT)
