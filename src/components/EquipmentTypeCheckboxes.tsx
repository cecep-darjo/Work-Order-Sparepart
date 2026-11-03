import { Badge } from '@/components/ui';

export const EQUIPMENT_TYPES = ['HVAC', 'Mesin', 'LAF', 'Lainnya'] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

const BADGE_STYLES: Record<EquipmentType, string> = {
  HVAC: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  Mesin: 'border-blue-200 bg-blue-50 text-blue-700',
  LAF: 'border-violet-200 bg-violet-50 text-violet-700',
  Lainnya: 'border-slate-200 bg-slate-100 text-slate-600',
};

export function equipmentTypeBadge(type: string) {
  const safeType = EQUIPMENT_TYPES.includes(type as EquipmentType) ? type as EquipmentType : 'Lainnya';
  return { label: safeType, className: BADGE_STYLES[safeType] };
}

export function EquipmentTypeBadges({ types }: { types?: readonly string[] | null }) {
  const displayTypes = types?.length ? types : ['Lainnya'];
  return <span className="inline-flex flex-wrap gap-1">{displayTypes.map((type) => {
    const badge = equipmentTypeBadge(type);
    return <Badge key={type} className={badge.className}>{badge.label}</Badge>;
  })}</span>;
}

/** Checkboxes in filter mode narrow the picker; assignment mode tags a master machine. */
export function EquipmentTypeCheckboxes({
  value,
  onChange,
  mode = 'filter',
  label,
}: {
  value: string[];
  onChange: (types: string[]) => void;
  mode?: 'filter' | 'assign';
  label?: string;
}) {
  function toggle(type: EquipmentType, checked: boolean) {
    if (mode === 'filter') {
      onChange(checked ? [...new Set([...value, type])] : value.filter((item) => item !== type));
      return;
    }
    if (type === 'Lainnya' && checked) {
      onChange(['Lainnya']);
      return;
    }
    const next = checked ? [...new Set([...value.filter((item) => item !== 'Lainnya'), type])] : value.filter((item) => item !== type);
    onChange(next.length ? next : ['Lainnya']);
  }

  return (
    <div className="space-y-1.5">
      {label && <p className="text-xs font-medium text-slate-600">{label}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {EQUIPMENT_TYPES.map((type) => (
          <label key={type} className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={value.includes(type)}
              onChange={(event) => toggle(type, event.target.checked)}
              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[type]}`}>{type}</span>
          </label>
        ))}
      </div>
      {mode === 'filter' && <p className="text-[11px] text-slate-400">Pilih satu atau beberapa kategori; kosongkan semua untuk melihat seluruh mesin.</p>}
    </div>
  );
}
