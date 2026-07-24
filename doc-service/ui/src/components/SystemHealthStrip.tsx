import { Link } from 'react-router-dom';
import { useProvidersStatus, useSettings } from '@/queries/settings';
import { useProviders } from '@/queries/providers';

/**
 * UX-3 (docs/UX_ANALYSIS_2026-05-31.md §UX-3): «статусные ленты вместо магии».
 *
 * Одна строка на дашборде отвечает на вопрос «всё ли работает» без похода по
 * пяти экранам: общий индикатор + чем сейчас распознаём + жив ли инференс.
 * Каждый сегмент — ссылка на экран, где это чинится, чтобы из «сломалось»
 * сразу попадать в «куда идти».
 *
 * Данные берём из УЖЕ существующих ручек (новый бэкенд не понадобился):
 *   · /providers/status  → доступность inference-service (upstream);
 *   · /provider-settings → какой LLM-провайдер основной и на какой модели;
 *   · /settings          → какие OCR-движки включены.
 *
 * Деградация: пока запросы летят — показываем нейтральное «проверяю»,
 * а не пугаем красным. Лента не должна создавать ложную тревогу на загрузке.
 */

type Level = 'ok' | 'warn' | 'down' | 'unknown';

const DOT: Record<Level, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  down: 'bg-rose-500',
  unknown: 'bg-slate-400',
};

const WRAP: Record<Level, string> = {
  ok: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/50 dark:bg-emerald-950/30',
  warn: 'border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/30',
  down: 'border-rose-200 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/30',
  unknown: 'border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/40',
};

export default function SystemHealthStrip() {
  const { data: status, isLoading: statusLoading } = useProvidersStatus();
  const { data: settings } = useSettings();
  const { data: providers } = useProviders();

  const llm = (providers?.items ?? []).find((p) => p.kind === 'llm' && p.is_default);
  const llmModel = llm?.default_model ?? llm?.model ?? null;

  // Уровень: инференс недоступен — красный; нет основного провайдера или
  // инференс не сконфигурирован — жёлтый; всё на месте — зелёный.
  const upstream = status?.upstream;
  let level: Level = 'unknown';
  let headline = 'Проверяю состояние…';
  if (!statusLoading && upstream) {
    if (upstream === 'unreachable') {
      level = 'down';
      headline = 'Распознавание недоступно — сервис моделей не отвечает';
    } else if (upstream === 'not_configured') {
      level = 'warn';
      headline = 'Сервис моделей не подключён';
    } else if (!llm) {
      level = 'warn';
      headline = 'Основная модель не выбрана';
    } else {
      level = 'ok';
      headline = 'Всё работает';
    }
  }

  // OCR-движки: базовый Tesseract всегда, остальные — по флагам.
  const engines: string[] = ['Tesseract'];
  if (settings?.ocr_engines.vision_llm.enabled) engines.push('Vision');
  if (settings?.ocr_engines.yandex_vision.enabled) engines.push('Yandex');

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 text-sm ${WRAP[level]}`}
    >
      <span className="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-200">
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[level]}`} aria-hidden />
        {headline}
      </span>

      <Sep />

      <Link
        to="/settings/providers"
        className="text-slate-600 hover:underline dark:text-slate-400"
        title="Открыть провайдеров"
      >
        Модель:{' '}
        {llm ? (
          <span className="font-medium text-slate-800 dark:text-slate-200">
            {llm.display_name}
            {llmModel ? ` · ${llmModel}` : ''}
          </span>
        ) : (
          <span className="font-medium text-amber-700 dark:text-amber-400">не выбрана →</span>
        )}
      </Link>

      <Sep />

      <Link
        to="/settings/instance"
        className="text-slate-600 hover:underline dark:text-slate-400"
        title="Открыть настройки"
      >
        Распознавание: <span className="font-medium text-slate-800 dark:text-slate-200">{engines.join(' · ')}</span>
      </Link>

      <Sep />

      <Link
        to="/settings"
        className="text-slate-600 hover:underline dark:text-slate-400"
        title="Открыть подключения"
      >
        Сервис моделей:{' '}
        <span
          className={`font-medium ${
            upstream === 'ok'
              ? 'text-emerald-700 dark:text-emerald-400'
              : upstream === undefined
                ? 'text-slate-500'
                : 'text-rose-700 dark:text-rose-400'
          }`}
        >
          {upstream === 'ok'
            ? 'готов'
            : upstream === 'unreachable'
              ? 'не отвечает →'
              : upstream === 'not_configured'
                ? 'не подключён →'
                : '…'}
        </span>
      </Link>

      {/* Курс — только когда он реально есть; иначе не мозолим глаза. */}
      {settings?.fx.usd_rub != null && (
        <>
          <Sep />
          <span className="text-slate-500 dark:text-slate-500" title={`источник: ${settings.fx.source}`}>
            USD {settings.fx.usd_rub.toFixed(2)} ₽
          </span>
        </>
      )}
    </div>
  );
}

function Sep() {
  return <span className="text-slate-300 dark:text-slate-700">•</span>;
}
