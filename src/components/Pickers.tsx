import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Helper pencarian: semua kata yang diketik harus cocok (urutan bebas) */
/* ------------------------------------------------------------------ */
export function matchesQuery(haystack: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const h = haystack.toLowerCase();
  return words.every((w) => h.includes(w));
}

/* ------------------------------------------------------------------ */
/* SearchablePicker: pilih satu item dari daftar besar dengan pencarian */
/* ------------------------------------------------------------------ */
export type PickerOption = {
  value: string;
  label: string; // teks utama
  sublabel?: string; // teks kecil di bawah label
  right?: string; // teks di sisi kanan (mis. stok)
  search: string; // teks gabungan yang dicari
  disabled?: boolean;
};

export function SearchablePicker({
  options,
  value,
  onChange,
  placeholder = 'Cari...',
  emptyText = 'Tidak ada hasil',
  disabled = false,
  inline = false,
}: {
  options: PickerOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** Daftar tampil di alur halaman (bukan popup) agar tidak terpotong di dalam Modal. */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(
    () => options.filter((o) => matchesQuery(o.search, query)),
    [options, query]
  );

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function choose(o: PickerOption) {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[active]) choose(filtered[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      {!open ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="w-full flex items-center justify-between gap-2 px-4 py-2.5 border border-slate-300 rounded-lg text-sm bg-white text-left focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        >
          <span className={`truncate ${selected ? 'text-slate-900' : 'text-slate-400'}`}>
            {selected ? selected.label : placeholder}
          </span>
          <span className="flex items-center gap-1 flex-shrink-0">
            {selected && (
              <span
                role="button"
                aria-label="Hapus pilihan"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange('');
                }}
                className="p-0.5 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </span>
            )}
            <ChevronDown className="w-4 h-4 text-slate-400" />
          </span>
        </button>
      ) : (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ketik nama, kode, kategori, atau grup..."
            className="w-full pl-10 pr-4 py-2.5 border border-blue-500 ring-2 ring-blue-500 rounded-lg text-sm focus:outline-none bg-white"
          />
        </div>
      )}

      {open && (
        <div className={`${inline ? '' : 'absolute z-30'} mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden`}>
          <div ref={listRef} className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-400">{emptyText}</p>
            ) : (
              filtered.map((o, idx) => (
                <button
                  type="button"
                  key={o.value}
                  data-idx={idx}
                  disabled={o.disabled}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => choose(o)}
                  className={`w-full flex items-center justify-between gap-3 px-4 py-2 text-left border-b border-slate-50 last:border-0 ${
                    o.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                  } ${idx === active && !o.disabled ? 'bg-blue-50' : ''}`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-900 truncate">{o.label}</span>
                    {o.sublabel && <span className="block text-xs text-slate-400 truncate">{o.sublabel}</span>}
                  </span>
                  <span className="flex items-center gap-2 flex-shrink-0">
                    {o.right && (
                      <span className={`text-xs font-medium ${o.disabled ? 'text-red-500' : 'text-slate-500'}`}>
                        {o.right}
                      </span>
                    )}
                    {o.value === value && <Check className="w-4 h-4 text-blue-600" />}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="px-4 py-1.5 text-xs text-slate-400 bg-slate-50 border-t border-slate-100">
            {filtered.length} dari {options.length} item
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MultiPicker: pilih banyak item (mis. teknisi) dengan pencarian       */
/* Daftar ditampilkan inline (bukan popup) agar aman di dalam Modal.    */
/* ------------------------------------------------------------------ */
export type MultiOption = { value: string; label: string; sublabel?: string };

export function MultiPicker({
  options,
  value,
  onChange,
  placeholder = 'Cari nama...',
  emptyText = 'Tidak ada hasil',
}: {
  options: MultiOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  emptyText?: string;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(
    () => options.filter((o) => matchesQuery(`${o.label} ${o.sublabel ?? ''}`, query)),
    [options, query]
  );
  const selectedOptions = value
    .map((v) => options.find((o) => o.value === v))
    .filter((o): o is MultiOption => Boolean(o));

  function toggle(v: string) {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  return (
    <div className="space-y-2">
      {selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedOptions.map((o) => (
            <span
              key={o.value}
              className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 border border-blue-200"
            >
              {o.label}
              <button
                type="button"
                aria-label={`Hapus ${o.label}`}
                onClick={() => toggle(o.value)}
                className="p-0.5 rounded-full hover:bg-blue-200"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="border border-slate-300 rounded-lg bg-white overflow-hidden">
        <div className="relative border-b border-slate-200">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            placeholder={placeholder}
            className="w-full pl-10 pr-4 py-2 text-sm focus:outline-none"
          />
        </div>
        <div className="max-h-48 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate-400">{emptyText}</p>
          ) : (
            filtered.map((o) => {
              const checked = value.includes(o.value);
              return (
                <label
                  key={o.value}
                  className={`flex items-center gap-3 px-4 py-2 cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50 ${
                    checked ? 'bg-blue-50/60' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(o.value)}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-900 truncate">{o.label}</span>
                    {o.sublabel && <span className="block text-xs text-slate-400 truncate">{o.sublabel}</span>}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </div>
      <p className="text-xs text-slate-400">{value.length} dipilih</p>
    </div>
  );
}
