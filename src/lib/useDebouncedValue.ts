import { useEffect, useState } from 'react';

/** Nilai yang baru berubah setelah `delay` ms tanpa perubahan (mis. untuk kolom pencarian). */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
