import { useEffect, useState, type KeyboardEvent } from 'react';
import { Button, Input } from '@/components/ui';

const PAGE_SIZE = 10;

export default function PageControls({
  page,
  totalItems,
  onPageChange,
}: {
  page: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const [jumpValue, setJumpValue] = useState(String(page));

  useEffect(() => setJumpValue(String(page)), [page]);

  const jump = () => {
    if (!jumpValue.trim()) return;
    const requested = Number(jumpValue);
    if (!Number.isFinite(requested)) return;
    const nextPage = Math.min(totalPages, Math.max(1, Math.trunc(requested)));
    onPageChange(nextPage);
    setJumpValue(String(nextPage));
  };

  const handleJumpKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jump();
    }
  };

  const firstItem = totalItems === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastItem = Math.min(page * PAGE_SIZE, totalItems);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-slate-100 pt-3">
      <p className="text-xs text-slate-500">
        Menampilkan {firstItem}–{lastItem} dari {totalItems} item
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPageChange(1)}>
          Awal
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Sebelumnya
        </Button>
        <span className="px-1 text-xs text-slate-600 whitespace-nowrap">Halaman {page} dari {totalPages}</span>
        <Button type="button" size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Berikutnya
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => onPageChange(totalPages)}>
          Akhir
        </Button>
        <div className="flex items-center gap-2">
          <label htmlFor="jump-page" className="text-xs text-slate-500 whitespace-nowrap">Ke halaman</label>
          <Input
            id="jump-page"
            type="number"
            min={1}
            max={totalPages}
            value={jumpValue}
            onChange={(event) => setJumpValue(event.target.value)}
            onKeyDown={handleJumpKeyDown}
            onBlur={jump}
            aria-label="Lompat ke halaman"
            className="w-20 px-2 py-1.5"
          />
        </div>
      </div>
    </div>
  );
}
