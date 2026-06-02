import type { DocumentTypeTier } from '@/queries/documentTypes';

const STYLES: Record<DocumentTypeTier, { label: string; classes: string; title: string }> = {
  stable: {
    label: 'stable',
    classes: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-900/40 dark:text-emerald-300',
    title: 'Stable — typed schema + golden-set покрытие; критичные поля ≥95% точности',
  },
  beta: {
    label: 'beta',
    classes: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-900/40 dark:text-amber-300',
    title: 'Beta — LLM-only извлечение; есть classification keywords + validators; нет golden-set измерений',
  },
  experimental: {
    label: 'exp',
    classes: 'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-400',
    title: 'Experimental — новый тип, accumulated статистики нет, может ошибаться',
  },
};

export default function TierBadge({ tier, size = 'sm' }: { tier: DocumentTypeTier | null | undefined; size?: 'sm' | 'xs' }) {
  if (!tier) return null;
  const s = STYLES[tier];
  const sizeClasses = size === 'xs' ? 'px-1 py-0 text-[10px]' : 'px-1.5 py-0.5 text-xs';
  return (
    <span title={s.title} className={`inline-flex items-center rounded-md font-medium ring-1 ring-inset ${sizeClasses} ${s.classes}`}>
      {s.label}
    </span>
  );
}
