import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useActionItems } from '@/lib/actionItems';
import { registerNotificationServiceWorker, showActionItemNotification } from '@/lib/browserNotifications';

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
  const notificationBaseline = useRef<Map<string, Set<string>> | null>(null);
  useEffect(() => {
    void registerNotificationServiceWorker().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (value.loading) return;
    const current = new Map(value.groups.map((group) => [group.key, new Set(group.rows.map((row) => row.id))]));
    if (notificationBaseline.current === null) {
      notificationBaseline.current = current;
      return;
    }
    const previous = notificationBaseline.current;
    notificationBaseline.current = current;
    if (document.visibilityState !== 'visible') return;

    for (const group of value.groups) {
      const oldIds = previous.get(group.key) ?? new Set<string>();
      const newRows = group.rows.filter((row) => !oldIds.has(row.id));
      const increase = Math.max(newRows.length, oldIds.size === 0 ? group.count : 0);
      if (increase <= 0) continue;
      const suffix = increase > 1 ? ` (${increase} baru)` : '';
      const examples = newRows.slice(0, 2).map((row) => row.title).join(', ');
      const body = [group.description, examples, suffix].filter(Boolean).join(' · ');
      void showActionItemNotification(group.title, body, `action-${group.key}`)
        .catch(() => undefined);
    }
  }, [value.groups, value.loading]);

  const first = useRef(true);
  const lastNavigationRefreshAt = useRef(0);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      // Initial data is already loaded by useActionItems. Don't immediately fetch it again.
      lastNavigationRefreshAt.current = Date.now();
      return;
    }
    // Page changes used to trigger the full bell query set each time. Keep navigation
    // refreshes bounded; polling and explicit post-mutation reloads still keep it current.
    const now = Date.now();
    if (now - lastNavigationRefreshAt.current < 30000) return;
    lastNavigationRefreshAt.current = now;
    reload(true);
  }, [refreshKey, reload]);

  return <ActionItemsContext.Provider value={value}>{children}</ActionItemsContext.Provider>;
}

export function useActionItemsContext(): ActionItemsValue {
  const ctx = useContext(ActionItemsContext);
  if (!ctx) throw new Error('useActionItemsContext harus dipakai di dalam ActionItemsProvider');
  return ctx;
}
