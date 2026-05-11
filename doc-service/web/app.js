/**
 * parsdocs operator UI.
 *
 * One HTML shell + this module. No bundler, no framework — just hash-based
 * routing, fetch() with a Bearer token from localStorage, and templates
 * inlined as tagged template strings. Plenty for an operational tool, easy
 * to extend, easy to read.
 *
 * Layout:
 *   - Routing: window.location.hash dispatches to renderXxx(). On navigation
 *     hashchange re-renders the main view.
 *   - Auth: token kept in localStorage. Every API call goes through api()
 *     which injects Authorization and resets on 401.
 *   - Views: each returns nothing — they mutate the #view element directly.
 *     Long-poll loops register themselves with the currentView lifecycle
 *     so navigating away cancels them.
 */

const API = '/api/v1';
const STORAGE = {
  token: 'parsdocs.token',
  dark: 'parsdocs.dark',
};

// ---- Auth ----
const auth = {
  get token() { return localStorage.getItem(STORAGE.token); },
  set token(v) {
    if (v) localStorage.setItem(STORAGE.token, v);
    else localStorage.removeItem(STORAGE.token);
  },
  isAuthed() { return !!this.token; },
};

// ---- API client ----
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

// ---- Theme ----
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

// ---- Status badge helper ----
const STATUS_STYLES = {
  pending:      { label: 'Pending',       cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  processing:   { label: 'Processing',    cls: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 animate-pulse' },
  done:         { label: 'Done',          cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
  needs_review: { label: 'Needs review',  cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  failed:       { label: 'Failed',        cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300' },
};
function badge(status) {
  const s = STATUS_STYLES[status] ?? { label: status, cls: 'bg-slate-100 text-slate-700' };
  return `<span class="badge ${s.cls}">${s.label}</span>`;
}

function confidenceBar(confidence) {
  if (confidence === null || confidence === undefined) return '<span class="text-slate-400 text-xs">—</span>';
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

// ---- View lifecycle: cancel polls on navigation ----
//
// setView writes new HTML, replacing the previous view. Before doing so it
// runs any cleanup registered by the previous view (cancels timers, etc.).
//
// Views that attach event listeners or start polls AFTER setView call
// `registerCleanup` separately — calling setView a second time on the same
// view would re-render the HTML and wipe their just-attached handlers.
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
  // Replaces (doesn't chain) — each view owns one cleanup hook.
  currentCleanup = fn;
}

// ---- Login flow ----
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
  // Verify by hitting /ready — public endpoint, but our app actually wants
  // to know "does this token unlock /api/v1/*"? So we hit a real authed
  // endpoint (GET /jobs?limit=1) instead. /ready alone wouldn't catch a
  // wrong token because it's unauthed.
  auth.token = token;
  try {
    const res = await api('/jobs?limit=1');
    if (res.status === 200) return true;
    if (res.status === 401) return false;
    // 500-ish — token might be fine but server is sick. Treat as failure
    // and surface the error to the user.
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

// ---- Router ----
function route() {
  const h = (location.hash || '#jobs').slice(1);
  // Highlight active nav
  document.querySelectorAll('[data-nav]').forEach((el) => {
    const target = el.dataset.nav;
    el.classList.toggle('active', h === target || (target === 'jobs' && h.startsWith('jobs')));
  });

  if (h === 'jobs') return renderJobsList();
  if (h.startsWith('jobs/')) return renderJobDetail(h.slice(5));
  if (h === 'upload') return renderUpload();
  if (h === 'settings') return renderSettings();
  // Unknown → default
  location.hash = '#jobs';
}
window.addEventListener('hashchange', route);

// ==========================================================
// Views
// ==========================================================

// ---- Jobs list ----
async function renderJobsList() {
  setView(`
    <div class="p-8 max-w-6xl mx-auto">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h2 class="text-2xl font-semibold">Jobs</h2>
          <p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Последние задачи обработки</p>
        </div>
        <a href="#upload" class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/></svg>
          New job
        </a>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <select id="filter-status" class="px-3 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
          <option value="">Все статусы</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="done">Done</option>
          <option value="needs_review">Needs review</option>
          <option value="failed">Failed</option>
        </select>
        <select id="filter-type" class="px-3 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
          <option value="">Все типы</option>
          <option value="invoice">invoice</option>
          <option value="factInvoice">factInvoice</option>
          <option value="UPD">UPD</option>
          <option value="TTN">TTN</option>
          <option value="CMR">CMR</option>
          <option value="AKT">AKT</option>
        </select>
        <button id="refresh-btn" class="px-3 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition">
          Обновить
        </button>
        <span id="auto-refresh-indicator" class="text-xs text-slate-400 hidden">auto-refresh on</span>
      </div>

      <!-- Table container — filled by loadJobs -->
      <div id="jobs-table" class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div class="p-8 text-center text-slate-400">Загрузка...</div>
      </div>
    </div>
  `);

  const statusEl = document.getElementById('filter-status');
  const typeEl = document.getElementById('filter-type');
  const refreshEl = document.getElementById('refresh-btn');
  const autoEl = document.getElementById('auto-refresh-indicator');

  async function load() {
    const params = new URLSearchParams();
    if (statusEl.value) params.set('status', statusEl.value);
    if (typeEl.value) params.set('document_type', typeEl.value);
    params.set('limit', '50');
    try {
      const data = await apiJson(`/jobs?${params.toString()}`);
      renderTable(data.items);
      // Auto-refresh while there are in-flight jobs.
      const inflight = data.items.some((j) => j.status === 'pending' || j.status === 'processing');
      autoEl.classList.toggle('hidden', !inflight);
      return inflight;
    } catch (err) {
      document.getElementById('jobs-table').innerHTML = `
        <div class="p-8 text-center text-rose-600 dark:text-rose-400">
          <p class="font-medium">Не удалось загрузить</p>
          <p class="text-sm mt-1">${escapeHtml(err.message)}</p>
        </div>`;
      return false;
    }
  }

  function renderTable(items) {
    if (items.length === 0) {
      document.getElementById('jobs-table').innerHTML = `
        <div class="p-12 text-center">
          <p class="text-slate-500 dark:text-slate-400">Задач пока нет.</p>
          <a href="#upload" class="inline-block mt-3 text-indigo-600 hover:text-indigo-700 text-sm font-medium">Загрузить первый документ →</a>
        </div>`;
      return;
    }
    const rows = items.map((j) => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition" data-job-id="${escapeHtml(j.job_id)}">
        <td class="px-4 py-3 font-mono text-xs text-slate-500">${escapeHtml(j.job_id.slice(0, 8))}</td>
        <td class="px-4 py-3">${badge(j.status)}</td>
        <td class="px-4 py-3 text-sm">${escapeHtml(j.document_type ?? '—')}</td>
        <td class="px-4 py-3 text-sm truncate max-w-[12rem]" title="${escapeHtml(j.file_name)}">${escapeHtml(j.file_name)}</td>
        <td class="px-4 py-3">${confidenceBar(j.confidence)}</td>
        <td class="px-4 py-3 text-sm">${(j.validation_issues?.length ?? 0) > 0 ? `<span class="text-amber-600 dark:text-amber-400">${j.validation_issues.length}</span>` : '<span class="text-slate-300 dark:text-slate-600">—</span>'}</td>
        <td class="px-4 py-3 text-xs text-slate-500" title="${escapeHtml(j.created_at)}">${escapeHtml(relativeTime(j.created_at))}</td>
      </tr>`).join('');
    document.getElementById('jobs-table').innerHTML = `
      <table class="w-full">
        <thead class="bg-slate-50 dark:bg-slate-950/50 text-xs uppercase text-slate-500 dark:text-slate-400">
          <tr>
            <th class="text-left px-4 py-2.5 font-medium">ID</th>
            <th class="text-left px-4 py-2.5 font-medium">Status</th>
            <th class="text-left px-4 py-2.5 font-medium">Type</th>
            <th class="text-left px-4 py-2.5 font-medium">File</th>
            <th class="text-left px-4 py-2.5 font-medium">Confidence</th>
            <th class="text-left px-4 py-2.5 font-medium">Issues</th>
            <th class="text-left px-4 py-2.5 font-medium">Created</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 dark:divide-slate-800">${rows}</tbody>
      </table>`;
    document.querySelectorAll('[data-job-id]').forEach((row) => {
      row.addEventListener('click', () => { location.hash = `#jobs/${row.dataset.jobId}`; });
    });
  }

  // Wire interactivity and polling lifecycle.
  let pollTimer = null;
  async function reloadAndScheduleNext() {
    const inflight = await load();
    if (inflight) {
      pollTimer = setTimeout(reloadAndScheduleNext, 5000);
    } else {
      pollTimer = null;
    }
  }

  statusEl.addEventListener('change', () => reloadAndScheduleNext());
  typeEl.addEventListener('change', () => reloadAndScheduleNext());
  refreshEl.addEventListener('click', () => reloadAndScheduleNext());

  await reloadAndScheduleNext();
  registerCleanup(() => { if (pollTimer) clearTimeout(pollTimer); });
}

// ---- Job detail ----
async function renderJobDetail(jobId) {
  setView(`
    <div class="p-8 max-w-5xl mx-auto">
      <a href="#jobs" class="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 mb-4">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clip-rule="evenodd"/></svg>
        К списку
      </a>
      <div id="job-detail-content" class="space-y-6">
        <div class="text-slate-400 text-center py-12">Загрузка...</div>
      </div>
    </div>
  `);

  let pollTimer = null;
  let editing = false;

  async function load() {
    try {
      const job = await apiJson(`/jobs/${encodeURIComponent(jobId)}`);
      renderDetail(job);
      const inflight = job.status === 'pending' || job.status === 'processing';
      if (inflight && !editing) {
        pollTimer = setTimeout(load, 2000);
      } else {
        pollTimer = null;
      }
    } catch (err) {
      document.getElementById('job-detail-content').innerHTML = `
        <div class="p-8 text-center text-rose-600 dark:text-rose-400">
          <p class="font-medium">Не удалось загрузить</p>
          <p class="text-sm mt-1">${escapeHtml(err.message)}</p>
        </div>`;
    }
  }

  function renderDetail(job) {
    const issues = job.validation_issues || [];
    const extractedJson = JSON.stringify(job.extracted ?? {}, null, 2);

    document.getElementById('job-detail-content').innerHTML = `
      <!-- Header card -->
      <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-6">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-3 mb-2">
              ${badge(job.status)}
              ${job.document_type ? `<span class="text-sm text-slate-600 dark:text-slate-400">${escapeHtml(job.document_type)}</span>` : ''}
            </div>
            <h2 class="text-xl font-semibold truncate" title="${escapeHtml(job.file_name)}">${escapeHtml(job.file_name)}</h2>
            <div class="mt-2 flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 font-mono">
              <span>${escapeHtml(job.job_id)}</span>
              <span>${(job.file_size / 1024).toFixed(1)} KB</span>
              <span>${escapeHtml(job.mime_type)}</span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-xs text-slate-500 dark:text-slate-400 mb-1">Confidence</div>
            ${confidenceBar(job.confidence)}
            ${job.ocr_engine ? `<div class="text-xs text-slate-400 mt-2">via <span class="font-mono">${escapeHtml(job.ocr_engine)}</span></div>` : ''}
          </div>
        </div>
        ${job.error ? `
          <div class="mt-4 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-sm text-rose-700 dark:text-rose-300">
            <strong>Error:</strong> ${escapeHtml(job.error)}
          </div>` : ''}
      </div>

      <!-- Validation issues -->
      ${issues.length > 0 ? `
        <div class="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-5">
          <div class="flex items-center gap-2 mb-3">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 text-amber-600 dark:text-amber-400"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/></svg>
            <h3 class="font-semibold text-amber-900 dark:text-amber-200">Validation issues (${issues.length})</h3>
          </div>
          <ul class="space-y-1.5">
            ${issues.map((i) => `<li class="text-sm text-amber-800 dark:text-amber-300 flex gap-2"><span class="text-amber-500">•</span><span class="font-mono">${escapeHtml(i)}</span></li>`).join('')}
          </ul>
        </div>` : ''}

      <!-- Extracted -->
      <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div class="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 class="font-semibold">Extracted data</h3>
          <div class="flex items-center gap-2">
            <button id="copy-json-btn" class="text-xs px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition">Copy</button>
            <button id="edit-btn" class="text-xs px-2.5 py-1 rounded border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950 transition">Edit</button>
          </div>
        </div>
        <div id="extracted-pane" class="p-5">
          <pre class="json text-xs font-mono bg-slate-50 dark:bg-slate-950 p-4 rounded-lg overflow-x-auto text-slate-800 dark:text-slate-200">${escapeHtml(extractedJson)}</pre>
        </div>
      </div>

      <!-- Raw text (collapsed by default) -->
      <details class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
        <summary class="px-5 py-3 cursor-pointer font-medium text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50">Raw OCR text</summary>
        <div class="px-5 pb-5">
          <pre class="text-xs font-mono bg-slate-50 dark:bg-slate-950 p-4 rounded-lg whitespace-pre-wrap max-h-96 overflow-y-auto text-slate-700 dark:text-slate-300">${escapeHtml(job.raw_text || '(нет распознанного текста)')}</pre>
        </div>
      </details>

      <!-- Metadata (if any) -->
      ${job.metadata ? `
        <details class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
          <summary class="px-5 py-3 cursor-pointer font-medium text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50">Client metadata</summary>
          <div class="px-5 pb-5">
            <pre class="text-xs font-mono bg-slate-50 dark:bg-slate-950 p-4 rounded-lg overflow-x-auto text-slate-700 dark:text-slate-300">${escapeHtml(JSON.stringify(job.metadata, null, 2))}</pre>
          </div>
        </details>` : ''}
    `;

    document.getElementById('copy-json-btn').addEventListener('click', async () => {
      await navigator.clipboard.writeText(extractedJson);
      const btn = document.getElementById('copy-json-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });

    document.getElementById('edit-btn').addEventListener('click', () => {
      editing = true;
      if (pollTimer) clearTimeout(pollTimer);
      renderEditor(job, extractedJson);
    });
  }

  function renderEditor(job, currentJson) {
    document.getElementById('extracted-pane').innerHTML = `
      <textarea id="extracted-editor"
        class="w-full h-96 px-3 py-2 font-mono text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        spellcheck="false">${escapeHtml(currentJson)}</textarea>
      <p id="editor-error" class="hidden mt-2 text-sm text-rose-600 dark:text-rose-400"></p>
      <div class="mt-3 flex items-center gap-2">
        <button id="save-btn" class="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition">Save</button>
        <button id="cancel-btn" class="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm transition">Cancel</button>
        <span class="text-xs text-slate-500 dark:text-slate-400">При сохранении статус станет <code class="font-mono">done</code>, валидация перезапустится.</span>
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

// ---- Upload ----
function renderUpload() {
  setView(`
    <div class="p-8 max-w-3xl mx-auto">
      <h2 class="text-2xl font-semibold mb-1">Upload</h2>
      <p class="text-sm text-slate-500 dark:text-slate-400 mb-6">Загрузить документ на обработку</p>

      <form id="upload-form" class="space-y-5">
        <!-- Dropzone -->
        <div id="dropzone" class="dropzone border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-10 text-center cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-600 transition">
          <input type="file" id="file-input" class="hidden" accept=".pdf,.jpg,.jpeg,.png,.bmp,.tif,.tiff" />
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-12 h-12 mx-auto mb-3 text-slate-400"><path d="M11.47 1.72a.75.75 0 0 1 1.06 0l3 3a.75.75 0 0 1-1.06 1.06l-1.72-1.72V7.5h-1.5V4.06L9.53 5.78a.75.75 0 0 1-1.06-1.06l3-3ZM11.25 7.5V15a.75.75 0 0 0 1.5 0V7.5h3.75a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3h3.75Z"/></svg>
          <p id="dropzone-text" class="text-sm text-slate-600 dark:text-slate-400">
            Перетащи файл сюда или <span class="text-indigo-600 dark:text-indigo-400 font-medium">кликни чтобы выбрать</span>
          </p>
          <p class="text-xs text-slate-400 mt-1">PDF, JPG, PNG, BMP, TIFF · до 50 МБ</p>
        </div>

        <!-- Optional fields -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium mb-1.5">Document hint <span class="text-slate-400 font-normal">(опционально)</span></label>
            <select name="document_hint" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm">
              <option value="">— auto-detect —</option>
              <option value="invoice">invoice</option>
              <option value="factInvoice">factInvoice</option>
              <option value="UPD">UPD</option>
              <option value="TTN">TTN</option>
              <option value="CMR">CMR</option>
              <option value="AKT">AKT</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium mb-1.5">Webhook URL <span class="text-slate-400 font-normal">(опционально)</span></label>
            <input name="webhook_url" type="url" placeholder="https://..." class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm" />
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium mb-1.5">Metadata JSON <span class="text-slate-400 font-normal">(опционально)</span></label>
          <textarea name="metadata" rows="3" placeholder='{"my_id": "X-123"}' class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-mono"></textarea>
          <p class="mt-1 text-xs text-slate-500">Произвольный JSON; вернётся как есть в результате и webhook'е. Макс 64 KB.</p>
        </div>

        <p id="upload-error" class="hidden text-sm text-rose-600 dark:text-rose-400"></p>

        <button id="submit-btn" type="submit" disabled class="w-full md:w-auto px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:dark:bg-slate-700 disabled:cursor-not-allowed text-white font-medium transition">
          Загрузить
        </button>
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
    dropzoneText.innerHTML = `<span class="text-slate-700 dark:text-slate-300 font-medium">${escapeHtml(f.name)}</span><br><span class="text-xs text-slate-500">${(f.size / 1024).toFixed(1)} KB · ${escapeHtml(f.type || 'unknown')}</span>`;
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
      try {
        JSON.parse(metaText);
      } catch {
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

// ---- Settings: provider status, thresholds, env snapshot ----
async function renderSettings() {
  setView(`
    <div class="p-8 max-w-4xl mx-auto">
      <h2 class="text-2xl font-semibold mb-1">Settings</h2>
      <p class="text-sm text-slate-500 dark:text-slate-400 mb-6">Конфигурация сервиса и LLM-провайдеров</p>

      <div id="settings-content" class="space-y-4">
        <div class="text-slate-400 text-center py-8">Загрузка...</div>
      </div>
    </div>
  `);

  let settings = null;
  let providers = null;
  try {
    [settings, providers] = await Promise.all([
      apiJson('/settings'),
      apiJson('/providers/status'),
    ]);
  } catch (err) {
    document.getElementById('settings-content').innerHTML = `
      <div class="p-6 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300">
        <p class="font-medium">Не удалось загрузить настройки</p>
        <p class="text-sm mt-1">${escapeHtml(err.message)}</p>
      </div>`;
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

  document.getElementById('logout-from-settings').addEventListener('click', () => {
    auth.token = null;
    showLogin();
  });
}

function renderProvidersCard(providers) {
  const upstream = providers.upstream;
  if (upstream === 'not_configured') {
    return `
      <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5">
        <h3 class="font-semibold mb-3">LLM Providers</h3>
        <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 text-sm">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">not connected</span>
          <span class="ml-2 text-slate-600 dark:text-slate-400">inference-service не подключён (LLM_INFERENCE_URL пустой). Phase 2 парсеры (ТТН/CMR/АКТ) будут возвращать пустоту.</span>
        </div>
      </div>`;
  }
  if (upstream === 'unreachable') {
    return `
      <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5">
        <h3 class="font-semibold mb-3">LLM Providers</h3>
        <div class="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-sm text-rose-700 dark:text-rose-300">
          <span class="font-medium">inference-service недоступен.</span>
          ${providers.error ? `<div class="font-mono text-xs mt-1">${escapeHtml(providers.error)}</div>` : ''}
        </div>
      </div>`;
  }
  const available = providers.available || {};
  const active = providers.active;
  const rows = Object.entries(available).map(([name, info]) => {
    const isActive = name === active;
    const statusBadge = info.configured
      ? `<span class="badge bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">configured</span>`
      : `<span class="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500">not configured</span>`;
    const activeBadge = isActive
      ? `<span class="badge bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">active</span>`
      : '';
    return `
      <div class="flex items-start gap-4 p-3 rounded-lg ${isActive ? 'bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900' : 'bg-slate-50/50 dark:bg-slate-950/30'}">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="font-mono text-sm font-medium">${escapeHtml(name)}</span>
            ${activeBadge}
            ${statusBadge}
          </div>
          <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(info.description || '')}</div>
          ${info.model ? `<div class="text-xs text-slate-400 dark:text-slate-500 font-mono mt-0.5">${escapeHtml(info.model)}</div>` : ''}
        </div>
      </div>`;
  }).join('');
  return `
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">LLM Providers</h3>
        <span class="text-xs text-slate-500">inference-service: <span class="text-emerald-600 dark:text-emerald-400 font-medium">connected</span></span>
      </div>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Активный бэкенд переключается через <code class="font-mono">BACKEND=</code> в env inference-service. Требует рестарта контейнера.
      </p>
      <div class="space-y-2">${rows || '<div class="text-sm text-slate-400">провайдеров нет</div>'}</div>
    </div>`;
}

function renderOcrCard(settings) {
  const t = settings.thresholds;
  const eng = settings.ocr_engines;
  return `
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5">
      <h3 class="font-semibold mb-3">OCR pipeline</h3>
      <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div><span class="text-slate-500">pdf-parse accept:</span> <span class="font-mono">${t.pdf_text}</span></div>
        <div><span class="text-slate-500">tesseract accept:</span> <span class="font-mono">${t.tesseract}</span></div>
        <div><span class="text-slate-500">vision-llm accept:</span> <span class="font-mono">${t.vision_llm}</span></div>
        <div><span class="text-slate-500">needs_review threshold:</span> <span class="font-mono">${t.needs_review}</span></div>
        <div><span class="text-slate-500">regex-fallback threshold:</span> <span class="font-mono">${t.regex_fallback}</span></div>
        <div><span class="text-slate-500">tesseract langs:</span> <span class="font-mono">${escapeHtml(eng.tesseract_langs)}</span></div>
      </div>
      <div class="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-sm"><span class="text-slate-500">vision-llm engine:</span> ${eng.vision_llm.enabled ? '<span class="text-emerald-600 dark:text-emerald-400 font-medium">enabled</span>' : '<span class="text-slate-500">disabled</span>'}</span>
          ${eng.vision_llm.url ? `<span class="text-xs font-mono text-slate-400">${escapeHtml(eng.vision_llm.url)}</span>` : ''}
        </div>
        <div class="flex items-center justify-between">
          <span class="text-sm"><span class="text-slate-500">yandex-vision engine:</span> ${eng.yandex_vision.enabled ? '<span class="text-amber-600 dark:text-amber-400 font-medium">enabled</span>' : '<span class="text-slate-500">disabled</span>'}</span>
        </div>
        ${eng.yandex_vision.enabled ? `
          <div class="p-2.5 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300">
            <strong>⚠</strong> ${escapeHtml(eng.yandex_vision.pii_warning)}
          </div>` : ''}
      </div>
    </div>`;
}

function renderStorageCard(settings) {
  return `
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5">
      <h3 class="font-semibold mb-3">Storage & sweepers</h3>
      <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div><span class="text-slate-500">backend:</span> <span class="font-mono">${escapeHtml(settings.storage.backend)}</span></div>
        <div><span class="text-slate-500">dir:</span> <span class="font-mono text-xs">${escapeHtml(settings.storage.dir)}</span></div>
        <div><span class="text-slate-500">file retention:</span> <span class="font-mono">${settings.storage.retention_days} days</span></div>
        <div><span class="text-slate-500">worker concurrency:</span> <span class="font-mono">${settings.worker.concurrency}</span></div>
        <div><span class="text-slate-500">pending sweep:</span> <span class="font-mono">${settings.sweepers.pending_interval_ms / 1000}s (grace ${settings.sweepers.pending_grace_seconds}s)</span></div>
        <div><span class="text-slate-500">cleanup sweep:</span> <span class="font-mono">${settings.sweepers.file_cleanup_interval_ms / 60000} min</span></div>
      </div>
    </div>`;
}

function renderLimitsCard(settings) {
  return `
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5">
      <h3 class="font-semibold mb-3">Limits & secrets</h3>
      <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div><span class="text-slate-500">max upload:</span> <span class="font-mono">${settings.limits.max_upload_mb} MB</span></div>
        <div><span class="text-slate-500">max metadata:</span> <span class="font-mono">${(settings.limits.max_metadata_bytes / 1024).toFixed(0)} KB</span></div>
        <div><span class="text-slate-500">API_KEY:</span> ${settings.auth.api_key_configured ? '<span class="text-emerald-600 dark:text-emerald-400">configured</span>' : '<span class="text-rose-600 dark:text-rose-400">not set</span>'}</div>
        <div><span class="text-slate-500">webhook HMAC:</span> ${settings.webhook.hmac_secret_configured ? '<span class="text-emerald-600 dark:text-emerald-400">configured</span>' : '<span class="text-rose-600 dark:text-rose-400">default (change me)</span>'}</div>
        <div><span class="text-slate-500">webhook attempts:</span> <span class="font-mono">${settings.webhook.max_attempts}</span></div>
      </div>
    </div>`;
}

function renderEndpointsCard() {
  return `
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5">
      <h3 class="font-semibold mb-3">Endpoints</h3>
      <dl class="space-y-1 text-sm font-mono">
        <div class="flex justify-between"><dt class="text-slate-500">API base</dt><dd>${escapeHtml(API)}</dd></div>
        <div class="flex justify-between"><dt class="text-slate-500">Swagger UI</dt><dd><a href="/docs" class="text-indigo-600 hover:underline" target="_blank">/docs</a></dd></div>
        <div class="flex justify-between"><dt class="text-slate-500">OpenAPI JSON</dt><dd><a href="/docs/json" class="text-indigo-600 hover:underline" target="_blank">/docs/json</a></dd></div>
        <div class="flex justify-between"><dt class="text-slate-500">Health</dt><dd><a href="/health" class="text-indigo-600 hover:underline" target="_blank">/health</a></dd></div>
        <div class="flex justify-between"><dt class="text-slate-500">Ready</dt><dd><a href="/ready" class="text-indigo-600 hover:underline" target="_blank">/ready</a></dd></div>
      </dl>
    </div>`;
}

function renderSessionCard() {
  return `
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5">
      <h3 class="font-semibold mb-3">Session</h3>
      <dl class="space-y-1.5 text-sm">
        <div class="flex justify-between items-center"><dt class="text-slate-500">Token</dt><dd class="font-mono text-xs">${auth.token ? '••••••••' + escapeHtml(auth.token.slice(-6)) : '—'}</dd></div>
      </dl>
      <button id="logout-from-settings" class="mt-4 px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm transition">Выйти</button>
    </div>`;
}

// ==========================================================
// Boot
// ==========================================================
applyTheme();
if (auth.isAuthed()) {
  hideLogin();
  if (!location.hash) location.hash = '#jobs';
  route();
} else {
  showLogin();
}
