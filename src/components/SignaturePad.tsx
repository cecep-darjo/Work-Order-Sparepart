import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export type SignaturePadHandle = {
  clear: () => void;
  undo: () => void;
  /** PNG transparan yang dipotong rapat ke goresan; null bila goresan belum cukup. */
  toPng: () => string | null;
};

type Pt = { x: number; y: number };

const INK = '#0f172a';
const LINE_WIDTH = 2.6;
/** Panjang goresan minimum (px layar) agar ketukan tak sengaja tidak tersimpan sebagai tanda tangan. */
const MIN_LENGTH = 60;
const MAX_EXPORT_W = 800;
const MAX_EXPORT_H = 300;
const MAX_DATA_URL = 250_000;

function strokeLength(s: Pt[]): number {
  let n = 0;
  for (let i = 1; i < s.length; i++) n += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
  return n;
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Pt[]) {
  if (s.length === 0) return;
  if (s.length === 1) {
    ctx.beginPath();
    ctx.arc(s[0].x, s[0].y, LINE_WIDTH / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Kurva kuadratik melalui titik tengah: goresan halus walau titik input jarang.
  ctx.beginPath();
  ctx.moveTo(s[0].x, s[0].y);
  for (let i = 1; i < s.length - 1; i++) {
    const mx = (s[i].x + s[i + 1].x) / 2;
    const my = (s[i].y + s[i + 1].y) / 2;
    ctx.quadraticCurveTo(s[i].x, s[i].y, mx, my);
  }
  ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y);
  ctx.stroke();
}

function applyInk(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

type Props = {
  /** Dipanggil tiap goresan berubah: `valid` = cukup panjang untuk disimpan, `hasInk` = ada goresan. */
  onChange?: (state: { valid: boolean; hasInk: boolean }) => void;
  className?: string;
};

const SignaturePad = forwardRef<SignaturePadHandle, Props>(function SignaturePad({ onChange, className = '' }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Pt[][]>([]);
  const current = useRef<Pt[] | null>(null);
  const onChangeRef = useRef(onChange);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const totalLength = () => strokes.current.reduce((n, s) => n + strokeLength(s), 0);

  const notify = useCallback(() => {
    const ink = strokes.current.length > 0;
    setHasInk(ink);
    onChangeRef.current?.({ valid: totalLength() >= MIN_LENGTH, hasInk: ink });
  }, []);

  const redraw = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    applyInk(ctx);
    for (const s of strokes.current) drawStroke(ctx, s);
  }, []);

  // Samakan resolusi kanvas dengan ukuran tampil (tajam di layar retina / HP); goresan digambar ulang.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      redraw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, [redraw]);

  useImperativeHandle(
    ref,
    () => ({
      clear() {
        strokes.current = [];
        current.current = null;
        redraw();
        notify();
      },
      undo() {
        strokes.current.pop();
        redraw();
        notify();
      },
      toPng() {
        if (totalLength() < MIN_LENGTH) return null;
        const pts = strokes.current.flat();
        const pad = LINE_WIDTH * 2;
        const minX = Math.min(...pts.map((p) => p.x)) - pad;
        const minY = Math.min(...pts.map((p) => p.y)) - pad;
        const w = Math.max(...pts.map((p) => p.x)) + pad - minX;
        const h = Math.max(...pts.map((p) => p.y)) + pad - minY;

        let scale = Math.min(4, MAX_EXPORT_W / w, MAX_EXPORT_H / h);
        for (let attempt = 0; attempt < 5; attempt++) {
          const out = document.createElement('canvas');
          out.width = Math.max(1, Math.ceil(w * scale));
          out.height = Math.max(1, Math.ceil(h * scale));
          const ctx = out.getContext('2d');
          if (!ctx) return null;
          ctx.scale(scale, scale);
          ctx.translate(-minX, -minY);
          applyInk(ctx);
          for (const s of strokes.current) drawStroke(ctx, s);
          const url = out.toDataURL('image/png'); // latar transparan
          if (url.length <= MAX_DATA_URL) return url;
          scale *= 0.7;
        }
        return null;
      },
    }),
    [notify, redraw],
  );

  const point = (clientX: number, clientY: number): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const s = [point(e.clientX, e.clientY)];
    current.current = s;
    strokes.current.push(s);
    redraw();
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const s = current.current;
    if (!s) return;
    const evs = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    for (const ev of evs.length > 0 ? evs : [e.nativeEvent]) {
      const p = point(ev.clientX, ev.clientY);
      const last = s[s.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.6) s.push(p);
    }
    redraw();
  }

  function endStroke() {
    if (!current.current) return;
    current.current = null;
    notify();
  }

  return (
    <div className={`relative select-none ${className}`}>
      <canvas
        ref={canvasRef}
        className="block w-full h-52 rounded-lg border-2 border-dashed border-slate-300 bg-white cursor-crosshair"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        aria-label="Area tanda tangan"
      />
      <div className="pointer-events-none absolute left-6 right-6 bottom-12 border-b border-slate-300" />
      {!hasInk && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-300">
          Tanda tangan di sini
        </span>
      )}
    </div>
  );
});

export default SignaturePad;
