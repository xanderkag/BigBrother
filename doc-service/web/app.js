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
      (target === 'document-types' && h.startsWith('document-types'));
    el.classList.toggle('active', isActive);
  });

  if (h === 'jobs') return renderJobsList();
  if (h.startsWith('jobs/')) return renderJobDetail(h.slice(5));
  if (h === 'upload') return renderUpload();
  if (h === 'document-types') return renderDocumentTypesList();
  if (h.startsWith('document-types/')) return renderDocumentTypeDetail(h.slice('document-types/'.length));
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
        subtitle: 'Конфигурация типов документов: парсеры, поля, валидаторы, пороги',
      })}

      <div class="warning-banner mb-4">
        <strong>Read-only.</strong> Runtime читает <em>часть</em> конфигурации из БД (валидаторы, пороги, ожидаемые поля, схемы LLM). Editor UI для правок — следующая фаза.
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

async function renderDocumentTypeDetail(slug) {
  setView(`
    <div class="page-narrow">
      ${backLink('#document-types')}
      <div id="dt-detail" class="space-y-4">${loadingState()}</div>
    </div>
  `);

  let t;
  try {
    t = await apiJson(`/document-types/${encodeURIComponent(slug)}`);
  } catch (err) {
    document.getElementById('dt-detail').innerHTML = errorState(err.message);
    return;
  }

  const listItem = (items, emptyLabel) => items.length
    ? `<ul class="space-y-1 list-disc list-inside">${items.map((x) => `<li class="font-mono text-xs">${escapeHtml(x)}</li>`).join('')}</ul>`
    : `<p class="text-sm text-slate-400">${emptyLabel}</p>`;

  document.getElementById('dt-detail').innerHTML = `
    <div class="card card-body-lg">
      <div class="flex items-center gap-2 mb-2 flex-wrap">
        ${parserKindBadge(t.parser_kind)}
        ${t.is_builtin ? '<span class="badge badge-emerald">builtin</span>' : ''}
        ${!t.is_active ? '<span class="badge badge-slate">inactive</span>' : ''}
      </div>
      <h2 class="text-xl font-semibold">${escapeHtml(t.display_name)}</h2>
      <div class="mt-1 font-mono text-xs text-slate-500">${escapeHtml(t.slug)}</div>
      ${t.description ? `<p class="mt-3 text-sm text-slate-600 dark:text-slate-400">${escapeHtml(t.description)}</p>` : ''}
    </div>

    <div class="card card-body">
      <h3 class="card-title mb-3">Thresholds</h3>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div class="kv-row"><dt class="kv-key">confidence_threshold</dt><dd class="kv-value">${t.confidence_threshold !== null ? t.confidence_threshold : '<span class="text-slate-400">default из env</span>'}</dd></div>
        <div class="kv-row"><dt class="kv-key">regex_fallback_threshold</dt><dd class="kv-value">${t.regex_fallback_threshold !== null ? t.regex_fallback_threshold : '<span class="text-slate-400">—</span>'}</dd></div>
      </dl>
    </div>

    <div class="card card-body">
      <h3 class="card-title mb-1">Expected fields <span class="text-sm font-normal text-slate-500">(${t.expected_fields.length})</span></h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">Парсер обязан попытаться извлечь эти поля. Не найденное → <code class="font-mono">missing</code>.</p>
      ${listItem(t.expected_fields, 'не настроено')}
    </div>

    <div class="card card-body">
      <h3 class="card-title mb-1">Validators <span class="text-sm font-normal text-slate-500">(${t.validators.length})</span></h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">Доменные проверки на извлечённых данных. Формат: <code class="font-mono">name</code> или <code class="font-mono">name:args</code>.</p>
      ${listItem(t.validators, 'не настроено')}
    </div>

    <div class="card card-body">
      <h3 class="card-title mb-1">Classification keywords <span class="text-sm font-normal text-slate-500">(${t.classification_keywords.length})</span></h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">Регулярки для keyword-классификатора. Совпадение → этот тип.</p>
      ${listItem(t.classification_keywords, 'не настроено')}
    </div>

    ${t.parser_kind === 'llm_extract' ? `
      <div class="card card-body">
        <h3 class="card-title mb-3">LLM extraction config</h3>
        <div class="mb-4">
          <div class="kv-key text-sm mb-1">Prompt override</div>
          ${t.llm_prompt
            ? `<pre class="text-xs font-mono bg-slate-50 dark:bg-slate-950 p-3 rounded-lg overflow-x-auto">${escapeHtml(t.llm_prompt)}</pre>`
            : '<p class="text-sm text-slate-400">— не задан, используется default из inference-service prompts/extract.py</p>'}
        </div>
        <div>
          <div class="kv-key text-sm mb-1">JSON Schema override</div>
          ${t.llm_schema
            ? `<div class="bg-slate-50 dark:bg-slate-950 p-3 rounded-lg overflow-x-auto max-h-64">${jsonTree(t.llm_schema)}</div>`
            : '<p class="text-sm text-slate-400">— не задан, используется default из doc-service document-json-schemas.ts</p>'}
        </div>
      </div>` : ''}

    <div class="card card-body">
      <h3 class="card-title mb-3">Bookkeeping</h3>
      <dl class="kv">
        <div class="kv-row"><dt class="kv-key">Created</dt><dd class="kv-value">${escapeHtml(t.created_at)}</dd></div>
        <div class="kv-row"><dt class="kv-key">Updated</dt><dd class="kv-value">${escapeHtml(t.updated_at)}</dd></div>
      </dl>
    </div>
  `;
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
        <h3 class="card-title">LLM Providers</h3>
        ${status}
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
