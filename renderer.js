'use strict';
// ---- Global shared state (top-level runtime scope — TDZ guard) ----
let selectedPath = '';            // '' = database root. Path of node shown in matrix editor.
const expandedPaths = new Set();  // full paths currently expanded in the sidebar tree.
const treeDataCache = new Map();  // path -> raw node payload (from fetch-node-children).
let activePlayerId = null;        // reserved: focused player ID for search/delete flows.
let currentLoadedPath = null;     // last path successfully loaded into the matrix panel.
let isEditingCell = false;        // true while an inline cell editor is open.
// ------------------------------------------------------------------------

const api = window.firebaseApi;

// --- DOM refs (module scope — resolved once) -----------------------------
const elTree = document.getElementById('tree-container');
const elFilter = document.getElementById('tree-filter');
const elPathBar = document.getElementById('path-bar');
const elMatrixWrap = document.getElementById('matrix-wrap');
const elWelcome = document.getElementById('welcome');
const elLog = document.getElementById('log-console');
const elConnDot = document.getElementById('conn-dot');
const elConnLabel = document.getElementById('conn-label');
const btnRefresh = document.getElementById('btn-refresh');
const btnBackup = document.getElementById('btn-backup');
const btnExit = document.getElementById('btn-exit');
const modalDelete = document.getElementById('modal-delete');
const modalAdd = document.getElementById('modal-add');
const elClock = document.getElementById('clock');

// --- Clock updater -------------------------------------------------------
let clockInterval = null;
function startClock() {
  if (clockInterval) clearInterval(clockInterval);
  function tick() {
    const d = new Date();
    const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    elClock.textContent = `${dateStr}  ${timeStr}`;
  }
  tick();
  clockInterval = setInterval(tick, 1000);
}

// --- Logging & connection status ----------------------------------------
function log(message, type) {
  try {
    const line = document.createElement('div');
    line.className = 'log-line t-' + (type || 'info');
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    line.textContent = `[${ts}] ${message}`;
    elLog.appendChild(line);
    while (elLog.children.length > 200) elLog.removeChild(elLog.firstChild);
    elLog.scrollTop = elLog.scrollHeight;
  } catch (err) { /* logging must never throw */ }
}

function setConn(ok, label) {
  try {
    elConnDot.classList.toggle('ok', !!ok);
    elConnLabel.textContent = label || (ok ? 'RTDB CONNECTED' : 'RTDB OFFLINE');
  } catch (err) { /* noop */ }
}

// --- Path utilities & safety guards --------------------------------------
function joinPath(base, key) {
  const b = (base || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return b ? `${b}/${key}` : String(key);
}

// Strict empty/root bounds guard — mirrors the main-process handler check.
function assertTargetPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim() || targetPath.trim() === '/') {
    log('BLOCKED: Empty or root path bounds violation — mutation rejected.', 'err');
    return false;
  }
  if (targetPath.split('/').some((s) => s.trim() === '')) {
    log(`BLOCKED: Invalid path segments in "${targetPath}".`, 'err');
    return false;
  }
  return true;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// --- Type helpers ----------------------------------------------------------
function typeOfValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  return 'object';
}

function displayValue(v) {
  const t = typeOfValue(v);
  if (t === 'null') return '(null)';
  if (t === 'object' || t === 'array') {
    const n = isObject(v) ? Object.keys(v).length : v.length;
    return `${t} (${n} keys)`;
  }
  return String(v);
}

// --- Tree rendering --------------------------------------------------------
function iconFor(key) {
  if (/player|stats|user|profile/i.test(key)) return '👤';
  if (/gold|currency|premium|shop|purchase|ledger|coin/i.test(key)) return '💰';
  if (/debug|log|watch|banner|ad|event|track/i.test(key)) return '📊';
  return '📦';
}

function makeTreeRow(key, value, fullPath, depth) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  node.dataset.path = fullPath;

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = (8 + depth * 16) + 'px';

  const hasChildren = isObject(value);
  const caret = document.createElement('span');
  caret.className = 'tree-caret' + (expandedPaths.has(fullPath) ? ' open' : '');
  caret.textContent = hasChildren ? '▶' : '';

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = `${iconFor(key)} ${key}`;

  const badges = document.createElement('span');
  badges.className = 'tree-badges';
  if (hasChildren) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = Object.keys(value).length;
    badges.appendChild(b);
  }

  row.appendChild(caret);
  row.appendChild(label);
  row.appendChild(badges);

  const childrenBox = document.createElement('div');
  childrenBox.className = 'tree-children';
  childrenBox.style.display = expandedPaths.has(fullPath) ? 'block' : 'none';

  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      toggleExpand(fullPath, hasChildren);
    } catch (err) {
      log(`Tree toggle error: ${err.message}`, 'err');
    }
  });

  row.addEventListener('click', () => {
    try {
      // Leaf rows select their parent object so the matrix shows the editable key.
      const target = hasChildren ? fullPath : fullPath.split('/').slice(0, -1).join('/');
      selectPath(target);
    } catch (err) {
      log(`Tree select error: ${err.message}`, 'err');
    }
  });

  node.appendChild(row);
  node.appendChild(childrenBox);
  return node;
}

async function renderChildrenInto(nodeEl, path) {
  const box = nodeEl.querySelector(':scope > .tree-children');
  let data = treeDataCache.get(path);
  if (data === undefined) {
    try {
      const res = await api.fetchNodeChildren(path);
      if (!res || !res.success) throw new Error((res && res.error) || 'fetch failed');
      data = res.data;
      treeDataCache.set(path, data);
    } catch (err) {
      log(`Failed to expand "${path}": ${err.message}`, 'err');
      return;
    }
  }
  if (!isObject(data)) return; // primitives have no children rows
  const frag = document.createDocumentFragment();
  for (const k of Object.keys(data).sort()) {
    frag.appendChild(makeTreeRow(k, data[k], joinPath(path, k), depthOf(path) + 1));
  }
  box.appendChild(frag);
  // Recurse into already-expanded descendants.
  const keys = Object.keys(data);
  for (const k of keys) {
    const childPath = joinPath(path, k);
    if (expandedPaths.has(childPath)) {
      const childNode = box.querySelector(`.tree-node[data-path="${cssEscape(childPath)}"]`);
      if (childNode) await renderChildrenInto(childNode, childPath);
    }
  }
}

function depthOf(path) {
  return path ? path.split('/').length : 0;
}

function cssEscape(s) {
  try { return CSS.escape(s); } catch (_) { return s.replace(/"/g, '\\"'); }
}

async function toggleExpand(fullPath, hasChildren) {
  if (!hasChildren) return;
  const nodeEl = elTree.querySelector(`.tree-node[data-path="${cssEscape(fullPath)}"]`);
  if (!nodeEl) return;
  const box = nodeEl.querySelector(':scope > .tree-children');
  const caret = nodeEl.querySelector(':scope > .tree-row > .tree-caret');
  if (expandedPaths.has(fullPath)) {
    expandedPaths.delete(fullPath);
    box.style.display = 'none';
    caret.classList.remove('open');
  } else {
    expandedPaths.add(fullPath);
    caret.classList.add('open');
    box.style.display = 'block';
    if (!box.hasChildNodes()) await renderChildrenInto(nodeEl, fullPath);
  }
}

function applyFilter() {
  const q = (elFilter.value || '').trim().toLowerCase();
  for (const node of elTree.querySelectorAll('.tree-node')) {
    const row = node.querySelector(':scope > .tree-row');
    if (!row) continue;
    const label = row.querySelector('.tree-label').textContent.toLowerCase();
    row.style.display = !q || label.includes(q) ? '' : 'none';
  }
}

async function rebuildTree() {
  try {
    elTree.innerHTML = '';
    treeDataCache.clear();
    const res = await api.fetchRootKeys();
    if (!res || !res.success) throw new Error((res && res.error) || 'root fetch failed');
    setConn(true);

    const rootRow = document.createElement('div');
    rootRow.className = 'tree-row';
    rootRow.style.paddingLeft = '8px';
    rootRow.dataset.path = '';
    const rl = document.createElement('span');
    rl.className = 'tree-label';
    rl.textContent = '🗄 / (root)';
    const rb = document.createElement('span');
    rb.className = 'tree-badges badge';
    rb.textContent = res.keys.length;
    rootRow.appendChild(rl);
    rootRow.appendChild(rb);
    rootRow.addEventListener('click', () => { try { selectPath(''); } catch (e) { log(e.message, 'err'); } });
    elTree.appendChild(rootRow);

    // Top-level rows need their values for caret/child-count — fetch once per node.
    const topPromises = res.keys.map(async (key) => {
      try {
        const r = await api.fetchNodeChildren(key);
        if (r && r.success) treeDataCache.set(key, r.data);
      } catch (_) { /* row still renders; expansion will retry */ }
    });
    await Promise.all(topPromises);

    for (const key of res.keys) {
      const node = makeTreeRow(key, treeDataCache.get(key), key, 1);
      elTree.appendChild(node);
    }
    applyFilter();
  } catch (err) {
    setConn(false);
    log(`Tree rebuild failed: ${err.message}`, 'err');
  }
}

// --- Path bar breadcrumbs ---------------------------------------------------
function renderPathBar() {
  try {
    elPathBar.innerHTML = '';
    const crumbs = [''];
    if (selectedPath) for (const seg of selectedPath.split('/')) crumbs.push(crumbs[crumbs.length - 1] ? joinPath(crumbs[crumbs.length - 1], seg) : seg);
    crumbs.forEach((p, i) => {
      const c = document.createElement('span');
      c.className = 'crumb' + (i === crumbs.length - 1 ? ' active' : '');
      c.textContent = p === '' ? '/' : p.split('/').pop();
      c.addEventListener('click', () => { try { selectPath(p); } catch (e) { log(e.message, 'err'); } });
      elPathBar.appendChild(c);
      if (i < crumbs.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'crumb';
        sep.textContent = ' / ';
        elPathBar.appendChild(sep);
      }
    });
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    elPathBar.appendChild(spacer);
    const add = document.createElement('button');
    add.id = 'btn-add-prop';
    add.className = 'btn';
    add.textContent = '+ Add Property';
    add.disabled = selectedPath === '';
    add.addEventListener('click', openAddModal);
    elPathBar.appendChild(add);
    const del = document.createElement('button');
    del.id = 'btn-delete-node';
    del.className = 'btn danger';
    del.textContent = '🗑 Delete Node';
    del.disabled = selectedPath === '';
    del.addEventListener('click', openDeleteModal);
    elPathBar.appendChild(del);
  } catch (err) {
    log(`Path bar render error: ${err.message}`, 'err');
  }
}

// --- Matrix editor -----------------------------------------------------------
function selectPath(p) {
  try {
    selectedPath = p;
    currentLoadedPath = null;
    for (const row of elTree.querySelectorAll('.tree-row')) {
      row.classList.toggle('selected', (row.dataset.path || '') === p);
    }
    renderPathBar();
    loadMatrix(p);
  } catch (err) {
    log(`Select error: ${err.message}`, 'err');
  }
}

async function loadMatrix(p) {
  try {
    elMatrixWrap.innerHTML = '';
    const res = await api.fetchNodeChildren(p);
    if (!res || !res.success) throw new Error((res && res.error) || 'node fetch failed');
    currentLoadedPath = p;
    treeDataCache.set(p, res.data);

    const data = res.data;
    if (isObject(data) && Object.keys(data).length > 0) {
      renderMatrixTable(p, data);
    } else if (isObject(data)) {
      elMatrixWrap.innerHTML = '<div id="welcome">Empty object — use <b>+ Add Property</b> to populate it.</div>';
    } else {
      // Scalar / null node: single editable row.
      const table = document.createElement('table');
      table.id = 'matrix-table';
      const tr = document.createElement('tr');
      const tdK = document.createElement('td');
      tdK.className = 'm-key';
      tdK.textContent = '(value)';
      const tdV = document.createElement('td');
      tdV.className = 'm-val editing-cell';
      tdV.dataset.path = p;
      tdV.dataset.raw = JSON.stringify(data === undefined ? null : data);
      tdV.textContent = displayValue(data === undefined ? null : data);
      tdV.classList.add('val-' + typeOfValue(data === undefined ? null : data));
      tdV.addEventListener('dblclick', () => {
        try { startCellEdit(tdV, p, data === undefined ? null : data); }
        catch (err) { log(`Cell edit error: ${err.message}`, 'err'); }
      });
      const tdT = document.createElement('td');
      tdT.className = 'm-type';
      tdT.textContent = typeOfValue(data === undefined ? null : data);
      tr.appendChild(tdK); tr.appendChild(tdV); tr.appendChild(tdT);
      table.appendChild(tr);
      elMatrixWrap.appendChild(table);
    }
    log(`Loaded "${p || '/'}" — ${isObject(data) ? Object.keys(data).length + ' keys' : typeOfValue(data)}.`, 'ok');
  } catch (err) {
    elMatrixWrap.innerHTML = `<div id="welcome">Failed to load node: ${err.message}</div>`;
  }
}

function renderMatrixTable(p, data) {
  const table = document.createElement('table');
  table.id = 'matrix-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Key</th><th>Value (double-click to edit)</th><th>Type</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  for (const k of Object.keys(data).sort()) {
    const v = data[k];
    const tr = document.createElement('tr');
    const tdK = document.createElement('td');
    tdK.className = 'm-key';
    tdK.textContent = k;
    const tdV = document.createElement('td');
    tdV.className = 'm-val editing-cell';
    tdV.dataset.key = k;
    tdV.dataset.path = joinPath(p, k);
    tdV.textContent = displayValue(v);
    tdV.classList.add('val-' + typeOfValue(v));
    const tdT = document.createElement('td');
    tdT.className = 'm-type';
    tdT.textContent = typeOfValue(v);

    tdV.addEventListener('dblclick', () => {
      try {
        if (isObject(v)) selectPath(joinPath(p, k)); // navigate into objects
        else startCellEdit(tdV, joinPath(p, k), v);
      } catch (err) {
        log(`Cell edit error: ${err.message}`, 'err');
      }
    });

    tr.appendChild(tdK); tr.appendChild(tdV); tr.appendChild(tdT);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  elMatrixWrap.appendChild(table);
}

// --- Inline cell editing ------------------------------------------------------
function startCellEdit(td, targetPath, currentValue) {
  try {
    if (isEditingCell) return;
    isEditingCell = true;
    const t = typeOfValue(currentValue);
    const input = document.createElement(t === 'string' && String(currentValue).includes('\n') ? 'textarea' : 'input');
    input.className = 'cell-input';
    if (input.tagName === 'INPUT') input.type = 'text';
    input.value = t === 'null' ? '' : String(currentValue);
    input.autocomplete = 'off';
    td.textContent = '';
    td.classList.add('editing');
    td.appendChild(input);
    input.focus();
    input.select && input.select();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      isEditingCell = false;
      try {
        if (!assertTargetPath(targetPath)) { await loadMatrix(selectedPath); return; }
        const coerced = (t === 'null' && input.value.trim() === '') ? null : input.value;
        log(`Saving ${targetPath} = "${input.value}"`, 'info');
        const res = await api.updateNodeValue({ targetPath, newValue: coerced });
        if (res && res.success) {
          log(`Saved ${targetPath} → ${JSON.stringify(res.value)} (${typeOfValue(res.value)})`, 'ok');
          treeDataCache.delete(selectedPath);
          await refreshAfterMutation();
        } else {
          log(`Save rejected: ${(res && res.error) || 'unknown error'}`, 'err');
          loadMatrix(selectedPath);
        }
      } catch (err) {
        log(`Save failed: ${err.message}`, 'err');
        loadMatrix(selectedPath);
      }
    };

    input.addEventListener('keydown', (e) => {
      try {
        if (e.key === 'Enter' && (input.tagName === 'TEXTAREA' ? !e.shiftKey : true)) { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { done = true; isEditingCell = false; loadMatrix(selectedPath); }
      } catch (_) { /* noop */ }
    });
    input.addEventListener('blur', () => commit());
  } catch (err) {
    isEditingCell = false;
    log(`Cell editor init error: ${err.message}`, 'err');
  }
}

// --- Modals --------------------------------------------------------------------
let pendingDeletePath = null;

function openDeleteModal() {
  try {
    if (!assertTargetPath(selectedPath)) return;
    pendingDeletePath = selectedPath;
    document.getElementById('modal-delete-path').textContent = '/' + selectedPath;
    modalDelete.classList.add('visible');
  } catch (err) {
    log(`Delete modal error: ${err.message}`, 'err');
  }
}

function closeModals() {
  try {
    modalDelete.classList.remove('visible');
    modalAdd.classList.remove('visible');
    pendingDeletePath = null;
  } catch (_) { /* noop */ }
}

async function confirmDelete() {
  const p = pendingDeletePath;
  closeModals();
  if (!p || !assertTargetPath(p)) return;
  try {
    log(`Deleting node /${p} …`, 'warn');
    const res = await api.deleteNode(p);
    if (res && res.success) {
      log(`Deleted /${p}.`, 'ok');
      expandedPaths.delete(p);
      for (const ep of Array.from(expandedPaths)) if (ep.startsWith(p + '/')) expandedPaths.delete(ep);
      if (selectedPath === p || selectedPath.startsWith(p + '/')) selectedPath = '';
      await refreshAfterMutation();
    } else {
      log(`Delete rejected: ${(res && res.error) || 'unknown error'}`, 'err');
    }
  } catch (err) {
    log(`Delete failed: ${err.message}`, 'err');
  }
}

function openAddModal() {
  try {
    if (!assertTargetPath(selectedPath)) return;
    document.getElementById('modal-add-parent').textContent = '/' + selectedPath;
    document.getElementById('add-key-input').value = '';
    document.getElementById('add-value-input').value = '';
    modalAdd.classList.add('visible');
    document.getElementById('add-key-input').focus();
  } catch (err) {
    log(`Add modal error: ${err.message}`, 'err');
  }
}

async function confirmAdd() {
  const key = document.getElementById('add-key-input').value.trim();
  const rawValue = document.getElementById('add-value-input').value;
  closeModals();
  if (!key) return;
  try {
    log(`Adding ${selectedPath}/${key} …`, 'info');
    const res = await api.addNodeKey({ targetPath: selectedPath, newKey: key, newValue: rawValue });
    if (res && res.success) {
      log(`Added /${res.path}.`, 'ok');
      await refreshAfterMutation();
    } else {
      log(`Add rejected: ${(res && res.error) || 'unknown error'}`, 'err');
    }
  } catch (err) {
    log(`Add failed: ${err.message}`, 'err');
  }
}

// --- Post-mutation refresh -------------------------------------------------------
async function refreshAfterMutation() {
  try {
    await rebuildTree();
    loadMatrix(selectedPath);
  } catch (err) {
    log(`Refresh after mutation failed: ${err.message}`, 'err');
  }
}

// --- Header actions -----------------------------------------------------------------
async function doBackup() {
  try {
    log('Requesting full database backup …', 'info');
    const res = await api.createLocalBackup();
    if (res && res.success) log(`Backup written: ${res.path} (${(res.bytes / 1024).toFixed(1)} KB)`, 'ok');
    else log(`Backup failed: ${(res && res.error) || 'unknown error'}`, 'err');
  } catch (err) {
    log(`Backup failed: ${err.message}`, 'err');
  }
}

async function doRefresh() {
  try {
    expandedPaths.clear();
    await rebuildTree();
    loadMatrix(selectedPath);
    log('Manual refresh complete.', 'ok');
  } catch (err) {
    log(`Refresh failed: ${err.message}`, 'err');
  }
}

// --- Wiring -----------------------------------------------------------------------------
btnRefresh.addEventListener('click', doRefresh);
btnBackup.addEventListener('click', doBackup);
btnExit.addEventListener('click', () => { try { window.firebaseApi.exitApp(); } catch (e) { log(e.message, 'err'); } });
document.getElementById('btn-modal-cancel').addEventListener('click', closeModals);
document.getElementById('btn-modal-confirm').addEventListener('click', confirmDelete);
document.getElementById('btn-add-cancel').addEventListener('click', closeModals);
document.getElementById('btn-add-confirm').addEventListener('click', confirmAdd);
elFilter.addEventListener('input', applyFilter);

// --- Init ----------------------------------------------------------------------------------
(async function init() {
  try {
    log('Crab Defence Dashboard starting …', 'info');
    startClock();
    await rebuildTree();
    selectPath('');
  } catch (err) {
    setConn(false);
    log(`Init error: ${err.message}`, 'err');
  }
})();
