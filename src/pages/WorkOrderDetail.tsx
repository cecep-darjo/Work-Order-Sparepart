import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  supabase,
  STATUS_LABELS,
  STATUS_COLORS,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  ROLE_LABELS,
  type WorkOrder,
  type WorkOrderHistory,
  type WorkOrderPart,
  type Profile,
  type SparePart,
  type WOStatus,
} from '@/lib/supabase';
import { Card, Badge, Button, Select, Textarea, Label, Spinner, Modal, Input } from '@/components/ui';
import { ArrowLeft, UserCog, Play, Pause, CheckCircle2, RotateCcw, Lock, Unlock, Package, Plus, Trash2, History as HistoryIcon } from 'lucide-react';

export default function WorkOrderDetail({
  woId,
  onBack,
}: {
  woId: string;
  onBack: () => void;
}) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [wo, setWo] = useState<WorkOrder | null>(null);
  const [history, setHistory] = useState<WorkOrderHistory[]>([]);
  const [parts, setParts] = useState<WorkOrderPart[]>([]);
  const [techList, setTechList] = useState<Profile[]>([]);
  const [spvList, setSpvList] = useState<Profile[]>([]);
  const [spareParts, setSpareParts] = useState<SparePart[]>([]);

  // Action form state
  const [analysis, setAnalysis] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [result, setResult] = useState('');
  const [pendingReason, setPendingReason] = useState('');
  const [selectedPart, setSelectedPart] = useState('');
  const [partQty, setPartQty] = useState(1);
  const [assignTech, setAssignTech] = useState('');
  const [assignSpv, setAssignSpv] = useState('');
  const [interventionReason, setInterventionReason] = useState('');
  const [showIntervention, setShowIntervention] = useState(false);
  const [interventionStatus, setInterventionStatus] = useState<WOStatus>('new');
  const [acting, setActing] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);

    const { data: woData } = await supabase
      .from('work_orders')
      .select('*, department:departments(*), area:areas(*), equipment:equipment(*), spv:profiles!spv_id(*), technician:profiles!technician_id(*)')
      .eq('id', woId)
      .maybeSingle();
    setWo(woData as unknown as WorkOrder);
    setAnalysis(woData?.analysis ?? '');
    setActionTaken(woData?.action_taken ?? '');
    setResult(woData?.result ?? '');
    setPendingReason(woData?.pending_reason ?? '');

    const { data: histData } = await supabase
      .from('work_order_history')
      .select('*, performer:profiles!performed_by(*)')
      .eq('work_order_id', woId)
      .order('performed_at', { ascending: false });
    setHistory((histData as unknown as WorkOrderHistory[]) ?? []);

    const { data: partsData } = await supabase
      .from('work_order_parts')
      .select('*, spare_part:spare_parts(*)')
      .eq('work_order_id', woId)
      .order('created_at', { ascending: false });
    setParts((partsData as unknown as WorkOrderPart[]) ?? []);

    const [{ data: techs }, { data: spvs }, { data: sp }] = await Promise.all([
      supabase.from('profiles').select('*').eq('role', 'teknisi').eq('is_active', true).order('full_name'),
      supabase.from('profiles').select('*').eq('role', 'spv').eq('is_active', true).order('full_name'),
      supabase.from('spare_parts').select('*').order('name'),
    ]);
    setTechList((techs as Profile[]) ?? []);
    setSpvList((spvs as Profile[]) ?? []);
    setSpareParts((sp as SparePart[]) ?? []);
    setAssignTech(woData?.technician_id ?? '');
    setAssignSpv(woData?.spv_id ?? '');

    setLoading(false);
  }, [woId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function logHistory(woId: string, status: string, action: string, notes?: string) {
    if (!profile) return;
    await supabase.from('work_order_history').insert({
      work_order_id: woId,
      status,
      action,
      notes: notes ?? null,
      performed_by: profile.id,
    });
  }

  async function logActivity(action: string, details: string, reason?: string) {
    if (!profile) return;
    await supabase.from('activity_log').insert({
      user_id: profile.id,
      action,
      entity_type: 'work_order',
      entity_id: woId,
      details,
      reason: reason ?? null,
    });
  }

  async function updateStatus(newStatus: WOStatus, action: string, extraData?: Record<string, unknown>, notes?: string) {
    if (!profile || !wo) return;
    setActing(true);

    const updateData: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() };
    if (extraData) Object.assign(updateData, extraData);
    if (newStatus === 'closed') updateData.closed_at = new Date().toISOString();
    if (newStatus !== 'pending') updateData.pending_reason = null;

    const { error } = await supabase.from('work_orders').update(updateData).eq('id', wo.id);

    if (!error) {
      await logHistory(wo.id, newStatus, action, notes);
      await logActivity(action, `${wo.wo_number}: ${action}`, notes);
      await loadData();
    }
    setActing(false);
  }

  async function handleAssign() {
    if (!wo) return;
    setActing(true);
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (assignSpv) updateData.spv_id = assignSpv;
    if (assignTech) {
      updateData.technician_id = assignTech;
      updateData.status = 'assigned';
    }

    const { error } = await supabase.from('work_orders').update(updateData).eq('id', wo.id);
    if (!error) {
      await logHistory(wo.id, assignTech ? 'assigned' : wo.status, assignTech ? 'Technician assigned' : 'SPV assigned');
      await logActivity('assign_wo', `${wo.wo_number}: assignment updated`);
      await loadData();
    }
    setActing(false);
  }

  async function handleAddPart() {
    if (!wo || !selectedPart) return;
    const part = spareParts.find((p) => p.id === selectedPart);
    if (!part) return;

    setActing(true);
    await supabase.from('work_order_parts').insert({
      work_order_id: wo.id,
      spare_part_id: selectedPart,
      quantity: partQty,
    });

    // Create Stock Out transaction
    await supabase.from('inventory_transactions').insert({
      spare_part_id: selectedPart,
      type: 'stock_out',
      quantity: partQty,
      balance_after: part.current_stock - partQty,
      reference: wo.wo_number,
      notes: `Used on ${wo.wo_number}`,
      work_order_id: wo.id,
      created_by: profile!.id,
    });

    // Update stock
    await supabase
      .from('spare_parts')
      .update({ current_stock: part.current_stock - partQty, updated_at: new Date().toISOString() })
      .eq('id', selectedPart);

    await logHistory(wo.id, wo.status, 'Spare part added', `${part.name} x${partQty}`);
    setSelectedPart('');
    setPartQty(1);
    setActing(false);
    loadData();
  }

  async function handleRemovePart(partId: string, sparePartId: string, qty: number) {
    if (!wo) return;
    setActing(true);
    await supabase.from('work_order_parts').delete().eq('id', partId);

    // Reverse stock
    const part = spareParts.find((p) => p.id === sparePartId);
    if (part) {
      await supabase.from('inventory_transactions').insert({
        spare_part_id: sparePartId,
        type: 'stock_in',
        quantity: qty,
        balance_after: part.current_stock + qty,
        reference: wo.wo_number,
        notes: `Returned from ${wo.wo_number} (part removed)`,
        work_order_id: wo.id,
        created_by: profile!.id,
      });
      await supabase
        .from('spare_parts')
        .update({ current_stock: part.current_stock + qty, updated_at: new Date().toISOString() })
        .eq('id', sparePartId);
    }

    setActing(false);
    loadData();
  }

  async function handleIntervention() {
    if (!wo || !interventionReason) return;
    setActing(true);
    const { error } = await supabase
      .from('work_orders')
      .update({
        status: interventionStatus,
        updated_at: new Date().toISOString(),
        ...(interventionStatus === 'closed' ? { closed_at: null } : {}),
        ...(interventionStatus !== 'closed' ? { closed_at: null } : {}),
      })
      .eq('id', wo.id);

    if (!error) {
      await logHistory(wo.id, interventionStatus, 'Admin intervention', interventionReason);
      await logActivity('admin_intervention', `${wo.wo_number}: status changed to ${interventionStatus}`, interventionReason);
      setShowIntervention(false);
      setInterventionReason('');
      await loadData();
    }
    setActing(false);
  }

  async function handleReopen() {
    if (!wo) return;
    setActing(true);
    const { error } = await supabase
      .from('work_orders')
      .update({ status: 'verified', closed_at: null, updated_at: new Date().toISOString() })
      .eq('id', wo.id);
    if (!error) {
      await logHistory(wo.id, 'verified', 'WO reopened by admin');
      await logActivity('reopen_wo', `${wo.wo_number}: reopened from CLOSED`);
      await loadData();
    }
    setActing(false);
  }

  if (loading) return <Spinner />;
  if (!wo) return <div className="text-center text-slate-400 py-12">Work order not found</div>;

  const isAdmin = profile?.role === 'admin';
  const isSPV = profile?.role === 'spv' && profile?.department_id === wo.department_id;
  const isTech = profile?.role === 'teknisi' && profile?.id === wo.technician_id;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-slate-900">{wo.wo_number}</h2>
            <Badge className={STATUS_COLORS[wo.status]}>{STATUS_LABELS[wo.status]}</Badge>
            <Badge className={PRIORITY_COLORS[wo.priority]}>{PRIORITY_LABELS[wo.priority]}</Badge>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Created {new Date(wo.created_at).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Info Card */}
      <Card className="p-5 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InfoRow label="Department" value={wo.department?.name ?? '-'} />
          <InfoRow label="Area" value={wo.area?.name ?? '-'} />
          <InfoRow label="Equipment" value={wo.equipment?.name ?? '-'} />
          <InfoRow label="Date Created" value={new Date(wo.date_created).toLocaleDateString()} />
          <InfoRow label="SPV" value={wo.spv?.full_name ?? '-'} />
          <InfoRow label="Technician" value={wo.technician?.full_name ?? '-'} />
        </div>
        <div>
          <p className="text-xs text-slate-400 mb-1">Problem Description</p>
          <p className="text-sm text-slate-700">{wo.problem_description}</p>
        </div>
      </Card>

      {/* Assignment section (admin & spv) */}
      {(isAdmin || isSPV) && wo.status !== 'closed' && (
        <Card className="p-5">
          <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
            <UserCog className="w-4 h-4" /> Assignment
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>SPV</Label>
              <Select value={assignSpv} onChange={(e) => setAssignSpv(e.target.value)}>
                <option value="">Select SPV...</option>
                {spvList.map((s) => (
                  <option key={s.id} value={s.id}>{s.full_name}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Technician</Label>
              <Select value={assignTech} onChange={(e) => setAssignTech(e.target.value)}>
                <option value="">Select technician...</option>
                {techList.map((t) => (
                  <option key={t.id} value={t.id}>{t.full_name}</option>
                ))}
              </Select>
            </div>
          </div>
          <div className="mt-3">
            <Button size="sm" onClick={handleAssign} disabled={acting}>
              Update Assignment
            </Button>
          </div>
        </Card>
      )}

      {/* Teknisi actions */}
      {isTech && wo.status !== 'closed' && wo.status !== 'verified' && (
        <Card className="p-5 space-y-4">
          <h3 className="font-semibold text-slate-900">Work Execution</h3>

          {wo.status === 'assigned' && (
            <Button variant="primary" onClick={() => updateStatus('analysis', 'Started analysis')} disabled={acting}>
              <Play className="w-4 h-4" /> Start Analysis
            </Button>
          )}

          {(wo.status === 'analysis' || wo.status === 'on_progress' || wo.status === 'pending') && (
            <>
              <div>
                <Label>Analysis</Label>
                <Textarea
                  rows={3}
                  value={analysis}
                  onChange={(e) => setAnalysis(e.target.value)}
                  placeholder="Describe your analysis of the problem..."
                />
              </div>
              <div>
                <Label>Action Taken</Label>
                <Textarea
                  rows={3}
                  value={actionTaken}
                  onChange={(e) => setActionTaken(e.target.value)}
                  placeholder="Describe actions taken..."
                />
              </div>
              <div>
                <Label>Result</Label>
                <Textarea
                  rows={2}
                  value={result}
                  onChange={(e) => setResult(e.target.value)}
                  placeholder="Describe the result..."
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {wo.status !== 'on_progress' && (
                  <Button
                    variant="primary"
                    onClick={() =>
                      updateStatus('on_progress', 'Started work', {
                        analysis,
                        action_taken: actionTaken,
                      })
                    }
                    disabled={acting}
                  >
                    <Play className="w-4 h-4" /> Start Work
                  </Button>
                )}
                <Button
                  variant="warning"
                  onClick={() => {
                    if (!pendingReason) {
                      alert('Please enter a pending reason');
                      return;
                    }
                    updateStatus('pending', 'Set to pending', { pending_reason: pendingReason });
                  }}
                  disabled={acting}
                >
                  <Pause className="w-4 h-4" /> Set Pending
                </Button>
                {wo.status === 'pending' && pendingReason && (
                  <Button
                    variant="primary"
                    onClick={() => updateStatus('on_progress', 'Resumed from pending')}
                    disabled={acting}
                  >
                    <Play className="w-4 h-4" /> Resume Work
                  </Button>
                )}
                <Button
                  variant="success"
                  onClick={() =>
                    updateStatus('done', 'Work completed', {
                      analysis,
                      action_taken: actionTaken,
                      result,
                    })
                  }
                  disabled={acting}
                >
                  <CheckCircle2 className="w-4 h-4" /> Submit Done
                </Button>
              </div>

              {wo.status === 'pending' && (
                <div>
                  <Label>Pending Reason</Label>
                  <Input
                    value={pendingReason}
                    onChange={(e) => setPendingReason(e.target.value)}
                    placeholder="Why is this WO pending?"
                  />
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* Spare parts used */}
      <Card className="p-5">
        <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Package className="w-4 h-4" /> Spare Parts Used
        </h3>
        {parts.length === 0 ? (
          <p className="text-sm text-slate-400">No spare parts used yet</p>
        ) : (
          <div className="space-y-2 mb-3">
            {parts.map((p) => (
              <div key={p.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
                <div>
                  <p className="text-sm font-medium text-slate-900">{p.spare_part?.name}</p>
                  <p className="text-xs text-slate-400">{p.spare_part?.code} • {p.quantity} {p.spare_part?.unit}</p>
                </div>
                {(isAdmin || isTech) && wo.status !== 'closed' && (
                  <button
                    onClick={() => handleRemovePart(p.id, p.spare_part_id, p.quantity)}
                    disabled={acting}
                    className="text-red-500 hover:text-red-700 p-1"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {(isAdmin || isTech) && wo.status !== 'closed' && wo.status !== 'verified' && (
          <div className="flex flex-col sm:flex-row gap-2 items-end">
            <div className="flex-1 w-full">
              <Label>Add Spare Part</Label>
              <Select value={selectedPart} onChange={(e) => setSelectedPart(e.target.value)}>
                <option value="">Select part...</option>
                {spareParts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.current_stock} {p.unit} available)
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-24">
              <Label>Qty</Label>
              <Input
                type="number"
                min={1}
                value={partQty}
                onChange={(e) => setPartQty(Number(e.target.value))}
              />
            </div>
            <Button size="sm" onClick={handleAddPart} disabled={acting || !selectedPart}>
              <Plus className="w-4 h-4" /> Add
            </Button>
          </div>
        )}
      </Card>

      {/* SPV verify / rework */}
      {isSPV && wo.status === 'done' && (
        <Card className="p-5">
          <h3 className="font-semibold text-slate-900 mb-3">Verification</h3>
          <div className="flex gap-2">
            <Button variant="success" onClick={() => updateStatus('verified', 'WO verified by SPV')} disabled={acting}>
              <CheckCircle2 className="w-4 h-4" /> Verify & Close
            </Button>
            <Button variant="warning" onClick={() => updateStatus('on_progress', 'Sent back for rework', {}, 'SPV requested rework')} disabled={acting}>
              <RotateCcw className="w-4 h-4" /> Request Rework
            </Button>
          </div>
        </Card>
      )}

      {/* Admin actions */}
      {isAdmin && (
        <Card className="p-5">
          <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
            <Lock className="w-4 h-4" /> Admin Controls
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowIntervention(true)}>
              Change Status (Intervention)
            </Button>
            {wo.status === 'closed' && (
              <Button variant="warning" size="sm" onClick={handleReopen} disabled={acting}>
                <Unlock className="w-4 h-4" /> Reopen WO
              </Button>
            )}
            {wo.status === 'verified' && (
              <Button variant="success" size="sm" onClick={() => updateStatus('closed', 'WO closed by admin')} disabled={acting}>
                <Lock className="w-4 h-4" /> Close WO
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* History */}
      <Card className="p-5">
        <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <HistoryIcon className="w-4 h-4" /> History
        </h3>
        {history.length === 0 ? (
          <p className="text-sm text-slate-400">No history yet</p>
        ) : (
          <div className="space-y-3">
            {history.map((h) => (
              <div key={h.id} className="flex items-start gap-3 text-sm">
                <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900">{h.action}</span>
                    <Badge className={STATUS_COLORS[h.status as WOStatus] ?? 'bg-slate-100 text-slate-600 border-slate-200'}>
                      {STATUS_LABELS[h.status as WOStatus] ?? h.status}
                    </Badge>
                  </div>
                  {h.notes && <p className="text-xs text-slate-500 mt-0.5">{h.notes}</p>}
                  <p className="text-xs text-slate-400 mt-0.5">
                    {h.performer?.full_name ?? 'Unknown'} • {new Date(h.performed_at).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Intervention modal */}
      <Modal open={showIntervention} onClose={() => setShowIntervention(false)} title="Admin Intervention">
        <div className="space-y-4">
          <div>
            <Label>Change Status To</Label>
            <Select value={interventionStatus} onChange={(e) => setInterventionStatus(e.target.value as WOStatus)}>
              {(Object.keys(STATUS_LABELS) as WOStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Reason / Command *</Label>
            <Textarea
              rows={3}
              value={interventionReason}
              onChange={(e) => setInterventionReason(e.target.value)}
              placeholder="Explain the reason for this intervention..."
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowIntervention(false)}>Cancel</Button>
            <Button variant="danger" onClick={handleIntervention} disabled={acting || !interventionReason}>
              {acting ? 'Processing...' : 'Confirm Intervention'}
            </Button>
          </div>
          <p className="text-xs text-slate-400">
            This action will be recorded in the Activity Log with your name, timestamp, and reason.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-sm font-medium text-slate-700">{value}</p>
    </div>
  );
}
