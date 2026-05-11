/**
 * parsdocs operator UI.
 *
 * One HTML shell + this module. No bundler, no framework — just hash-based
 * routing, fetch() with a Bearer token from localStorage, and templates
 * inlined as tagged template strings.
 *
 * Все стили — через design tokens из index.html (`.card`, `.btn-*`,
 * `.form-*`, `.page-*`, `.badge-*`, etc.). Ad-hoc Tailwind утилиты —
 * только для локального layout'а (flex, grid, gap). Это держит UI
 * консистентным между всеми views.
 */

const API = '/api/v1';
const STORAGE = {
  token: 'parsdocs.token',
  dark: 'parsdocs.dark',
};

// ============================================================
// Auth + API
// ============================================================

const auth = {
  get token() { return localStorage.getItem(STORAGE.token); },
  set token(v) {
    if (v) localStorage.setItem(STORAGE.token, v);
    else localStorage.removeItem(STORAGE.token);
  },
  isAuthed() { return !!this.token; },
};

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, { ...opts, headers });
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }
  if (res.status === 401) {
    auth.token = null;
    location.hash = '';
    showLogin();
    throw new Error('Unauthorized — token cleared, log in again');
  }
  return res;
}

async function apiJson(path, opts = {}) {
  const res = await api(path, opts);
  if (!res.ok) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* keep raw */ }
    throw new Error(parsed?.error ? JSON.stringify(parsed.error) : `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ============================================================
// Theme
// ============================================================

function applyTheme() {
  const stored = localStorage.getItem(STORAGE.dark);
  const dark =
    stored === '1' ? true :
    stored === '0' ? false :
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
}
function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  localStorage.setItem(STORAGE.dark, isDark ? '0' : '1');
  applyTheme();
}

// ============================================================
// Helpers — reused across views
// ============================================================

const STATUS_BADGE = {
  pending:      { label: 'Pending',      variant: 'badge-slate' },
  processing:   { label: 'Processing',   variant: 'badge-indigo badge-pulse' },
  done:         { label: 'Done',         variant: 'badge-emerald' },
  needs_review: { label: 'Needs review', variant: 'badge-amber' },
  failed:       { label: 'Failed',       variant: 'badge-rose' },
};
function badge(status) {
  const b = STATUS_BADGE[status] ?? { label: status, variant: 'badge-slate' };
  return `<span class="badge ${b.variant}">${escapeHtml(b.label)}</span>`;
}

const PARSER_BADGE = {
  'builtin:invoice_regex': { label: 'regex (invoice)', variant: 'badge-sky' },
  'builtin:upd_regex':     { label: 'regex (UPD)',     variant: 'badge-sky' },
  'llm_extract':           { label: 'LLM /extract',    variant: 'badge-violet' },
};
function parserKindBadge(kind) {
  const b = PARSER_BADGE[kind] ?? { label: kind, variant: 'badge-slate' };
  return `<span class="badge ${b.variant}">${escapeHtml(b.label)}</span>`;
}

function confidenceBar(confidence) {
  if (confidence === null || confidence === undefined) {
    return '<span class="text-slate-400 text-xs">—</span>';
  }
  const pct = Math.round(confidence * 100);
  const color =
    confidence >= 0.8 ? 'bg-emerald-500' :
    confidence >= 0.6 ? 'bg-amber-500' :
    'bg-rose-500';
  return `
    <div class="flex items-center gap-2">
      <div class="w-20 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div class="h-full ${color}" style="width:${pct}%"></div>
      </div>
      <span class="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">${pct}%</span>
    </div>`;
}

function relativeTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const diff = Math.round((Date.now() - t) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Render a JSON value as a collapsible tree using native `<details>` for
 * expand/collapse (no JS state to manage). Color-coded by type via the
 * `.json-*` token classes defined in index.html.
 */
function jsonTree(value) {
  return `<div class="json-node">${renderJsonNode(value)}</div>`;
}

function renderJsonNode(value) {
  if (value === null) return `<span class="json-null">null</span>`;
  if (typeof value === 'boolean') return `<span class="json-boolean">${value}</span>`;
  if (typeof value === 'number') return `<span class="json-number">${value}</span>`;
  if (typeof value === 'string') return `<span class="json-string">"${escapeHtml(value)}"</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="json-bracket">[]</span>`;
    const items = value.map((v, i) =>
      `<div>${renderJsonNode(v)}${i < value.length - 1 ? '<span class="json-bracket">,</span>' : ''}</div>`,
    ).join('');
    return `
      <details open>
        <summary class="json-bracket cursor-pointer select-none">[ <span class="text-slate-400">${value.length} items</span> ]</summary>
        <div class="json-indent ml-2 mt-1">${items}</div>
      </details>`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return `<span class="json-bracket">{}</span>`;
    const rows = entries.map(([k, v], i) => `
      <div>
        <span class="json-key">"${escapeHtml(k)}"</span><span class="json-bracket">:</span> ${renderJsonNode(v)}${i < entries.length - 1 ? '<span class="json-bracket">,</span>' : ''}
      </div>`).join('');
    return `
      <details open>
        <summary class="json-bracket cursor-pointer select-none">{ <span class="text-slate-400">${entries.length} fields</span> }</summary>
        <div class="json-indent ml-2 mt-1">${rows}</div>
      </details>`;
  }
  return `<span class="json-null">undefined</span>`;
}

// ============================================================
// View lifecycle
// ============================================================
//
// setView writes new HTML, replacing the previous view. Before doing so it
// runs any cleanup registered by the previous view (cancels timers, etc.).

let currentCleanup = null;
function runCurrentCleanup() {
  if (currentCleanup) {
    try { currentCleanup(); } catch (e) { console.error('cleanup error', e); }
    currentCleanup = null;
  }
}
function setView(html) {
  runCurrentCleanup();
  document.getElementById('view').innerHTML = html;
}
function registerCleanup(fn) {
  currentCleanup = fn;
}

function pageHeader({ title, subtitle, actions }) {
  return `
    <header class="page-header">
      <div>
        <h2 class="page-title">${escapeHtml(title)}</h2>
        ${subtitle ? `<p class="page-subtitle">${escapeHtml(subtitle)}</p>` : ''}
      </div>
      ${actions ? `<div class="flex items-center gap-2 shrink-0">${actions}</div>` : ''}
    </header>`;
}

function backLink(href, label = 'К списку') {
  return `<a href="${escapeHtml(href)}" class="back-link">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clip-rule="evenodd"/></svg>
    ${escapeHtml(label)}
  </a>`;
}

function loadingState() {
  return `
    <div class="card empty-state">
      <div class="space-y-2 max-w-sm mx-auto">
        <div class="skeleton-row w-1/3 mx-auto"></div>
        <div class="skeleton-row w-2/3 mx-auto"></div>
        <div class="skeleton-row w-1/2 mx-auto"></div>
      </div>
    </div>`;
}

function errorState(message) {
  return `
    <div class="card error-banner">
      <p class="font-medium">Не удалось загрузить</p>
      <p class="text-sm mt-1">${escapeHtml(message)}</p>
    </div>`;
}

// ============================================================
// Login
// ============================================================

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('token-input').focus();
}
function hideLogin() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
}

async function tryLogin(token) {
  auth.token = token;
  try {
    const res = await api('/jobs?limit=1');
    if (res.status === 200) return true;
    if (res.status === 401) return false;
    throw new Error(`Server responded ${res.status}`);
  } catch (err) {
    auth.token = null;
    throw err;
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = document.getElementById('token-input').value.trim();
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const ok = await tryLogin(token);
    if (!ok) {
      errEl.textContent = 'Неверный токен';
      errEl.classList.remove('hidden');
      return;
    }
    hideLogin();
    if (!location.hash) location.hash = '#jobs';
    else route();
  } catch (err) {
    errEl.textContent = err.message || 'Ошибка входа';
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  auth.token = null;
  showLogin();
});

document.getElementById('dark-toggle').addEventListener('click', toggleTheme);

// ============================================================
// Router
// ============================================================

function route() {
  const h = (location.hash || '#jobs').slice(1);

  document.querySelectorAll('[data-nav]').forEach((el) => {
    const target = el.dataset.nav;
    const isActive =
      h === target ||
      (target === 'jobs' && h.startsWith('jobs')) ||
      (target === 'document-types' && h.startsWith('document-types')) ||
      (target === 'providers' && h.startsWith('providers')) ||
      (target === 'audit-log' && h.startsWith('audit-log'));
    el.classList.toggle('active', isActive);
  });

  if (h === 'jobs') return renderJobsList();
  if (h.startsWith('jobs/')) return renderJobDetail(h.slice(5));
  if (h === 'upload') return renderUpload();
  if (h === 'document-types') return renderDocumentTypesList();
  if (h === 'document-types/new') return renderDocumentTypeEditor(null);
  if (h.startsWith('document-types/')) return renderDocumentTypeEditor(h.slice('document-types/'.length));
  if (h === 'providers') return renderProvidersList();
  if (h === 'providers/new') return renderProviderEditor(null);
  if (h.startsWith('providers/')) return renderProviderEditor(h.slice('providers/'.length));
  if (h === 'audit-log') return renderAuditLog();
  if (h === 'settings') return renderSettings();
  location.hash = '#jobs';
}
window.addEventListener('hashchange', route);

// ============================================================
// Jobs list
// ============================================================

async function renderJobsList() {
  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Jobs',
        subtitle: 'Последние задачи обработки',
        actions: `<a href="#upload" class="btn-primary btn-md">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/></svg>
          New job
        </a>`,
      })}

      <div class="flex flex-wrap items-center gap-3 mb-4">
        <select id="filter-status" class="form-select" style="width: auto;">
          <option value="">Все статусы</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="done">Done</option>
          <option value="needs_review">Needs review</option>
          <option value="failed">Failed</option>
        </select>
        <select id="filter-type" class="form-select" style="width: auto;">
          <option value="">Все типы</option>
          <option value="invoice">invoice</option>
          <option value="factInvoice">factInvoice</option>
          <option value="UPD">UPD</option>
          <option value="TTN">TTN</option>
          <option value="CMR">CMR</option>
          <option value="AKT">AKT</option>
        </select>
        <button id="refresh-btn" class="btn-secondary btn-sm">Обновить</button>
        <span id="auto-refresh-indicator" class="text-xs text-slate-400 hidden">auto-refresh on</span>
      </div>

      <div id="jobs-table" class="card overflow-hidden">${loadingState()}</div>
    </div>
  `);

  const statusEl = document.getElementById('filter-status');
  const typeEl = document.getElementById('filter-type');
  const refreshEl = document.getElementById('refresh-btn');
  const autoEl = document.getElementById('auto-refresh-indicator');
  let pollTimer = null;

  async function load() {
    const params = new URLSearchParams();
    if (statusEl.value) params.set('status', statusEl.value);
    if (typeEl.value) params.set('document_type', typeEl.value);
    params.set('limit', '50');
    try {
      const data = await apiJson(`/jobs?${params.toString()}`);
      renderTable(data.items);
      const inflight = data.items.some((j) => j.status === 'pending' || j.status === 'processing');
      autoEl.classList.toggle('hidden', !inflight);
      return inflight;
    } catch (err) {
      document.getElementById('jobs-table').innerHTML = errorState(err.message);
      return false;
    }
  }

  function renderTable(items) {
    if (items.length === 0) {
      document.getElementById('jobs-table').innerHTML = `
        <div class="empty-state">
          <p class="empty-state-text">Задач пока нет.</p>
          <a href="#upload" class="empty-state-cta">Загрузить первый документ →</a>
        </div>`;
      return;
    }
    const rows = items.map((j) => `
      <tr class="row-clickable" data-job-id="${escapeHtml(j.job_id)}">
        <td class="font-mono text-xs text-slate-500">${escapeHtml(j.job_id.slice(0, 8))}</td>
        <td>${badge(j.status)}</td>
        <td>${escapeHtml(j.document_type ?? '—')}</td>
        <td class="truncate max-w-[12rem]" title="${escapeHtml(j.file_name)}">${escapeHtml(j.file_name)}</td>
        <td>${confidenceBar(j.confidence)}</td>
        <td>${(j.validation_issues?.length ?? 0) > 0
          ? `<span class="text-amber-600 dark:text-amber-400 font-medium">${j.validation_issues.length}</span>`
          : '<span class="text-slate-300 dark:text-slate-600">—</span>'}</td>
        <td class="text-xs text-slate-500" title="${escapeHtml(j.created_at)}">${escapeHtml(relativeTime(j.created_at))}</td>
      </tr>`).join('');
    document.getElementById('jobs-table').innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>ID</th><th>Status</th><th>Type</th><th>File</th>
            <th>Confidence</th><th>Issues</th><th>Created</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
    document.querySelectorAll('[data-job-id]').forEach((row) => {
      row.addEventListener('click', () => { location.hash = `#jobs/${row.dataset.jobId}`; });
    });
  }

  async function reloadAndScheduleNext() {
    const inflight = await load();
    if (inflight) pollTimer = setTimeout(reloadAndScheduleNext, 5000);
    else pollTimer = null;
  }

  statusEl.addEventListener('change', () => reloadAndScheduleNext());
  typeEl.addEventListener('change', () => reloadAndScheduleNext());
  refreshEl.addEventListener('click', () => reloadAndScheduleNext());

  await reloadAndScheduleNext();
  registerCleanup(() => { if (pollTimer) clearTimeout(pollTimer); });
}

// ============================================================
// Job detail
// ============================================================

async function renderJobDetail(jobId) {
  setView(`
    <div class="page-narrow">
      ${backLink('#jobs')}
      <div id="job-detail-content" class="space-y-4">${loadingState()}</div>
    </div>
  `);

  let pollTimer = null;
  let editing = false;

  async function load() {
    try {
      const job = await apiJson(`/jobs/${encodeURIComponent(jobId)}`);
      renderDetail(job);
      const inflight = job.status === 'pending' || job.status === 'processing';
      if (inflight && !editing) pollTimer = setTimeout(load, 2000);
      else pollTimer = null;
    } catch (err) {
      document.getElementById('job-detail-content').innerHTML = errorState(err.message);
    }
  }

  function renderDetail(job) {
    const issues = job.validation_issues || [];
    const extracted = job.extracted ?? {};

    document.getElementById('job-detail-content').innerHTML = `
      <!-- Header -->
      <div class="card card-body-lg">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2 mb-2 flex-wrap">
              ${badge(job.status)}
              ${job.document_type ? `<span class="text-sm text-slate-600 dark:text-slate-400">${escapeHtml(job.document_type)}</span>` : ''}
            </div>
            <h2 class="text-xl font-semibold truncate" title="${escapeHtml(job.file_name)}">${escapeHtml(job.file_name)}</h2>
            <div class="mt-2 flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 font-mono flex-wrap">
              <span>${escapeHtml(job.job_id)}</span>
              <span>${(job.file_size / 1024).toFixed(1)} KB</span>
              <span>${escapeHtml(job.mime_type)}</span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-xs text-slate-500 dark:text-slate-400 mb-1.5">Confidence</div>
            ${confidenceBar(job.confidence)}
            ${job.ocr_engine ? `<div class="text-xs text-slate-400 mt-2">via <span class="font-mono">${escapeHtml(job.ocr_engine)}</span></div>` : ''}
          </div>
        </div>
        ${job.error ? `
          <div class="mt-4 error-banner text-sm">
            <strong>Error:</strong> ${escapeHtml(job.error)}
          </div>` : ''}
      </div>

      ${issues.length > 0 ? `
        <div class="card">
          <div class="warning-banner rounded-xl border-0">
            <div class="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 text-amber-600 dark:text-amber-400"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/></svg>
              <h3 class="font-semibold">Validation issues (${issues.length})</h3>
            </div>
            <ul class="space-y-1.5">
              ${issues.map((i) => `<li class="text-sm flex gap-2"><span class="text-amber-500">•</span><span class="font-mono">${escapeHtml(i)}</span></li>`).join('')}
            </ul>
          </div>
        </div>` : ''}

      <!-- Extracted -->
      <div class="card overflow-hidden">
        <div class="card-header">
          <h3 class="card-title">Extracted data</h3>
          <div class="flex items-center gap-2">
            <button id="copy-json-btn" class="btn-secondary btn-xs">Copy</button>
            <button id="edit-btn" class="btn-accent-outline btn-xs">Edit</button>
          </div>
        </div>
        <div id="extracted-pane" class="card-body">
          <div class="bg-slate-50 dark:bg-slate-950 rounded-lg p-4 overflow-x-auto">${jsonTree(extracted)}</div>
        </div>
      </div>

      <!-- Raw text (collapsed) -->
      <details class="card">
        <summary class="card-header cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition list-none">
          <span class="card-title">Raw OCR text</span>
        </summary>
        <div class="card-body">
          <pre class="text-xs font-mono bg-slate-50 dark:bg-slate-950 p-4 rounded-lg whitespace-pre-wrap max-h-96 overflow-y-auto text-slate-700 dark:text-slate-300">${escapeHtml(job.raw_text || '(нет распознанного текста)')}</pre>
        </div>
      </details>

      ${job.metadata ? `
        <details class="card">
          <summary class="card-header cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition list-none">
            <span class="card-title">Client metadata</span>
          </summary>
          <div class="card-body">
            <div class="bg-slate-50 dark:bg-slate-950 rounded-lg p-4 overflow-x-auto">${jsonTree(job.metadata)}</div>
          </div>
        </details>` : ''}
    `;

    const copyBtn = document.getElementById('copy-json-btn');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(JSON.stringify(extracted, null, 2));
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
    });

    document.getElementById('edit-btn').addEventListener('click', () => {
      editing = true;
      if (pollTimer) clearTimeout(pollTimer);
      renderEditor(extracted);
    });
  }

  function renderEditor(currentExtracted) {
    const currentJson = JSON.stringify(currentExtracted, null, 2);
    document.getElementById('extracted-pane').innerHTML = `
      <div class="form-row">
        <textarea id="extracted-editor" class="form-textarea" rows="16" spellcheck="false">${escapeHtml(currentJson)}</textarea>
        <p id="editor-error" class="hidden form-error"></p>
        <p class="form-help">При сохранении статус станет <code class="font-mono">done</code>, валидация перезапустится автоматически.</p>
      </div>
      <div class="mt-3 flex items-center gap-2">
        <button id="save-btn" class="btn-primary btn-md">Save</button>
        <button id="cancel-btn" class="btn-secondary btn-md">Cancel</button>
      </div>
    `;
    document.getElementById('cancel-btn').addEventListener('click', () => {
      editing = false;
      load();
    });
    document.getElementById('save-btn').addEventListener('click', async () => {
      const text = document.getElementById('extracted-editor').value;
      const errEl = document.getElementById('editor-error');
      errEl.classList.add('hidden');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        errEl.textContent = `Invalid JSON: ${err.message}`;
        errEl.classList.remove('hidden');
        return;
      }
      try {
        await apiJson(`/jobs/${encodeURIComponent(jobId)}/extracted`, {
          method: 'PATCH',
          body: JSON.stringify(parsed),
        });
        editing = false;
        load();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  await load();
  registerCleanup(() => { if (pollTimer) clearTimeout(pollTimer); });
}

// ============================================================
// Upload
// ============================================================

function renderUpload() {
  setView(`
    <div class="page-narrow">
      ${pageHeader({ title: 'Upload', subtitle: 'Загрузить документ на обработку' })}

      <form id="upload-form" class="space-y-5">
        <div class="card card-body-lg">
          <div id="dropzone" class="dropzone border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-10 text-center cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-600 transition">
            <input type="file" id="file-input" class="hidden" accept=".pdf,.jpg,.jpeg,.png,.bmp,.tif,.tiff" />
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-12 h-12 mx-auto mb-3 text-slate-400"><path d="M11.47 1.72a.75.75 0 0 1 1.06 0l3 3a.75.75 0 0 1-1.06 1.06l-1.72-1.72V7.5h-1.5V4.06L9.53 5.78a.75.75 0 0 1-1.06-1.06l3-3ZM11.25 7.5V15a.75.75 0 0 0 1.5 0V7.5h3.75a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3h3.75Z"/></svg>
            <p id="dropzone-text" class="text-sm text-slate-600 dark:text-slate-400">
              Перетащи файл сюда или <span class="text-indigo-600 dark:text-indigo-400 font-medium">кликни чтобы выбрать</span>
            </p>
            <p class="text-xs text-slate-400 mt-1">PDF, JPG, PNG, BMP, TIFF · до 50 МБ</p>
          </div>
        </div>

        <div class="card card-body-lg">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="form-row">
              <label class="form-label">Document hint <span class="text-slate-400 font-normal">(опционально)</span></label>
              <select name="document_hint" class="form-select">
                <option value="">— auto-detect —</option>
                <option value="invoice">invoice</option>
                <option value="factInvoice">factInvoice</option>
                <option value="UPD">UPD</option>
                <option value="TTN">TTN</option>
                <option value="CMR">CMR</option>
                <option value="AKT">AKT</option>
              </select>
            </div>
            <div class="form-row">
              <label class="form-label">Webhook URL <span class="text-slate-400 font-normal">(опционально)</span></label>
              <input name="webhook_url" type="url" placeholder="https://..." class="form-input" />
            </div>
          </div>

          <div class="form-row mt-4">
            <label class="form-label">Metadata JSON <span class="text-slate-400 font-normal">(опционально)</span></label>
            <textarea name="metadata" rows="3" placeholder='{"my_id": "X-123"}' class="form-textarea"></textarea>
            <p class="form-help">Произвольный JSON; вернётся как есть в результате и webhook'е. Макс 64 KB.</p>
          </div>
        </div>

        <p id="upload-error" class="hidden form-error"></p>

        <div class="flex items-center justify-end">
          <button id="submit-btn" type="submit" disabled class="btn-primary btn-md">Загрузить</button>
        </div>
      </form>
    </div>
  `);

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const dropzoneText = document.getElementById('dropzone-text');
  const submitBtn = document.getElementById('submit-btn');
  const errEl = document.getElementById('upload-error');
  let selectedFile = null;

  function showFile(f) {
    selectedFile = f;
    dropzoneText.innerHTML = `
      <span class="text-slate-700 dark:text-slate-300 font-medium">${escapeHtml(f.name)}</span><br>
      <span class="text-xs text-slate-500">${(f.size / 1024).toFixed(1)} KB · ${escapeHtml(f.type || 'unknown')}</span>`;
    submitBtn.disabled = false;
  }

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) showFile(fileInput.files[0]);
  });
  ['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); });
  });
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files[0]) showFile(e.dataTransfer.files[0]);
  });

  document.getElementById('upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.add('hidden');
    if (!selectedFile) return;
    const form = new FormData();
    form.append('file', selectedFile);
    const formData = new FormData(e.target);
    const hint = formData.get('document_hint');
    const webhook = formData.get('webhook_url');
    const metaText = formData.get('metadata')?.toString().trim();
    if (hint) form.append('document_hint', hint);
    if (webhook) form.append('webhook_url', webhook);
    if (metaText) {
      try { JSON.parse(metaText); }
      catch {
        errEl.textContent = 'Metadata: невалидный JSON';
        errEl.classList.remove('hidden');
        return;
      }
      form.append('metadata', metaText);
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Загрузка...';
    try {
      const res = await api('/jobs', { method: 'POST', body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      location.hash = `#jobs/${data.job_id}`;
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Загрузить';
    }
  });
}

// ============================================================
// Document types
// ============================================================

async function renderDocumentTypesList() {
  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Document types',
        subtitle: 'Конфигурация типов документов: парсеры, поля, инструкции для агента, валидаторы',
        actions: `<a href="#document-types/new" class="btn-primary btn-md">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/></svg>
          Новый тип
        </a>`,
      })}

      <div class="info-banner mb-4">
        Каждый тип — slug + parser_kind + ожидаемые поля + инструкция для LLM + валидаторы. Editor сохраняет изменения в БД и сбрасывает кэш — следующие job'ы подхватят правки без рестарта.
      </div>

      <div id="dt-list" class="card overflow-hidden">${loadingState()}</div>
    </div>
  `);

  let data;
  try {
    data = await apiJson('/document-types');
  } catch (err) {
    document.getElementById('dt-list').innerHTML = errorState(err.message);
    return;
  }

  if (!data.items.length) {
    document.getElementById('dt-list').innerHTML = `
      <div class="empty-state">
        <p class="empty-state-text">Реестр пустой.</p>
        <p class="text-xs text-slate-400 mt-1">Запусти миграции: <code class="font-mono">npm run migrate</code></p>
      </div>`;
    return;
  }

  const rows = data.items.map((t) => {
    const flags = [
      t.is_builtin ? '<span class="badge badge-emerald">builtin</span>' : '',
      !t.is_active ? '<span class="badge badge-slate">inactive</span>' : '',
    ].filter(Boolean).join(' ');
    const conf = t.confidence_threshold !== null
      ? `<span class="font-mono">${t.confidence_threshold.toFixed(2)}</span>`
      : '<span class="text-slate-400 text-xs">default</span>';
    return `
      <tr class="row-clickable" data-slug="${escapeHtml(t.slug)}">
        <td class="font-mono text-xs text-slate-500">${escapeHtml(t.slug)}</td>
        <td class="font-medium">${escapeHtml(t.display_name)}</td>
        <td>${parserKindBadge(t.parser_kind)}</td>
        <td>${conf}</td>
        <td class="text-xs">${t.expected_fields.length} fields</td>
        <td class="text-xs">${t.validators.length} validators</td>
        <td class="flex gap-1 flex-wrap">${flags || '<span class="text-slate-300 dark:text-slate-600">—</span>'}</td>
      </tr>`;
  }).join('');

  document.getElementById('dt-list').innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>Slug</th><th>Display name</th><th>Parser</th><th>Confidence</th><th>Fields</th><th>Validators</th><th>Flags</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  document.querySelectorAll('[data-slug]').forEach((row) => {
    row.addEventListener('click', () => { location.hash = `#document-types/${row.dataset.slug}`; });
  });
}

/**
 * Document type editor — used for both "edit existing" (slug=string) and
 * "create new" (slug=null). State lives in a plain JS object that mirrors
 * the API shape; the form re-renders chip lists imperatively when items
 * are added/removed, but text inputs are bound by id and read at save time.
 */
async function renderDocumentTypeEditor(slug) {
  const isCreate = slug === null;
  setView(`
    <div class="page-narrow">
      ${backLink('#document-types')}
      <div id="dt-editor" class="space-y-4">${loadingState()}</div>
    </div>
  `);

  // --- Load existing or seed empty ---
  let t;
  if (isCreate) {
    t = {
      slug: '',
      display_name: '',
      description: '',
      is_active: true,
      is_builtin: false,
      parser_kind: 'llm_extract',
      llm_prompt: '',
      llm_schema: null,
      expected_fields: [],
      validators: [],
      confidence_threshold: null,
      regex_fallback_threshold: null,
      classification_keywords: [],
      metadata: null,
      created_at: null,
      updated_at: null,
    };
  } else {
    try {
      t = await apiJson(`/document-types/${encodeURIComponent(slug)}`);
    } catch (err) {
      document.getElementById('dt-editor').innerHTML = errorState(err.message);
      return;
    }
  }

  // --- State held outside DOM so chip add/remove is easy ---
  const state = {
    expected_fields: [...t.expected_fields],
    validators: [...t.validators],
    classification_keywords: [...t.classification_keywords],
  };

  const root = document.getElementById('dt-editor');
  root.innerHTML = renderEditorForm(t, isCreate);
  bindEditorHandlers(t, isCreate, state, root);

  // Для существующих типов — асинхронно подгрузить статистику и список
  // последних jobs, чтобы пользователь сразу видел реальное качество
  // обработки. Без блокировки editor'а — рендерится поверх через
  // отдельные DOM-узлы.
  if (!isCreate) {
    void loadTypeObservations(slug);
  }
}

/**
 * Подгружает /document-types/:slug/stats и /jobs и врендеривает их
 * в две panel'и: "Recent jobs" (последние 20 jobs этого типа со
 * статусом + confidence) и "Field coverage" (% jobs где каждое
 * expected_field фактически заполнено).
 *
 * Идея: после правки prompt'а или схемы открыл страницу типа и сразу
 * видишь как изменилось покрытие полей по новым jobs.
 */
async function loadTypeObservations(slug) {
  const obsRoot = document.getElementById('dt-observations');
  if (!obsRoot) return;

  obsRoot.innerHTML = `
    <div class="card card-body">${loadingState()}</div>
    <div class="card card-body">${loadingState()}</div>
  `;

  let stats, jobs;
  try {
    [stats, jobs] = await Promise.all([
      apiJson(`/document-types/${encodeURIComponent(slug)}/stats?days=30`),
      apiJson(`/document-types/${encodeURIComponent(slug)}/jobs?limit=20`),
    ]);
  } catch (err) {
    obsRoot.innerHTML = errorState(err.message);
    return;
  }

  obsRoot.innerHTML = `
    ${renderCoveragePanel(stats)}
    ${renderRecentJobsPanel(jobs.items)}
  `;

  obsRoot.querySelectorAll('[data-recent-job-id]').forEach((el) => {
    el.addEventListener('click', () => {
      location.hash = `#jobs/${el.dataset.recentJobId}`;
    });
  });
}

function renderCoveragePanel(stats) {
  const breakdown = stats.terminal_breakdown;
  const total = stats.total_jobs;
  const reviewPct = total === 0 ? 0 : Math.round((breakdown.needs_review / total) * 100);
  const failedPct = total === 0 ? 0 : Math.round((breakdown.failed / total) * 100);
  const donePct = total === 0 ? 0 : Math.round((breakdown.done / total) * 100);
  const avgConfLabel = stats.avg_confidence === null
    ? '—'
    : `${Math.round(stats.avg_confidence * 100)}%`;

  const coverageRows = (stats.expected_fields_coverage || []).map((c) => {
    const pct = Math.round(c.filled_pct * 100);
    const colorClass =
      pct >= 80 ? 'bg-emerald-500' :
      pct >= 50 ? 'bg-amber-500' :
      'bg-rose-500';
    return `
      <div class="grid grid-cols-[10rem_1fr_3.5rem] gap-3 items-center py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-b-0">
        <span class="font-mono text-xs">${escapeHtml(c.field)}</span>
        <div class="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
          <div class="h-full ${colorClass}" style="width:${pct}%"></div>
        </div>
        <span class="text-xs font-mono tabular-nums text-right text-slate-600 dark:text-slate-400">${pct}% <span class="text-slate-400">(${c.filled}/${c.total})</span></span>
      </div>`;
  }).join('');

  return `
    <div class="card card-body">
      <h3 class="card-title mb-1">Field coverage <span class="text-sm font-normal text-slate-500">за последние ${stats.period_days} дней</span></h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Для каждого <code class="font-mono">expected_field</code> — в скольких jobs это поле фактически
        заполнено в <code class="font-mono">extracted</code>. Это и есть «соответствие API»: если поле
        в схеме обещано, а извлекается в 60% случаев — promt или схему надо тюнить.
      </p>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
        <div class="card-body bg-slate-50 dark:bg-slate-950 rounded-lg p-3">
          <div class="text-xs text-slate-500 uppercase tracking-wide">Всего</div>
          <div class="text-xl font-semibold mt-1">${stats.total_jobs}</div>
        </div>
        <div class="card-body bg-slate-50 dark:bg-slate-950 rounded-lg p-3">
          <div class="text-xs text-slate-500 uppercase tracking-wide">Done</div>
          <div class="text-xl font-semibold mt-1 text-emerald-600 dark:text-emerald-400">${donePct}% <span class="text-xs text-slate-400">(${breakdown.done})</span></div>
        </div>
        <div class="card-body bg-slate-50 dark:bg-slate-950 rounded-lg p-3">
          <div class="text-xs text-slate-500 uppercase tracking-wide">Review</div>
          <div class="text-xl font-semibold mt-1 text-amber-600 dark:text-amber-400">${reviewPct}% <span class="text-xs text-slate-400">(${breakdown.needs_review})</span></div>
        </div>
        <div class="card-body bg-slate-50 dark:bg-slate-950 rounded-lg p-3">
          <div class="text-xs text-slate-500 uppercase tracking-wide">Avg confidence</div>
          <div class="text-xl font-semibold mt-1">${avgConfLabel}</div>
        </div>
      </div>

      ${coverageRows
        ? `<div class="border-t border-slate-200 dark:border-slate-800 pt-3">${coverageRows}</div>`
        : '<p class="text-sm text-slate-400">expected_fields не заданы — добавьте в редакторе сверху чтобы измерять покрытие.</p>'}

      ${failedPct > 0
        ? `<div class="warning-banner mt-3 text-xs">${failedPct}% jobs упали со статусом <code class="font-mono">failed</code> — проверьте логи воркера.</div>`
        : ''}
    </div>`;
}

function renderRecentJobsPanel(items) {
  if (items.length === 0) {
    return `
      <div class="card card-body">
        <h3 class="card-title mb-2">Последние документы</h3>
        <p class="text-sm text-slate-400">Пока ни одного job этого типа. Загрузите документ через <a href="#upload" class="text-indigo-600 hover:underline">Upload</a>.</p>
      </div>`;
  }
  const rows = items.map((j) => {
    const issuesBadge = (j.validation_issues?.length ?? 0) > 0
      ? `<span class="badge badge-amber text-[10px]">${j.validation_issues.length} issues</span>`
      : '';
    return `
      <tr class="row-clickable" data-recent-job-id="${escapeHtml(j.job_id)}">
        <td class="font-mono text-xs text-slate-500">${escapeHtml(j.job_id.slice(0, 8))}</td>
        <td>${badge(j.status)}</td>
        <td class="truncate max-w-[14rem]" title="${escapeHtml(j.file_name)}">${escapeHtml(j.file_name)}</td>
        <td>${confidenceBar(j.confidence)}</td>
        <td>${issuesBadge}</td>
        <td class="text-xs text-slate-500" title="${escapeHtml(j.created_at)}">${escapeHtml(relativeTime(j.created_at))}</td>
      </tr>`;
  }).join('');
  return `
    <div class="card overflow-hidden">
      <div class="card-header">
        <h3 class="card-title">Последние документы <span class="text-sm font-normal text-slate-500">(${items.length})</span></h3>
        <a href="#jobs" class="btn-ghost btn-xs">все →</a>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>ID</th><th>Status</th><th>File</th><th>Confidence</th><th>Issues</th><th>Created</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderEditorForm(t, isCreate) {
  const headerBadges = [
    !isCreate && t.is_builtin ? '<span class="badge badge-emerald">builtin</span>' : '',
    !isCreate && !t.is_active ? '<span class="badge badge-slate">inactive</span>' : '',
    isCreate ? '<span class="badge badge-indigo">new</span>' : '',
  ].filter(Boolean).join(' ');

  return `
    <div class="card card-body-lg">
      <div class="flex items-center gap-2 mb-2 flex-wrap">${headerBadges}</div>
      <h2 class="text-xl font-semibold">${isCreate ? 'Новый тип документа' : escapeHtml(t.display_name)}</h2>
      ${isCreate ? '' : `<div class="mt-1 font-mono text-xs text-slate-500">${escapeHtml(t.slug)}</div>`}
    </div>

    <!-- Basics -->
    <div class="card card-body space-y-4">
      <h3 class="card-title">Основное</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-row">
          <label class="form-label">Slug <span class="text-rose-500">*</span></label>
          <input id="f-slug" type="text" value="${escapeHtml(t.slug)}" ${isCreate ? '' : 'disabled'}
            placeholder="commercial_invoice"
            class="form-input font-mono" />
          <p class="form-help">${isCreate
            ? 'Уникальный ID. Только [A-Za-z0-9_-], не меняется после создания.'
            : 'Slug нельзя изменить — пересоздай тип, если нужно переименовать.'}</p>
        </div>
        <div class="form-row">
          <label class="form-label">Display name <span class="text-rose-500">*</span></label>
          <input id="f-display_name" type="text" value="${escapeHtml(t.display_name)}"
            placeholder="Коммерческий инвойс" class="form-input" />
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">Описание</label>
        <textarea id="f-description" rows="2" class="form-textarea" style="font-family: inherit;"
          placeholder="Короткое описание для оператора.">${escapeHtml(t.description || '')}</textarea>
      </div>
      <div class="flex items-center gap-6">
        <label class="inline-flex items-center gap-2">
          <input id="f-is_active" type="checkbox" ${t.is_active ? 'checked' : ''}
            class="rounded border-slate-300 dark:border-slate-700" />
          <span class="text-sm">Активен (классификатор и dropdown'ы включают этот тип)</span>
        </label>
      </div>
    </div>

    <!-- Parser kind -->
    <div class="card card-body space-y-4">
      <h3 class="card-title">Парсер</h3>
      <div class="form-row">
        <label class="form-label">parser_kind</label>
        <select id="f-parser_kind" class="form-select">
          <option value="builtin:invoice_regex" ${t.parser_kind === 'builtin:invoice_regex' ? 'selected' : ''}>builtin:invoice_regex — regex для счёта на оплату</option>
          <option value="builtin:upd_regex" ${t.parser_kind === 'builtin:upd_regex' ? 'selected' : ''}>builtin:upd_regex — regex для УПД / СФ</option>
          <option value="llm_extract" ${t.parser_kind === 'llm_extract' ? 'selected' : ''}>llm_extract — целиком через LLM /v1/extract</option>
        </select>
        <p class="form-help">Builtin'ы используют свои regex'ы + LLM-fallback при низкой уверенности. <code class="font-mono">llm_extract</code> сразу идёт в LLM.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-row">
          <label class="form-label">confidence_threshold</label>
          <input id="f-confidence_threshold" type="number" min="0" max="1" step="0.05"
            value="${t.confidence_threshold ?? ''}" placeholder="0.6 (env default)" class="form-input font-mono" />
          <p class="form-help">Ниже этого — статус <code class="font-mono">needs_review</code>. Пусто = брать из env.</p>
        </div>
        <div class="form-row">
          <label class="form-label">regex_fallback_threshold</label>
          <input id="f-regex_fallback_threshold" type="number" min="0" max="1" step="0.05"
            value="${t.regex_fallback_threshold ?? ''}" placeholder="0.7" class="form-input font-mono" />
          <p class="form-help">Только для builtin-парсеров. Ниже этого — regex отдаёт ход LLM.</p>
        </div>
      </div>
    </div>

    <!-- Expected fields -->
    <div class="card card-body space-y-2">
      <h3 class="card-title">Ожидаемые поля</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400">Парсер обязан попытаться извлечь эти поля. Что не нашлось → попадает в <code class="font-mono">missing</code>.</p>
      ${renderChipsInput('expected_fields', 'добавить поле и Enter', 'number, date, total, seller.inn, ...')}
    </div>

    <!-- Validators -->
    <div class="card card-body space-y-2">
      <h3 class="card-title">Валидаторы</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        Формат: <code class="font-mono">name</code> или <code class="font-mono">name:arg1,arg2</code>. Доступные:
        <code class="font-mono text-xs">inn_checksum</code>, <code class="font-mono text-xs">kpp_format</code>,
        <code class="font-mono text-xs">vehicle_plate</code>, <code class="font-mono text-xs">country_code</code>,
        <code class="font-mono text-xs">date_range</code>, <code class="font-mono text-xs">money_sanity</code>,
        <code class="font-mono text-xs">vat_consistency</code>, <code class="font-mono text-xs">parties_differ</code>,
        <code class="font-mono text-xs">weight_nett_le_gross</code>.
      </p>
      ${renderChipsInput('validators', 'добавить валидатор и Enter', 'inn_checksum:seller.inn')}
    </div>

    <!-- Classification keywords -->
    <div class="card card-body space-y-2">
      <h3 class="card-title">Ключи классификатора</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400">Регулярки. Если совпали с текстом OCR — классификатор присваивает этот тип. Без подсказки <code class="font-mono">document_hint</code> от клиента.</p>
      ${renderChipsInput('classification_keywords', 'добавить regex и Enter', '\\bсч[её]т-фактура\\b')}
    </div>

    <!-- Agent instruction (llm_prompt) -->
    <div class="card card-body space-y-2">
      <h3 class="card-title">Инструкция для LLM-агента</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        Что показывать модели вместе с текстом документа. <strong>Активно</strong> —
        runtime пробрасывает её в inference-service на каждый <code class="font-mono">/v1/extract</code>,
        backend подменяет ею встроенный prompt. Технический контракт ответа (валидный JSON
        c полями <code class="font-mono">extracted / confidence / issues</code>) добавляется
        автоматически — пишите только продуктовую часть.
        Пусто = builtin prompt для типа.
      </p>
      <textarea id="f-llm_prompt" rows="8" class="code-editor"
        placeholder="Ты — парсер транспортной накладной. Извлеки поля строго по JSON Schema. Все суммы — числами. ИНН — 10 или 12 цифр.">${escapeHtml(t.llm_prompt || '')}</textarea>
    </div>

    <!-- LLM schema -->
    <div class="card card-body space-y-2">
      <h3 class="card-title">JSON Schema для /extract</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400">JSON-схема, по которой LLM должна вернуть структуру. Пусто = builtin-схема из <code class="font-mono">document-json-schemas.ts</code>.</p>
      <textarea id="f-llm_schema" rows="14" class="code-editor"
        placeholder='{"type":"object","properties":{"number":{"type":"string"}, ...}}'>${t.llm_schema ? escapeHtml(JSON.stringify(t.llm_schema, null, 2)) : ''}</textarea>
      <p id="f-llm_schema-error" class="form-error hidden"></p>
    </div>

    <!-- Observations: загружается асинхронно для существующих типов -->
    ${!isCreate ? `<div id="dt-observations" class="space-y-4"></div>` : ''}

    <!-- Bookkeeping + actions -->
    ${!isCreate ? `
      <div class="card card-body">
        <h3 class="card-title mb-3">Bookkeeping</h3>
        <dl class="kv">
          <div class="kv-row"><dt class="kv-key">Created</dt><dd class="kv-value">${escapeHtml(t.created_at || '—')}</dd></div>
          <div class="kv-row"><dt class="kv-key">Updated</dt><dd class="kv-value">${escapeHtml(t.updated_at || '—')}</dd></div>
        </dl>
      </div>` : ''}

    <p id="editor-error" class="form-error hidden"></p>

    <div class="flex items-center justify-between gap-2 sticky bottom-0 bg-slate-50/95 dark:bg-slate-950/95 backdrop-blur-sm py-3 -mx-8 px-8 border-t border-slate-200 dark:border-slate-800">
      <div>
        ${!isCreate && !t.is_builtin ? `<button id="delete-btn" class="btn-danger btn-md">Удалить</button>` : ''}
        ${!isCreate && t.is_builtin ? `<span class="text-xs text-slate-500">builtin-типы нельзя удалить, можно деактивировать.</span>` : ''}
      </div>
      <div class="flex items-center gap-2">
        <a href="#audit-log" class="btn-ghost btn-sm">История</a>
        <a href="#document-types" class="btn-secondary btn-md">Отмена</a>
        <button id="save-btn" class="btn-primary btn-md">${isCreate ? 'Создать' : 'Сохранить'}</button>
      </div>
    </div>
  `;
}

/**
 * Render a chip-input block. The actual chip rendering is dynamic — done
 * in `redrawChips()` after creation so add/remove updates the DOM without
 * a full form re-render.
 */
function renderChipsInput(field, placeholder, exampleValue) {
  return `
    <div id="chips-${field}" class="chip-input"></div>
    <input id="chips-${field}-add" type="text" placeholder="${escapeHtml(placeholder)} (пример: ${escapeHtml(exampleValue)})"
      class="form-input font-mono text-xs" />`;
}

function bindEditorHandlers(originalRow, isCreate, state, root) {
  const redrawChips = (field) => {
    const container = root.querySelector(`#chips-${field}`);
    if (!container) return;
    if (state[field].length === 0) {
      container.innerHTML = `<span class="text-xs text-slate-400 px-1 py-0.5">—</span>`;
      return;
    }
    container.innerHTML = state[field].map((value, idx) => `
      <span class="chip">
        ${escapeHtml(value)}
        <span class="chip-remove" data-remove="${field}" data-idx="${idx}" title="Удалить">×</span>
      </span>`).join('');
    container.querySelectorAll('[data-remove]').forEach((el) => {
      el.addEventListener('click', () => {
        const f = el.dataset.remove;
        const i = Number(el.dataset.idx);
        state[f].splice(i, 1);
        redrawChips(f);
      });
    });
  };

  ['expected_fields', 'validators', 'classification_keywords'].forEach((field) => {
    redrawChips(field);
    const addInput = root.querySelector(`#chips-${field}-add`);
    if (!addInput) return;
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = addInput.value.trim();
        if (v && !state[field].includes(v)) {
          state[field].push(v);
          redrawChips(field);
        }
        addInput.value = '';
      }
    });
  });

  // Delete button
  const delBtn = root.querySelector('#delete-btn');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Удалить тип "${originalRow.slug}"? Это необратимо.`)) return;
      try {
        const res = await api(`/document-types/${encodeURIComponent(originalRow.slug)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
          const t = await res.text();
          throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
        }
        location.hash = '#document-types';
      } catch (err) {
        showEditorError(root, err.message);
      }
    });
  }

  // Save / Create
  root.querySelector('#save-btn').addEventListener('click', async () => {
    const errEl = root.querySelector('#editor-error');
    errEl.classList.add('hidden');
    const schemaErrEl = root.querySelector('#f-llm_schema-error');
    schemaErrEl.classList.add('hidden');

    // Parse JSON-schema textarea (empty = null = use builtin)
    const schemaRaw = root.querySelector('#f-llm_schema').value.trim();
    let schema = null;
    if (schemaRaw) {
      try {
        schema = JSON.parse(schemaRaw);
      } catch (err) {
        schemaErrEl.textContent = `JSON Schema: невалидный JSON — ${err.message}`;
        schemaErrEl.classList.remove('hidden');
        return;
      }
    }

    const promptRaw = root.querySelector('#f-llm_prompt').value;
    const confRaw = root.querySelector('#f-confidence_threshold').value;
    const regexThrRaw = root.querySelector('#f-regex_fallback_threshold').value;

    const payload = {
      display_name: root.querySelector('#f-display_name').value.trim(),
      description: root.querySelector('#f-description').value.trim() || null,
      is_active: root.querySelector('#f-is_active').checked,
      parser_kind: root.querySelector('#f-parser_kind').value,
      llm_prompt: promptRaw.trim() || null,
      llm_schema: schema,
      expected_fields: [...state.expected_fields],
      validators: [...state.validators],
      confidence_threshold: confRaw === '' ? null : Number(confRaw),
      regex_fallback_threshold: regexThrRaw === '' ? null : Number(regexThrRaw),
      classification_keywords: [...state.classification_keywords],
    };

    try {
      if (isCreate) {
        const slug = root.querySelector('#f-slug').value.trim();
        if (!slug) throw new Error('slug обязателен');
        if (!payload.display_name) throw new Error('display_name обязателен');
        const data = await apiJson('/document-types', {
          method: 'POST',
          body: JSON.stringify({ slug, ...payload }),
        });
        location.hash = `#document-types/${data.slug}`;
      } else {
        await apiJson(`/document-types/${encodeURIComponent(originalRow.slug)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        // Stay on the same page to confirm save visually
        flashSave(root);
      }
    } catch (err) {
      showEditorError(root, err.message);
    }
  });
}

function showEditorError(root, message) {
  const el = root.querySelector('#editor-error');
  el.textContent = message;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function flashSave(root) {
  const btn = root.querySelector('#save-btn');
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = 'Сохранено ✓';
  btn.classList.add('bg-emerald-600', 'hover:bg-emerald-700');
  btn.classList.remove('bg-indigo-600', 'hover:bg-indigo-700');
  setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove('bg-emerald-600', 'hover:bg-emerald-700');
    btn.classList.add('bg-indigo-600', 'hover:bg-indigo-700');
  }, 1200);
}

// ============================================================
// Providers (LLM keys + OCR engines)
// ============================================================

const PROVIDER_KIND_BADGE = {
  llm: { label: 'LLM', variant: 'badge-violet' },
  ocr: { label: 'OCR', variant: 'badge-sky' },
};

async function renderProvidersList() {
  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Providers',
        subtitle: 'API-ключи и endpoint-ы для LLM (Anthropic, OpenAI, локальные) и OCR (Tesseract, Yandex)',
        actions: `<a href="#providers/new" class="btn-primary btn-md">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/></svg>
          Новый
        </a>`,
      })}

      <div class="info-banner mb-4">
        Ключи шифруются (AES-256-GCM) перед записью в БД и расшифровываются мастер-ключом из <code class="font-mono">SECRETS_ENCRYPTION_KEY</code> только в момент использования. В API возвращается только маска <code class="font-mono">••••XXXX</code>. Активный по умолчанию для каждого kind помечается флагом <strong>default</strong>. Изменения подхватываются hot-path'ом без рестарта (TTL 30s).
      </div>

      <div id="providers-list" class="space-y-3">${loadingState()}</div>
    </div>
  `);

  let data;
  try {
    data = await apiJson('/provider-settings');
  } catch (err) {
    document.getElementById('providers-list').innerHTML = errorState(err.message);
    return;
  }

  if (!data.items.length) {
    document.getElementById('providers-list').innerHTML = `
      <div class="card empty-state">
        <p class="empty-state-text">Провайдеров пока нет.</p>
        <a href="#providers/new" class="empty-state-cta">Добавить первый →</a>
      </div>`;
    return;
  }

  // Group by kind for clearer reading
  const byKind = { llm: [], ocr: [] };
  data.items.forEach((p) => {
    if (byKind[p.kind]) byKind[p.kind].push(p);
  });

  const renderRow = (p) => `
    <div class="card card-body cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/30 transition" data-id="${escapeHtml(p.id)}">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="font-medium">${escapeHtml(p.display_name)}</span>
            <span class="badge ${PROVIDER_KIND_BADGE[p.kind]?.variant ?? 'badge-slate'}">${PROVIDER_KIND_BADGE[p.kind]?.label ?? p.kind}</span>
            ${p.is_default ? '<span class="badge badge-indigo">default</span>' : ''}
            ${!p.is_active ? '<span class="badge badge-slate">inactive</span>' : ''}
            ${p.has_api_key ? '<span class="badge badge-emerald">key set</span>' : '<span class="badge badge-rose">no key</span>'}
          </div>
          <div class="font-mono text-xs text-slate-500">${escapeHtml(p.id)}</div>
          ${p.description ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-2">${escapeHtml(p.description)}</div>` : ''}
        </div>
        <div class="text-right shrink-0 space-y-1">
          ${p.model ? `<div class="text-xs font-mono text-slate-400">${escapeHtml(p.model)}</div>` : ''}
          ${p.base_url ? `<div class="text-xs font-mono text-slate-400 truncate max-w-[14rem]" title="${escapeHtml(p.base_url)}">${escapeHtml(p.base_url)}</div>` : ''}
          ${p.api_key_masked ? `<div class="text-xs font-mono text-slate-400">key: ${escapeHtml(p.api_key_masked)}</div>` : ''}
        </div>
      </div>
    </div>`;

  document.getElementById('providers-list').innerHTML = `
    <div class="card card-body">
      <h3 class="card-title mb-3">LLM провайдеры <span class="text-sm font-normal text-slate-500">(${byKind.llm.length})</span></h3>
      <div class="space-y-2">
        ${byKind.llm.length ? byKind.llm.map(renderRow).join('') : '<p class="text-sm text-slate-400">— нет</p>'}
      </div>
    </div>
    <div class="card card-body">
      <h3 class="card-title mb-3">OCR движки <span class="text-sm font-normal text-slate-500">(${byKind.ocr.length})</span></h3>
      <div class="space-y-2">
        ${byKind.ocr.length ? byKind.ocr.map(renderRow).join('') : '<p class="text-sm text-slate-400">— нет</p>'}
      </div>
    </div>
  `;

  document.querySelectorAll('[data-id]').forEach((row) => {
    row.addEventListener('click', () => {
      location.hash = `#providers/${row.dataset.id}`;
    });
  });
}

async function renderProviderEditor(id) {
  const isCreate = id === null;
  setView(`
    <div class="page-narrow">
      ${backLink('#providers')}
      <div id="prov-editor" class="space-y-4">${loadingState()}</div>
    </div>
  `);

  let p;
  if (isCreate) {
    p = {
      id: '',
      kind: 'llm',
      display_name: '',
      description: '',
      base_url: '',
      api_key_masked: null,
      has_api_key: false,
      model: '',
      is_active: true,
      is_default: false,
      extra: null,
      created_at: null,
      updated_at: null,
    };
  } else {
    try {
      p = await apiJson(`/provider-settings/${encodeURIComponent(id)}`);
    } catch (err) {
      document.getElementById('prov-editor').innerHTML = errorState(err.message);
      return;
    }
  }

  const root = document.getElementById('prov-editor');
  root.innerHTML = renderProviderForm(p, isCreate);
  bindProviderHandlers(p, isCreate, root);
}

function renderProviderForm(p, isCreate) {
  const headerBadges = [
    p.is_default ? '<span class="badge badge-indigo">default</span>' : '',
    p.has_api_key ? '<span class="badge badge-emerald">key set</span>' : '',
    !p.is_active && !isCreate ? '<span class="badge badge-slate">inactive</span>' : '',
    isCreate ? '<span class="badge badge-indigo">new</span>' : '',
  ].filter(Boolean).join(' ');

  return `
    <div class="card card-body-lg">
      <div class="flex items-center gap-2 mb-2 flex-wrap">${headerBadges}</div>
      <h2 class="text-xl font-semibold">${isCreate ? 'Новый провайдер' : escapeHtml(p.display_name)}</h2>
      ${isCreate ? '' : `<div class="mt-1 font-mono text-xs text-slate-500">${escapeHtml(p.id)}</div>`}
    </div>

    <div class="card card-body space-y-4">
      <h3 class="card-title">Идентификация</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-row">
          <label class="form-label">ID <span class="text-rose-500">*</span></label>
          <input id="f-id" type="text" value="${escapeHtml(p.id)}" ${isCreate ? '' : 'disabled'}
            placeholder="anthropic" class="form-input font-mono" />
          <p class="form-help">${isCreate ? 'Lowercase, только [a-z0-9_-].' : 'ID нельзя изменить — пересоздай если нужно.'}</p>
        </div>
        <div class="form-row">
          <label class="form-label">Kind</label>
          <select id="f-kind" class="form-select" ${isCreate ? '' : 'disabled'}>
            <option value="llm" ${p.kind === 'llm' ? 'selected' : ''}>llm — LLM провайдер</option>
            <option value="ocr" ${p.kind === 'ocr' ? 'selected' : ''}>ocr — OCR движок</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">Display name <span class="text-rose-500">*</span></label>
        <input id="f-display_name" type="text" value="${escapeHtml(p.display_name)}"
          placeholder="Anthropic Claude" class="form-input" />
      </div>
      <div class="form-row">
        <label class="form-label">Описание</label>
        <textarea id="f-description" rows="2" class="form-textarea" style="font-family: inherit;">${escapeHtml(p.description || '')}</textarea>
      </div>
      <label class="inline-flex items-center gap-2">
        <input id="f-is_active" type="checkbox" ${p.is_active ? 'checked' : ''} class="rounded border-slate-300 dark:border-slate-700" />
        <span class="text-sm">Активен</span>
      </label>
    </div>

    <div class="card card-body space-y-4">
      <h3 class="card-title">Connection</h3>
      <div class="form-row">
        <label class="form-label">Base URL</label>
        <input id="f-base_url" type="text" value="${escapeHtml(p.base_url || '')}"
          placeholder="https://api.anthropic.com или http://inference:8000" class="form-input font-mono" />
        <p class="form-help">Пусто = SDK-defaults (для Anthropic/OpenAI) или fallback к <code class="font-mono">LLM_INFERENCE_URL</code> из env.</p>
      </div>
      <div class="form-row">
        <label class="form-label">API key</label>
        <input id="f-api_key" type="password" value="" autocomplete="off"
          placeholder="${p.has_api_key ? `текущий: ${escapeHtml(p.api_key_masked || '')} — оставь пусто чтобы не менять` : 'sk-ant-... или ya-...'}"
          class="form-input font-mono" />
        <p class="form-help">Хранится в БД, в API возвращается только маска. ${p.has_api_key ? 'Пусто = оставить текущий. Чтобы стереть — нажми «Очистить ключ».' : ''}</p>
      </div>
      <div class="form-row">
        <label class="form-label">Model</label>
        <input id="f-model" type="text" value="${escapeHtml(p.model || '')}"
          placeholder="claude-sonnet-4-5 / gpt-4o-mini / qwen2.5-vl-7b-instruct" class="form-input font-mono" />
      </div>
      <div class="flex items-center gap-2 pt-2">
        <button id="test-btn" class="btn-secondary btn-sm" ${isCreate ? 'disabled title="Сначала сохраните"' : ''}>Проверить связь</button>
        <span id="test-result" class="text-xs text-slate-500"></span>
      </div>
    </div>

    <p id="editor-error" class="form-error hidden"></p>

    <div class="flex items-center justify-between gap-2 sticky bottom-0 bg-slate-50/95 dark:bg-slate-950/95 backdrop-blur-sm py-3 -mx-8 px-8 border-t border-slate-200 dark:border-slate-800">
      <div class="flex items-center gap-2">
        ${!isCreate ? `<button id="delete-btn" class="btn-danger btn-md">Удалить</button>` : ''}
        ${!isCreate && p.has_api_key ? `<button id="clear-key-btn" class="btn-ghost btn-sm">Очистить ключ</button>` : ''}
        ${!isCreate && !p.is_default ? `<button id="set-default-btn" class="btn-accent-outline btn-sm">Сделать default</button>` : ''}
      </div>
      <div class="flex items-center gap-2">
        <a href="#audit-log?entity=provider_setting${isCreate ? '' : `&entity_id=${encodeURIComponent(p.id)}`}" class="btn-ghost btn-sm">История</a>
        <a href="#providers" class="btn-secondary btn-md">Отмена</a>
        <button id="save-btn" class="btn-primary btn-md">${isCreate ? 'Создать' : 'Сохранить'}</button>
      </div>
    </div>
  `;
}

function bindProviderHandlers(originalRow, isCreate, root) {
  const errEl = root.querySelector('#editor-error');

  const collectPayload = () => {
    const apiKeyRaw = root.querySelector('#f-api_key').value;
    return {
      kind: root.querySelector('#f-kind').value,
      display_name: root.querySelector('#f-display_name').value.trim(),
      description: root.querySelector('#f-description').value.trim() || null,
      base_url: root.querySelector('#f-base_url').value.trim() || null,
      // Пустой инпут = не менять (в PATCH не отправляем поле api_key)
      api_key: apiKeyRaw === '' ? undefined : apiKeyRaw,
      model: root.querySelector('#f-model').value.trim() || null,
      is_active: root.querySelector('#f-is_active').checked,
    };
  };

  root.querySelector('#save-btn').addEventListener('click', async () => {
    errEl.classList.add('hidden');
    const payload = collectPayload();
    if (!payload.display_name) {
      errEl.textContent = 'display_name обязателен';
      errEl.classList.remove('hidden');
      return;
    }
    try {
      if (isCreate) {
        const id = root.querySelector('#f-id').value.trim();
        if (!id) throw new Error('id обязателен');
        // На create передаём kind + id, api_key если есть
        const body = { id, ...payload };
        if (body.api_key === undefined) delete body.api_key;
        const data = await apiJson('/provider-settings', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        location.hash = `#providers/${data.id}`;
      } else {
        // PATCH: убираем поля, которые на update не меняем
        delete payload.kind;
        if (payload.api_key === undefined) delete payload.api_key;
        await apiJson(`/provider-settings/${encodeURIComponent(originalRow.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        flashSave(root);
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // Delete
  const delBtn = root.querySelector('#delete-btn');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Удалить провайдера "${originalRow.id}"?`)) return;
      try {
        const res = await api(`/provider-settings/${encodeURIComponent(originalRow.id)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        location.hash = '#providers';
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  // Clear API key
  const clearBtn = root.querySelector('#clear-key-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Стереть API key? Провайдер перестанет авторизовываться.')) return;
      try {
        await apiJson(`/provider-settings/${encodeURIComponent(originalRow.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ api_key: null }),
        });
        renderProviderEditor(originalRow.id);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  // Set default
  const defaultBtn = root.querySelector('#set-default-btn');
  if (defaultBtn) {
    defaultBtn.addEventListener('click', async () => {
      try {
        await apiJson(`/provider-settings/${encodeURIComponent(originalRow.id)}/set-default`, {
          method: 'POST',
        });
        renderProviderEditor(originalRow.id);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  // Test connection
  const testBtn = root.querySelector('#test-btn');
  if (testBtn && !isCreate) {
    testBtn.addEventListener('click', async () => {
      const resultEl = root.querySelector('#test-result');
      resultEl.textContent = '…';
      resultEl.className = 'text-xs text-slate-500';
      try {
        const res = await apiJson(`/provider-settings/${encodeURIComponent(originalRow.id)}/test`, {
          method: 'POST',
        });
        if (res.ok) {
          resultEl.textContent = `OK · HTTP ${res.status ?? '?'} · ${res.latency_ms ?? '?'} ms`;
          resultEl.className = 'text-xs text-emerald-600 dark:text-emerald-400 font-medium';
        } else {
          resultEl.textContent = `FAIL · ${res.message || `HTTP ${res.status}`}`;
          resultEl.className = 'text-xs text-rose-600 dark:text-rose-400 font-medium';
        }
      } catch (err) {
        resultEl.textContent = `error · ${err.message}`;
        resultEl.className = 'text-xs text-rose-600 dark:text-rose-400 font-medium';
      }
    });
  }
}

// ============================================================
// Audit log
// ============================================================

const AUDIT_ACTION_BADGE = {
  create: { label: 'create', variant: 'badge-emerald' },
  update: { label: 'update', variant: 'badge-indigo' },
  delete: { label: 'delete', variant: 'badge-rose' },
};
const AUDIT_ENTITY_LABEL = {
  document_type: 'Document type',
  provider_setting: 'Provider',
};

async function renderAuditLog() {
  // Поддерживаем query-параметры в hash для глубоких ссылок типа
  // #audit-log?entity=provider_setting&entity_id=anthropic
  const hashPart = (location.hash || '').split('?')[1] || '';
  const params = new URLSearchParams(hashPart);
  const filterEntity = params.get('entity') || '';
  const filterEntityId = params.get('entity_id') || '';

  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Audit log',
        subtitle: 'История админ-изменений document_types и provider_settings',
      })}

      <div class="info-banner mb-4">
        Срок хранения — настраивается через <code class="font-mono">AUDIT_LOG_RETENTION_DAYS</code>
        (дефолт 365 дней). Старые записи фоново удаляются раз в сутки;
        текущее значение видно в <a href="#settings" class="font-medium underline">Settings → Storage &amp; sweepers</a>.
      </div>

      <div class="flex flex-wrap items-center gap-3 mb-4">
        <select id="audit-entity" class="form-select" style="width: auto;">
          <option value="" ${filterEntity === '' ? 'selected' : ''}>Всё</option>
          <option value="document_type" ${filterEntity === 'document_type' ? 'selected' : ''}>Document types</option>
          <option value="provider_setting" ${filterEntity === 'provider_setting' ? 'selected' : ''}>Providers</option>
        </select>
        <input id="audit-entity-id" type="text" placeholder="entity id (slug или provider id)"
          value="${escapeHtml(filterEntityId)}" class="form-input" style="width: 14rem;" />
        <button id="audit-refresh" class="btn-secondary btn-sm">Обновить</button>
      </div>

      <div id="audit-list" class="space-y-2">${loadingState()}</div>
    </div>
  `);

  const entityEl = document.getElementById('audit-entity');
  const entityIdEl = document.getElementById('audit-entity-id');
  const refreshEl = document.getElementById('audit-refresh');

  async function load() {
    const qs = new URLSearchParams();
    if (entityEl.value) qs.set('entity', entityEl.value);
    if (entityIdEl.value.trim()) qs.set('entity_id', entityIdEl.value.trim());
    qs.set('limit', '100');
    try {
      const data = await apiJson(`/audit-log?${qs.toString()}`);
      renderRows(data.items);
    } catch (err) {
      document.getElementById('audit-list').innerHTML = errorState(err.message);
    }
  }

  function renderRows(items) {
    if (!items.length) {
      document.getElementById('audit-list').innerHTML = `
        <div class="card empty-state">
          <p class="empty-state-text">История пуста.</p>
        </div>`;
      return;
    }
    document.getElementById('audit-list').innerHTML = items.map(renderAuditRow).join('');
  }

  function renderAuditRow(row) {
    const action = AUDIT_ACTION_BADGE[row.action] ?? { label: row.action, variant: 'badge-slate' };
    const entityLabel = AUDIT_ENTITY_LABEL[row.entity] ?? row.entity;
    const diff = row.diff ?? {};
    const diffRows = Object.entries(diff).map(([k, v]) => `
      <div class="audit-diff-row">
        <span class="text-slate-500 truncate" title="${escapeHtml(k)}">${escapeHtml(k)}</span>
        <span class="audit-diff-from truncate" title='${escapeHtml(JSON.stringify(v.from))}'>${escapeHtml(formatDiffValue(v.from))}</span>
        <span class="audit-diff-to truncate" title='${escapeHtml(JSON.stringify(v.to))}'>${escapeHtml(formatDiffValue(v.to))}</span>
      </div>`).join('');

    return `
      <details class="card">
        <summary class="card-body cursor-pointer list-none hover:bg-slate-50 dark:hover:bg-slate-800/30 transition">
          <div class="flex items-center justify-between gap-4 flex-wrap">
            <div class="flex items-center gap-2 flex-wrap min-w-0">
              <span class="badge ${action.variant}">${action.label}</span>
              <span class="text-sm font-medium">${entityLabel}</span>
              <span class="font-mono text-xs text-slate-500">${escapeHtml(row.entity_id)}</span>
            </div>
            <div class="flex items-center gap-3 text-xs text-slate-500">
              <span>by <span class="font-medium">${escapeHtml(row.actor)}</span></span>
              <span title="${escapeHtml(row.at)}">${escapeHtml(relativeTime(row.at))}</span>
            </div>
          </div>
          ${Object.keys(diff).length ? `
            <div class="mt-2 text-xs text-slate-500">${Object.keys(diff).length} fields changed</div>
          ` : ''}
        </summary>
        <div class="card-section">
          ${Object.keys(diff).length ? `
            <div class="audit-diff-row font-medium text-slate-500 uppercase tracking-wider" style="font-size: 10px;">
              <span>field</span><span>before</span><span>after</span>
            </div>
            ${diffRows}
          ` : '<p class="text-xs text-slate-400">No field-level diff.</p>'}
          <details class="mt-3">
            <summary class="text-xs text-slate-400 cursor-pointer">raw before/after</summary>
            <div class="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div class="text-xs text-slate-500 mb-1">before</div>
                <div class="bg-slate-50 dark:bg-slate-950 p-2 rounded text-xs">${row.before ? jsonTree(row.before) : '<span class="text-slate-400">—</span>'}</div>
              </div>
              <div>
                <div class="text-xs text-slate-500 mb-1">after</div>
                <div class="bg-slate-50 dark:bg-slate-950 p-2 rounded text-xs">${row.after ? jsonTree(row.after) : '<span class="text-slate-400">—</span>'}</div>
              </div>
            </div>
          </details>
        </div>
      </details>`;
  }

  entityEl.addEventListener('change', load);
  entityIdEl.addEventListener('change', load);
  entityIdEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  refreshEl.addEventListener('click', load);

  await load();
}

function formatDiffValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ============================================================
// Settings
// ============================================================

async function renderSettings() {
  setView(`
    <div class="page-narrow">
      ${pageHeader({ title: 'Settings', subtitle: 'Конфигурация сервиса и LLM-провайдеров' })}
      <div id="settings-content" class="space-y-4">${loadingState()}</div>
    </div>
  `);

  let settings;
  let providers;
  try {
    [settings, providers] = await Promise.all([
      apiJson('/settings'),
      apiJson('/providers/status'),
    ]);
  } catch (err) {
    document.getElementById('settings-content').innerHTML = errorState(err.message);
    return;
  }

  document.getElementById('settings-content').innerHTML = `
    ${renderProvidersCard(providers)}
    ${renderOcrCard(settings)}
    ${renderStorageCard(settings)}
    ${renderLimitsCard(settings)}
    ${renderEndpointsCard()}
    ${renderSessionCard()}
  `;

  document.getElementById('logout-from-settings')?.addEventListener('click', () => {
    auth.token = null;
    showLogin();
  });
}

function renderProvidersCard(providers) {
  const head = (status, body) => `
    <div class="card card-body">
      <div class="flex items-center justify-between mb-3">
        <h3 class="card-title">LLM upstream <span class="text-sm font-normal text-slate-500">(inference-service)</span></h3>
        <div class="flex items-center gap-2">
          ${status}
          <a href="#providers" class="btn-ghost btn-xs">→ Provider keys</a>
        </div>
      </div>
      ${body}
    </div>`;

  if (providers.upstream === 'not_configured') {
    return head(
      '<span class="badge badge-slate">not connected</span>',
      `<p class="text-sm text-slate-600 dark:text-slate-400">inference-service не подключён (<code class="font-mono text-xs">LLM_INFERENCE_URL</code> пустой). Phase 2 парсеры (ТТН/CMR/АКТ) деградируют до пустых результатов и needs_review.</p>`,
    );
  }
  if (providers.upstream === 'unreachable') {
    return head(
      '<span class="badge badge-rose">unreachable</span>',
      `<div class="error-banner text-sm">
        <p class="font-medium">inference-service недоступен</p>
        ${providers.error ? `<p class="font-mono text-xs mt-1">${escapeHtml(providers.error)}</p>` : ''}
      </div>`,
    );
  }

  const available = providers.available || {};
  const active = providers.active;
  const rows = Object.entries(available).map(([name, info]) => {
    const isActive = name === active;
    const configBadge = info.configured
      ? '<span class="badge badge-emerald">configured</span>'
      : '<span class="badge badge-slate">not configured</span>';
    const activeBadge = isActive ? '<span class="badge badge-indigo">active</span>' : '';
    return `
      <div class="flex items-start gap-4 p-3 rounded-lg ${isActive ? 'bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900' : 'bg-slate-50/50 dark:bg-slate-950/30'}">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="font-mono text-sm font-medium">${escapeHtml(name)}</span>
            ${activeBadge}
            ${configBadge}
          </div>
          <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(info.description || '')}</div>
          ${info.model ? `<div class="text-xs text-slate-400 dark:text-slate-500 font-mono mt-0.5">${escapeHtml(info.model)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  return head(
    '<span class="badge badge-emerald">connected</span>',
    `<p class="text-xs text-slate-500 dark:text-slate-400 mb-3">Активный бэкенд переключается через <code class="font-mono">BACKEND=</code> в env inference-service. Требует рестарта контейнера.</p>
     <div class="space-y-2">${rows || '<p class="text-sm text-slate-400">провайдеров нет</p>'}</div>`,
  );
}

function renderOcrCard(settings) {
  const t = settings.thresholds;
  const eng = settings.ocr_engines;
  return `
    <div class="card card-body">
      <h3 class="card-title mb-3">OCR pipeline</h3>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div class="kv-row"><dt class="kv-key">pdf-parse accept</dt><dd class="kv-value">${t.pdf_text}</dd></div>
        <div class="kv-row"><dt class="kv-key">tesseract accept</dt><dd class="kv-value">${t.tesseract}</dd></div>
        <div class="kv-row"><dt class="kv-key">vision-llm accept</dt><dd class="kv-value">${t.vision_llm}</dd></div>
        <div class="kv-row"><dt class="kv-key">needs_review threshold</dt><dd class="kv-value">${t.needs_review}</dd></div>
        <div class="kv-row"><dt class="kv-key">regex-fallback threshold</dt><dd class="kv-value">${t.regex_fallback}</dd></div>
        <div class="kv-row"><dt class="kv-key">tesseract langs</dt><dd class="kv-value">${escapeHtml(eng.tesseract_langs)}</dd></div>
      </dl>
      <div class="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
        <div class="kv-row">
          <span class="kv-key text-sm">vision-llm engine</span>
          ${eng.vision_llm.enabled
            ? '<span class="badge badge-emerald">enabled</span>'
            : '<span class="badge badge-slate">disabled</span>'}
        </div>
        ${eng.vision_llm.url ? `<div class="text-xs font-mono text-slate-400">${escapeHtml(eng.vision_llm.url)}</div>` : ''}
        <div class="kv-row">
          <span class="kv-key text-sm">yandex-vision engine</span>
          ${eng.yandex_vision.enabled
            ? '<span class="badge badge-amber">enabled</span>'
            : '<span class="badge badge-slate">disabled</span>'}
        </div>
        ${eng.yandex_vision.enabled ? `
          <div class="warning-banner text-xs">
            <strong>⚠</strong> ${escapeHtml(eng.yandex_vision.pii_warning)}
          </div>` : ''}
      </div>
    </div>`;
}

function renderStorageCard(settings) {
  return `
    <div class="card card-body">
      <h3 class="card-title mb-3">Storage &amp; sweepers</h3>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div class="kv-row"><dt class="kv-key">backend</dt><dd class="kv-value">${escapeHtml(settings.storage.backend)}</dd></div>
        <div class="kv-row"><dt class="kv-key">dir</dt><dd class="kv-value">${escapeHtml(settings.storage.dir)}</dd></div>
        <div class="kv-row"><dt class="kv-key">file retention</dt><dd class="kv-value">${settings.storage.retention_days} days</dd></div>
        <div class="kv-row"><dt class="kv-key">worker concurrency</dt><dd class="kv-value">${settings.worker.concurrency}</dd></div>
        <div class="kv-row"><dt class="kv-key">pending sweep</dt><dd class="kv-value">${settings.sweepers.pending_interval_ms / 1000}s (grace ${settings.sweepers.pending_grace_seconds}s)</dd></div>
        <div class="kv-row"><dt class="kv-key">cleanup sweep</dt><dd class="kv-value">${settings.sweepers.file_cleanup_interval_ms / 60000} min</dd></div>
        <div class="kv-row"><dt class="kv-key">audit retention</dt><dd class="kv-value">${settings.sweepers.audit_log_retention_days} days (sweep every ${Math.round(settings.sweepers.audit_log_interval_ms / 3600000)}h)</dd></div>
      </dl>
    </div>`;
}

function renderLimitsCard(settings) {
  return `
    <div class="card card-body">
      <h3 class="card-title mb-3">Limits &amp; secrets</h3>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div class="kv-row"><dt class="kv-key">max upload</dt><dd class="kv-value">${settings.limits.max_upload_mb} MB</dd></div>
        <div class="kv-row"><dt class="kv-key">max metadata</dt><dd class="kv-value">${(settings.limits.max_metadata_bytes / 1024).toFixed(0)} KB</dd></div>
        <div class="kv-row"><dt class="kv-key">API_KEY</dt><dd>${settings.auth.api_key_configured ? '<span class="badge badge-emerald">configured</span>' : '<span class="badge badge-rose">not set</span>'}</dd></div>
        <div class="kv-row"><dt class="kv-key">webhook HMAC</dt><dd>${settings.webhook.hmac_secret_configured ? '<span class="badge badge-emerald">configured</span>' : '<span class="badge badge-rose">default (change me)</span>'}</dd></div>
        <div class="kv-row"><dt class="kv-key">webhook attempts</dt><dd class="kv-value">${settings.webhook.max_attempts}</dd></div>
      </dl>
    </div>`;
}

function renderEndpointsCard() {
  const link = (path) => `<a href="${path}" target="_blank" class="text-indigo-600 dark:text-indigo-400 hover:underline">${path}</a>`;
  return `
    <div class="card card-body">
      <h3 class="card-title mb-3">Endpoints</h3>
      <dl class="kv">
        <div class="kv-row"><dt class="kv-key">API base</dt><dd class="kv-value">${escapeHtml(API)}</dd></div>
        <div class="kv-row"><dt class="kv-key">Swagger UI</dt><dd class="kv-value">${link('/docs')}</dd></div>
        <div class="kv-row"><dt class="kv-key">OpenAPI JSON</dt><dd class="kv-value">${link('/docs/json')}</dd></div>
        <div class="kv-row"><dt class="kv-key">Health</dt><dd class="kv-value">${link('/health')}</dd></div>
        <div class="kv-row"><dt class="kv-key">Ready</dt><dd class="kv-value">${link('/ready')}</dd></div>
        <div class="kv-row"><dt class="kv-key">Metrics</dt><dd class="kv-value">${link('/metrics')}</dd></div>
      </dl>
    </div>`;
}

function renderSessionCard() {
  return `
    <div class="card card-body">
      <h3 class="card-title mb-3">Session</h3>
      <dl class="kv mb-4">
        <div class="kv-row"><dt class="kv-key">Token</dt><dd class="kv-value">${auth.token ? '••••••••' + escapeHtml(auth.token.slice(-6)) : '—'}</dd></div>
      </dl>
      <button id="logout-from-settings" class="btn-secondary btn-sm">Выйти</button>
    </div>`;
}

// ============================================================
// Boot
// ============================================================
applyTheme();
if (auth.isAuthed()) {
  hideLogin();
  if (!location.hash) location.hash = '#jobs';
  route();
} else {
  showLogin();
}
