# Crab Defence Dashboard

Desktop administration tool for the **Crab Defence** production Firebase Realtime Database — browse, edit, and back up live game data from a secure Electron app. Internal tooling by Landcrab Interactive.

## Features

- **Live RTDB access** via Firebase Admin SDK (service account, full admin privileges)
- **Recursive tree navigator** — expand/collapse through `playerStats`, `balanceDebug`, `adWatchLedger`, `purchaseLedger`, `adBannerLedger` and any nested node
- **Matrix table editor** — inline double-click cell editing with automatic type coercion (number / boolean / string / JSON object)
- **Player ID search** — locate a specific player node instantly
- **Full database export** — one-click dump to timestamped local JSON backups
- **Live status log** — footer streams Firebase init, loads, saves, guard rejections, and backup writes in real time
- **Dark theme** — `#0b0c10` base, `#66fcf1` cyan accents

## Quick start

**Requirements:** Node.js v20+ (tested on v22) · Windows 10/11 for the bundled launcher (`npm start` works cross-platform) · a Firebase service account JSON with RTDB admin access for the Crab Defence project.

```bat
npm install
```

1. Place the service account key in the git-ignored `.hermes/` directory — the expected filename is defined as `SERVICE_ACCOUNT_FILE` in `src/main.js`. If it's missing, the app logs a clear startup error instead of guessing.
2. Launch:

   ```bat
   start.bat
   ```

   or from any platform: `npx electron .` / `npm start`

> **Never commit credentials.** The `.hermes/` directory and all backup dumps are covered by `.gitignore`.

## Safety Guardrails

| Guard | Behavior |
|---|---|
| Root/empty path block | Any update or delete targeting `/`, `''`, or whitespace is rejected with an error before it reaches the database |
| Path traversal block | Path segments containing `.` or `..` are rejected |
| Protected node: `purchaseLedger` | All mutation under this directory (update, add, delete) is hard-blocked in the main process — purchase records can never be edited or removed through the UI |
| Destructive confirmations | Deleting a node always requires an explicit confirmation dialog showing the exact path |
| Crash isolation | Every IPC handler runs inside an isolated `try/catch` wrapper — no single failure can lock up or crash the app |

## Architecture

```
src/main.js     Electron main process — Firebase Admin init, IPC handlers (fetch/update/delete/backup/search), safety guards
src/preload.js  contextBridge — exposes window.firebaseApi to the renderer (contextIsolation on)
renderer.js     UI logic — tree navigator, matrix editor, modals, status log
index.html      Shell + CSP (default-src 'self')
```

The renderer has no Node access; all database operations go through IPC to the main process, where every mutation is validated against the safety guards before it touches the database.

## Backups

Full production dumps are written to `.backups/` (git-ignored):

```
.backups/backup_crabdefence_prod_YYYYMMDD_HHMMSS.json
```

Backups are created on demand via the **Backup DB** button — run one manually before any bulk operation.
