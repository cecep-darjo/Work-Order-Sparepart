import { useEffect, useState, useCallback } from 'react';
import { supabase, type ActivityLog } from '@/lib/supabase';
import { Card, Badge, Select, Input, Spinner, EmptyState } from '@/components/ui';
import { Search } from 'lucide-react';

export default function ActivityLogPage() {
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('activity_log')
      .select('*, user:profiles!user_id(*)')
      .order('created_at', { ascending: false })
      .limit(200);

    if (actionFilter !== 'all') query = query.eq('action', actionFilter);

    const { data } = await query;
    let entries = (data as unknown as ActivityLog[]) ?? [];

    if (search) {
      const s = search.toLowerCase();
      entries = entries.filter(
        (l) =>
          (l.details ?? '').toLowerCase().includes(s) ||
          (l.reason ?? '').toLowerCase().includes(s) ||
          (l.user?.full_name ?? '').toLowerCase().includes(s)
      );
    }

    setLogs(entries);
    setLoading(false);
  }, [search, actionFilter]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Spinner />;

  const actionTypes = [
    'all',
    'create_wo',
    'assign_wo',
    'admin_intervention',
    'reopen_wo',
    'inventory_stock_in',
    'inventory_stock_out',
    'inventory_adjustment',
    'inventory_opname',
    'manage_departments',
    'manage_areas',
    'manage_equipment',
    'manage_users',
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search by user, details, or reason..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="sm:w-56">
          {actionTypes.map((a) => (
            <option key={a} value={a}>
              {a === 'all' ? 'All Actions' : a.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
      </div>

      {logs.length === 0 ? (
        <Card className="p-6">
          <EmptyState message="No activity logs found" />
        </Card>
      ) : (
        <Card className="p-5">
          <div className="space-y-3">
            {logs.map((log) => (
              <div key={log.id} className="flex items-start gap-3 pb-3 border-b border-slate-100 last:border-0 last:pb-0">
                <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className="bg-slate-100 text-slate-600 border-slate-200">
                      {log.action.replace(/_/g, ' ')}
                    </Badge>
                    <span className="text-xs text-slate-400">
                      {log.user?.full_name ?? 'Unknown'} • {new Date(log.created_at).toLocaleString()}
                    </span>
                  </div>
                  {log.details && <p className="text-sm text-slate-700 mt-1">{log.details}</p>}
                  {log.reason && (
                    <p className="text-xs text-orange-600 mt-1 bg-orange-50 px-2 py-1 rounded inline-block">
                      Reason: {log.reason}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
