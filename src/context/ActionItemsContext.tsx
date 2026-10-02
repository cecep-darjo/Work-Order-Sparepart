import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useActionItems } from '@/lib/actionItems';

type ActionItemsValue = ReturnType<typeof useActionItems>;

const ActionItemsContext = createContext<ActionItemsValue | null>(null);

/**
 * Satu sumber data "menunggu aksi" untuk seluruh aplikasi: lonceng di header
 * dan kartu Dashboard memakai data yang sama (satu polling, bukan dua).
 * `refreshKey` berubah saat user pindah halaman / membuka WO -> data dimuat ulang diam-diam.
 */
export function ActionItemsProvider({ refreshKey, children }: { refreshKey: string; children: ReactNode }) {
  const { profile } = useAuth();
  const value = useActionItems(profile);

  const { reload } = value;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload(true);
  }, [refreshKey, reload]);

  return <ActionItemsContext.Provider value={value}>{children}</ActionItemsContext.Provider>;
}

export function useActionItemsContext(): ActionItemsValue {
  const ctx = useContext(ActionItemsContext);
  if (!ctx) throw new Error('useActionItemsContext harus dipakai di dalam ActionItemsProvider');
  return ctx;
}
