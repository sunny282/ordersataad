/* ===== Shared helpers for all Netlify Functions =====
 * - Google service-account auth (server-to-server, no user OAuth needed)
 * - Thin Sheets API wrappers
 * - Technician session JWTs
 * - Password hashing
 * - Admin verification (re-uses the admin's own Google access token)
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const SHEET_ID = process.env.SHEET_ID;
const JWT_SECRET = process.env.JWT_SECRET;
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
// Netlify env vars can't contain real newlines easily — private key is stored
// with literal \n sequences, so we unescape them here.
const SA_KEY = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const USERS_TAB = 'Users';
const PENDING_TAB = 'PendingEdits';
const TEAMS_TAB = process.env.TEAMS_TAB || 'Teams';
const COORDINATORS_TAB = process.env.COORDINATORS_TAB || 'Coordinators';
const STATUS_PERM_TAB = process.env.STATUS_PERM_TAB || 'StatusPermissions';

// Seeded into StatusPermissions the first time it's needed, if that tab is
// empty or doesn't exist yet. After that, the SHEET is the source of truth
// for the sequence — not this list — so admins can add/reorder/remove
// statuses from the app without a code change.
const DEFAULT_STATUS_SEQUENCE = [
  'SubContractor Assigned',
  'Installation Scheduled',
  'Work In Progress',
  'Installation Tested and Completed',
  'Completed'
];
const PROBLEMATIC_STATUS = 'Problematic';

// Same fixed metadata layout the frontend uses (see app.js META_COLS).
const META_COLS = { team: 'A', orderId: 'B', rl: 'C', name: 'D', gsm: 'E', tag: 'F', date: 'G', status: 'H', gsm2: 'I', type: 'J', pop: 'K', desc: 'L' };

function colToIndex(letter) {
  letter = (letter || 'A').toUpperCase();
  let n = 0;
  for (let i = 0; i < letter.length; i++) n = n * 26 + (letter.charCodeAt(i) - 64);
  return n - 1;
}

// The writable tab + column layout are set once by the admin (Settings) and
// mirrored here as env vars so the serverless functions agree with the app.
function getSheetConfig() {
  return {
    progressTab: process.env.PROGRESS_TAB || 'Progress',
    colOrderId: (process.env.COL_ORDER_ID || META_COLS.orderId).toUpperCase(),
    colStatus: (process.env.COL_STATUS || META_COLS.status).toUpperCase(),
    colDesc: (process.env.COL_DESC || META_COLS.desc).toUpperCase(),
    colTeam: META_COLS.team
  };
}

/* ---- Service-account OAuth (JWT bearer flow) ----
 * Cached per warm function instance; re-fetched once it's close to expiry.
 */
let cachedToken = null; // { accessToken, expiresAt }

async function getServiceAccountToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60000) {
    return cachedToken.accessToken;
  }
  if (!SA_EMAIL || !SA_KEY) {
    throw new Error('Service account not configured (GOOGLE_SERVICE_ACCOUNT_EMAIL / _PRIVATE_KEY missing)');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: SA_EMAIL,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600
    },
    SA_KEY,
    { algorithm: 'RS256' }
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Service account auth failed: ' + body);
  }
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

function quoteTab(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

/* ---- Status sequence + per-status permissions ----
 * StatusPermissions tab layout (row 1 = header, kept for readability):
 * A statusName | B seqOrder (blank/0 = not part of the forward sequence —
 * this is how "Problematic" and any not-yet-placed status are stored) |
 * C autoApprove (TRUE/FALSE) | D viewOnly (TRUE/FALSE)
 *
 * This tab — not any hardcoded list, and not whatever's sitting in the
 * sheet's Status column dropdown — is the source of truth for which
 * statuses technicians can pick and in what order. Admins add/reorder/
 * remove statuses through the app; nothing here is auto-picked up from
 * the sheet.
 */
async function ensureStatusPermissionsTab() {
  const names = await getAllTabNames();
  if (!names.includes(STATUS_PERM_TAB)) {
    await sheetsFetch(`${SHEET_ID}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: STATUS_PERM_TAB } } }] })
    });
    const seedRows = [
      ['statusName', 'seqOrder', 'autoApprove', 'viewOnly'],
      ...DEFAULT_STATUS_SEQUENCE.map((name, i) => [name, String(i + 1), 'FALSE', 'FALSE']),
      [PROBLEMATIC_STATUS, '', 'FALSE', 'FALSE']
    ];
    for (const row of seedRows) await appendRow(STATUS_PERM_TAB, row);
    return;
  }
  // Tab exists but might be empty (e.g. created manually) — seed it once.
  const rows = await readTab(STATUS_PERM_TAB);
  if (rows.length <= 1) {
    if (!rows.length) await appendRow(STATUS_PERM_TAB, ['statusName', 'seqOrder', 'autoApprove', 'viewOnly']);
    const existing = new Set(rows.slice(1).map((r) => (r[0] || '').trim().toLowerCase()));
    const toSeed = [...DEFAULT_STATUS_SEQUENCE.map((name, i) => [name, String(i + 1), 'FALSE', 'FALSE']), [PROBLEMATIC_STATUS, '', 'FALSE', 'FALSE']]
      .filter((r) => !existing.has(r[0].toLowerCase()));
    for (const row of toSeed) await appendRow(STATUS_PERM_TAB, row);
  }
}

// Returns { list: [{name, seqOrder|null, autoApprove, viewOnly, rowNum}],
// sequence: [names in order] } — sequence excludes Problematic and any
// status not currently placed (seqOrder blank).
async function getStatusConfig() {
  await ensureStatusPermissionsTab();
  const rows = await readTab(STATUS_PERM_TAB);
  const list = rows.slice(1).map((r, i) => ({
    rowNum: i + 2,
    name: (r[0] || '').trim(),
    seqOrder: r[1] !== undefined && r[1] !== '' ? parseInt(r[1], 10) : null,
    autoApprove: (r[2] || '').toString().trim().toUpperCase() === 'TRUE',
    viewOnly: (r[3] || '').toString().trim().toUpperCase() === 'TRUE'
  })).filter((s) => s.name);
  const sequence = list
    .filter((s) => s.seqOrder !== null && !Number.isNaN(s.seqOrder))
    .sort((a, b) => a.seqOrder - b.seqOrder)
    .map((s) => s.name);
  return { list, sequence };
}

function statusCfgFor(statusConfig, name) {
  return statusConfig.list.find((s) => s.name.toLowerCase() === (name || '').trim().toLowerCase()) || null;
}

// The single source of truth for what a technician may do to an order
// currently in `currentStatus`, given the admin-configured sequence +
// permissions. Used both to render the 3-choice UI and — critically — to
// re-validate every submission server-side, so a crafted request can never
// pick a status outside these options.
// Returns { viewOnly: bool, options: [{ value, label, kind }] } where kind
// is 'keep' | 'next' | 'problematic'. options is empty when viewOnly.
function computeTechStatusOptions(currentStatus, statusConfig) {
  const currentCfg = statusCfgFor(statusConfig, currentStatus);
  if (currentCfg && currentCfg.viewOnly) {
    return { viewOnly: true, options: [] };
  }
  const options = [];
  options.push({ value: currentStatus || '', label: 'Keep Current Status', kind: 'keep' });
  const idx = statusConfig.sequence.findIndex((s) => s.toLowerCase() === (currentStatus || '').trim().toLowerCase());
  if (idx !== -1 && idx < statusConfig.sequence.length - 1) {
    const next = statusConfig.sequence[idx + 1];
    options.push({ value: next, label: next, kind: 'next' });
  }
  if ((currentStatus || '').trim().toLowerCase() !== PROBLEMATIC_STATUS.toLowerCase()) {
    options.push({ value: PROBLEMATIC_STATUS, label: PROBLEMATIC_STATUS, kind: 'problematic' });
  }
  return { viewOnly: false, options };
}

async function sheetsFetch(path, opts = {}, bearerToken) {
  const token = bearerToken || (await getServiceAccountToken());
  const res = await fetch(`${SHEETS_BASE}/${path}`, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error('Sheets API error: ' + body);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Reads a whole tab (A1:Z5000). Returns { values: [[...], ...] }
async function readTab(tabName, sheetId = SHEET_ID) {
  const range = encodeURIComponent(`${quoteTab(tabName)}!A1:Z5000`);
  const data = await sheetsFetch(`${sheetId}/values/${range}`);
  return data.values || [];
}

async function getAllTabNames(sheetId = SHEET_ID) {
  const data = await sheetsFetch(`${sheetId}?fields=sheets.properties.title`);
  return (data.sheets || []).map((s) => s.properties.title);
}

async function batchGetAllTabs(tabNames, sheetId = SHEET_ID) {
  const ranges = tabNames.map((t) => `ranges=${encodeURIComponent(quoteTab(t) + '!A1:Z5000')}`).join('&');
  const data = await sheetsFetch(`${sheetId}/values:batchGet?${ranges}`);
  return data.valueRanges || [];
}

async function appendRow(tabName, row, sheetId = SHEET_ID) {
  const range = encodeURIComponent(`${quoteTab(tabName)}!A1`);
  return sheetsFetch(
    `${sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: [row] }) }
  );
}

async function updateCell(tabName, a1Cell, value, sheetId = SHEET_ID) {
  const range = encodeURIComponent(`${quoteTab(tabName)}!${a1Cell}`);
  return sheetsFetch(`${sheetId}/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ range: `${quoteTab(tabName)}!${a1Cell}`, values: [[value]] })
  });
}

async function batchUpdate(sheetId, data) {
  return sheetsFetch(`${sheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data })
  });
}

/* ---- Technician sessions (username/password, JWT) ---- */
function signTechSession(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}
function verifyTechSession(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded && decoded.role === 'technician' ? decoded : null;
  } catch (e) {
    return null;
  }
}

/* ---- Coordinator sessions (username/password, JWT) ----
 * Same shape as technician sessions but role: 'coordinator' and a `teams`
 * array (a coordinator can be assigned more than one team) instead of a
 * single `team`.
 */
function signCoordinatorSession(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}
function verifyCoordinatorSession(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded && decoded.role === 'coordinator' ? decoded : null;
  } catch (e) {
    return null;
  }
}

function getBearer(event) {
  const h = event.headers.authorization || event.headers.Authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

/* ---- Admin verification ----
 * Admins keep using their own Google sign-in (unchanged from the original
 * app). We verify their token is real and has edit access to THIS sheet by
 * asking the Sheets API for the spreadsheet's metadata using their token —
 * if that succeeds, they have the same edit rights as before.
 */
async function verifyAdmin(event) {
  const token = getBearer(event);
  if (!token) return false;
  try {
    await sheetsFetch(`${SHEET_ID}?fields=spreadsheetId`, {}, token);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---- Combined admin-or-coordinator verification ----
 * Used by endpoints both roles can reach (Pending Edits, Orders Dashboard).
 * Coordinator tokens are checked first — a cheap local JWT verify — before
 * falling back to the admin check, which costs a real Sheets API call.
 * Returns { role: 'admin' } | { role: 'coordinator', username, teams,
 * fullName } | null.
 */
async function verifyRequester(event) {
  const token = getBearer(event);
  if (token) {
    const coordSession = verifyCoordinatorSession(token);
    if (coordSession) {
      return {
        role: 'coordinator',
        username: coordSession.username,
        teams: coordSession.teams || [],
        fullName: coordSession.fullName || ''
      };
    }
  }
  const isAdmin = await verifyAdmin(event);
  if (isAdmin) return { role: 'admin' };
  return null;
}

/* ---- Passwords ---- */
async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
async function comparePassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

/* ---- HTTP response helpers ---- */
function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

module.exports = {
  SHEET_ID,
  USERS_TAB,
  PENDING_TAB,
  TEAMS_TAB,
  COORDINATORS_TAB,
  STATUS_PERM_TAB,
  DEFAULT_STATUS_SEQUENCE,
  PROBLEMATIC_STATUS,
  META_COLS,
  colToIndex,
  getSheetConfig,
  quoteTab,
  ensureStatusPermissionsTab,
  getStatusConfig,
  statusCfgFor,
  computeTechStatusOptions,
  readTab,
  getAllTabNames,
  batchGetAllTabs,
  appendRow,
  updateCell,
  batchUpdate,
  sheetsFetch,
  signTechSession,
  verifyTechSession,
  signCoordinatorSession,
  verifyCoordinatorSession,
  getBearer,
  verifyAdmin,
  verifyRequester,
  hashPassword,
  comparePassword,
  json
};
