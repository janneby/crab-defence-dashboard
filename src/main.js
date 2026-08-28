'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

// --- Constants ---------------------------------------------------------------
const PROJECT_ROOT = path.join(__dirname, '..');
const HERMES_DIR = path.join(PROJECT_ROOT, '.hermes');
const BACKUP_DIR = path.join(PROJECT_ROOT, '.backups');
const SERVICE_ACCOUNT_FILE = path.join(HERMES_DIR, 'crab-defence-firebase-adminsdk-fbsvc-732244e3c4.json');
const DATABASE_URL = 'https://crab-defence-default-rtdb.europe-west1.firebasedatabase.app';
const PROTECTED_NODE = 'purchaseLedger'; // NEVER delete or mutate — hard guard below.

let db = null;

function requireDb() {
  if (!db) throw new Error('Firebase Admin SDK is not initialized.');
  return db;
}

// --- Safety guards -----------------------------------------------------------

// Strict empty/root bounds guard — mandatory for every mutation handler.
function assertValidTargetPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim() || targetPath.trim() === '/') {
    return { success: false, error: 'Empty or root path bounds violation block triggered.' };
  }
  const clean = targetPath.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean === '') {
    return { success: false, error: 'Root path is not a valid mutation target.' };
  }
  const segments = clean.split('/');
  if (segments.some((s) => s.trim() === '')) {
    return { success: false, error: `Invalid path segments in "${targetPath}".` };
  }
  if (segments.includes('..') || segments.includes('.')) {
    return { success: false, error: 'Path traversal is not allowed.' };
  }
  if (segments[0].toLowerCase() === PROTECTED_NODE.toLowerCase()) {
    return { success: false, error: `PROTECTED NODE "${PROTECTED_NODE}" — mutation blocked.` };
  }
  return { ok: true, cleanPath: clean };
}

// Coerce string input to the correct primitive; pass typed values through.
function coerceValue(raw) {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      const parsed = JSON.parse(t);
      if (parsed !== null && typeof parsed === 'object') return parsed; // object/array round-trip
    } catch (_) { /* not valid JSON — fall through to string */ }
  }
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) && /[.eE]/.test(t)) return parseFloat(t);
  return raw; // keep as string (leading zeros, whitespace, etc.)
}

function countChildren(v) {
  if (v === null || v === undefined || typeof v !== 'object') return 0;
  return Object.keys(v).length;
}

// Wrap every handler so a thrown error can never crash the main process.
function safeHandle(channel, handler) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`[main] ${channel}:`, err && err.message ? err.message : err);
      return { success: false, error: (err && err.message) || String(err) };
    }
  });
}

// --- IPC handlers --------------------------------------------------------------

safeHandle('fetch-root-keys', async () => {
  const snap = await requireDb().ref().once('value');
  const val = snap.val();
  return { success: true, keys: val && typeof val === 'object' ? Object.keys(val).sort() : [] };
});

safeHandle('fetch-node-children', async (targetPath) => {
  const p = (targetPath || '').trim() === '/' ? '' : (targetPath || '').trim().replace(/^\/+/, '');
  if (p && p.includes('..')) return { success: false, error: 'Path traversal is not allowed.' };
  const ref = p === '' ? requireDb().ref() : requireDb().ref(p); // db.ref('') is invalid — root needs no arg.
  const snap = await ref.once('value');
  const val = snap.val();
  return {
    success: true,
    path: p,
    data: val,
    keys: val && typeof val === 'object' ? Object.keys(val).sort() : []
  };
});

safeHandle('update-node-value', async (payload) => {
  const guard = assertValidTargetPath(payload && payload.targetPath);
  if (!guard.ok) return guard;
  const coerced = coerceValue(payload && payload.newValue !== undefined ? payload.newValue : '');
  await requireDb().ref(guard.cleanPath).set(coerced);
  return { success: true, path: guard.cleanPath, value: coerced };
});

safeHandle('add-node-key', async (payload) => {
  const base = ((payload && payload.targetPath) || '').trim() === '/' ? '' : ((payload && payload.targetPath) || '').trim();
  if (!base) return { success: false, error: 'Cannot add keys at the database root without a parent path.' };
  const key = String((payload && payload.newKey) || '').trim();
  if (!key || key.includes('/') || key === '.' || key === '$') {
    return { success: false, error: `Invalid key name "${key}".` };
  }
  const guardedBase = assertValidTargetPath(base);
  if (!guardedBase.ok) return guardedBase;
  await requireDb().ref(guardedBase.cleanPath).update({ [key]: coerceValue(payload && payload.newValue !== undefined ? payload.newValue : '') });
  return { success: true, path: `${guardedBase.cleanPath}/${key}` };
});

safeHandle('delete-node', async (targetPath) => {
  const guard = assertValidTargetPath(targetPath);
  if (!guard.ok) return guard;
  await requireDb().ref(guard.cleanPath).remove();
  return { success: true, path: guard.cleanPath };
});

safeHandle('search-player-id', async (playerId) => {
  const id = String(playerId || '').trim();
  if (!id) return { success: false, error: 'Empty player ID.' };
  const snap = await requireDb().ref().once('value');
  const root = snap.val() || {};
  const results = [];
  for (const topKey of Object.keys(root)) {
    const topVal = root[topKey];
    if (topKey === id) {
      results.push({ path: topKey, matchType: 'node-key', childCount: countChildren(topVal) });
      continue;
    }
    if (!topVal || typeof topVal !== 'object') continue;
    for (const k1 of Object.keys(topVal)) {
      const v1 = topVal[k1];
      if (k1 === id) {
        results.push({ path: `${topKey}/${k1}`, matchType: 'node-key', childCount: countChildren(v1) });
      } else if (v1 && typeof v1 === 'object') {
        for (const k2 of Object.keys(v1)) {
          const v2 = v1[k2];
          if (k2 === id) {
            results.push({ path: `${topKey}/${k1}/${k2}`, matchType: 'node-key', childCount: countChildren(v2) });
          } else if (v2 && typeof v2 === 'object') {
            for (const k3 of Object.keys(v2)) {
              if (k3 === id) results.push({ path: `${topKey}/${k1}/${k2}/${k3}`, matchType: 'node-key', childCount: countChildren(v2[k3]) });
            }
          }
        }
      }
    }
  }
  return { success: true, playerId: id, results };
});

safeHandle('create-local-backup', async () => {
  const snap = await requireDb().ref().once('value');
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const file = path.join(BACKUP_DIR, `backup_crabdefence_prod_${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(snap.val(), null, 2), 'utf8');
  return { success: true, path: file, bytes: fs.statSync(file).size };
});

safeHandle('app-exit', async () => {
  app.quit();
  return { success: true };
});

// --- Firebase init + window ------------------------------------------------------

function initFirebase() {
  if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    throw new Error(`Service account not found: ${SERVICE_ACCOUNT_FILE}`);
  }
  const account = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(account),
    databaseURL: DATABASE_URL
  });
  db = admin.database();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0c10',
    title: 'Crab Defence Dashboard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(PROJECT_ROOT, 'index.html'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    try {
      initFirebase();
      console.log('[main] Firebase Admin SDK initialized.');
    } catch (err) {
      console.error('[main] Firebase init failed:', err.message);
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
