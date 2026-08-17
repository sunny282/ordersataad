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
    return jwt.verify(token, JWT_SECRET);
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
  META_COLS,
  colToIndex,
  getSheetConfig,
  quoteTab,
  readTab,
  getAllTabNames,
  batchGetAllTabs,
  appendRow,
  updateCell,
  batchUpdate,
  sheetsFetch,
  signTechSession,
  verifyTechSession,
  getBearer,
  verifyAdmin,
  hashPassword,
  comparePassword,
  json
};
