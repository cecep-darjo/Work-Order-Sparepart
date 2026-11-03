import { useEffect, useRef } from 'react';

/**
 * Polling hemat egress untuk data yang harus tetap "segar" tanpa realtime.
 *
 * Dibanding setInterval + visibilitychange yang tersebar di beberapa file, hook ini:
 *  - hanya jalan saat tab terlihat DAN pengguna masih aktif (gerak mouse/klik/ketik/scroll/sentuh)
 *    dalam `idleMs` terakhir — tab yang dibiarkan terbuka di monitor tak berpenghuni tidak
 *    lagi menarik data seharian;
 *  - saat tab kembali terlihat atau pengguna kembali aktif setelah idle, memuat ulang satu kali,
 *    tapi tidak lebih sering dari `minGapMs` (berpindah-pindah tab tidak memicu query berulang);
 *  - tidak memanggil callback saat mount: pemuatan awal tetap dilakukan pemanggil.
 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

export function usePolling(
  callback: () => void,
  intervalMs: number,
  opts: { minGapMs?: number; idleMs?: number; enabled?: boolean } = {},
) {
  const { minGapMs = 30_000, idleMs = 30 * 60_000, enabled = true } = opts;
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    if (!enabled) return;
    let lastRun = Date.now();
    let lastActive = Date.now();
    let lastMark = 0;
    const visible = () => document.visibilityState === 'visible';
    const run = () => {
      lastRun = Date.now();
      callbackRef.current();
    };

    const timer = setInterval(() => {
      if (!visible() || Date.now() - lastActive > idleMs) return;
      run();
    }, intervalMs);

    const onVisible = () => {
      if (visible() && Date.now() - lastRun >= minGapMs) run();
    };
    const onActivity = () => {
      const now = Date.now();
      const wasIdle = now - lastActive > idleMs;
      if (!wasIdle && now - lastMark < 1_000) return; // pointermove bisa sangat sering
      lastMark = now;
      lastActive = now;
      if (wasIdle && visible() && now - lastRun >= minGapMs) run();
    };

    document.addEventListener('visibilitychange', onVisible);
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true });
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity);
    };
  }, [intervalMs, minGapMs, idleMs, enabled]);
}
