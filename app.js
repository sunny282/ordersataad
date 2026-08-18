/* ===== Config (stored locally on this device only) ===== */
const CFG_KEY = 'orderUpdateAppConfig';

const DEFAULTS = {
  clientId: '254499377231-qt3nra5unvntgh6ae20ns1loa4v97089.apps.googleusercontent.com',
  sheetId: '1_OB89OUbvB9rbPIECxpFcql8Bvxlss_N2gE2mi4QRE8',
  progressTab: 'Progress',
  colOrderId: 'B',
  colStatus: 'H',
  colDesc: 'L'
};

function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(CFG_KEY)) || {};
    return Object.assign({}, DEFAULTS, stored);
  } catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}
let config = loadConfig();

/* ===== Appearance (admin: colors/background) ===== */
const THEME_KEY = 'orderUpdateTheme';
const THEME_VARS = [
  { key: '--bg', label: 'Page background' },
  { key: '--bg-elev', label: 'Panel background' },
  { key: '--bg-card', label: 'Card background' },
  { key: '--border', label: 'Borders' },
  { key: '--text', label: 'Text' },
  { key: '--muted', label: 'Muted / hint text' },
  { key: '--accent', label: 'Accent (buttons, highlights)' },
  { key: '--accent-dim', label: 'Accent (hover state)' },
  { key: '--ok', label: 'Success' },
  { key: '--warn', label: 'Warning' },
  { key: '--danger', label: 'Danger' }
];

function loadThemeOverrides() {
  try { return JSON.parse(localStorage.getItem(THEME_KEY)) || {}; } catch (e) { return {}; }
}
function applyTheme() {
  const stored = loadThemeOverrides();
  Object.entries(stored).forEach(([key, value]) => {
    document.documentElement.style.setProperty(key, value);
  });
}
function saveThemeOverride(key, value) {
  const stored = loadThemeOverrides();
  stored[key] = value;
  localStorage.setItem(THEME_KEY, JSON.stringify(stored));
}
function resetTheme() {
  localStorage.removeItem(THEME_KEY);
  THEME_VARS.forEach((v) => document.documentElement.style.removeProperty(v.key));
}
applyTheme(); // apply any saved overrides immediately, before the rest of the app boots

/* ===== Column letter helpers ===== */
function colToIndex(letter) {
  letter = (letter || 'A').toUpperCase();
  let n = 0;
  for (let i = 0; i < letter.length; i++) n = n * 26 + (letter.charCodeAt(i) - 64);
  return n - 1; // zero-based
}
// Fixed metadata column layout (standard order log format)
const META_COLS = { team: 'A', rl: 'C', name: 'D', gsm: 'E', tag: 'F', date: 'G', gsm2: 'I', type: 'J', pop: 'K' };

/* ===== Elements ===== */
const el = (id) => document.getElementById(id);
const setupNotice = el('setupNotice');
const signInGate = el('signInGate');
const searchSection = el('searchSection');
const tabPicker = el('tabPicker');
const orderCard = el('orderCard');
const signedOut = el('signedOut');
const signedIn = el('signedIn');
const settingsBtn = el('settingsBtn');
const toastEl = el('toast');

let accessToken = null;
let adminEmail = '';
let tokenClient = null;
let silentAuthAttempt = false; // true while auto-retrying auth in the background, to suppress the failure toast

const ADMIN_SESSION_KEY = 'orderUpdateAdminSession';
function saveAdminSession(token, expiresIn) {
  const expiresAt = Date.now() + (expiresIn ? expiresIn * 1000 : 3500 * 1000);
  localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify({ token, expiresAt }));
}
// Restores a still-valid cached token so a page reload doesn't require
// signing in again. Returns true if a valid session was restored.
function restoreAdminSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY));
    if (stored && stored.token && stored.expiresAt && Date.now() < stored.expiresAt - 60000) {
      accessToken = stored.token;
      return true;
    }
  } catch (e) { /* ignore malformed/missing cache */ }
  return false;
}
function clearAdminSession() {
  localStorage.removeItem(ADMIN_SESSION_KEY);
}
let currentRow = null;   // row number of currently loaded order
let currentTab = null;   // tab name of currently loaded order
let lastMatches = [];    // matches from the most recent search, across all tabs

/* ===== Toast ===== */
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

/* ===== View state ===== */
function configComplete() {
  return config.clientId && config.sheetId && config.progressTab;
}

function refreshView() {
  const techApp = el('techApp');
  const techSignedIn = el('techSignedIn');
  const adminToolsBtns = el('adminToolsBtns');

  // Technician session takes priority — separate world from the admin flow.
  if (techToken) {
    signInGate.classList.add('hidden');
    signedOut.classList.add('hidden');
    signedIn.classList.add('hidden');
    techSignedIn.classList.remove('hidden');
    el('techWhoAmI').textContent = techSession.fullName || techSession.username;
    settingsBtn.classList.add('hidden');
    adminToolsBtns.classList.add('hidden');
    searchSection.classList.add('hidden');
    tabPicker.classList.add('hidden');
    orderCard.classList.add('hidden');
    techApp.classList.remove('hidden');
    return;
  }
  techSignedIn.classList.add('hidden');
  techApp.classList.add('hidden');
  settingsBtn.classList.add('hidden');

  const hasConfig = configComplete();
  setupNotice.classList.toggle('hidden', hasConfig);
  el('signInBtn').disabled = !hasConfig;

  if (!hasConfig) {
    signInGate.classList.toggle('hidden', !!accessToken);
    searchSection.classList.add('hidden');
    tabPicker.classList.add('hidden');
    orderCard.classList.add('hidden');
    adminToolsBtns.classList.add('hidden');
    if (!accessToken) return;
  }

  if (accessToken) {
    signedOut.classList.add('hidden');
    signedIn.classList.remove('hidden');
    signInGate.classList.add('hidden');
    searchSection.classList.remove('hidden');
    adminToolsBtns.classList.remove('hidden');
    settingsBtn.classList.remove('hidden');
    refreshPendingBadge();
  } else {
    signedOut.classList.remove('hidden');
    signedIn.classList.add('hidden');
    signInGate.classList.remove('hidden');
    searchSection.classList.add('hidden');
    tabPicker.classList.add('hidden');
    orderCard.classList.add('hidden');
    adminToolsBtns.classList.add('hidden');
  }
}

/* ===== Google Identity Services auth ===== */
function initAuth() {
  if (!configComplete() || !window.google) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: config.clientId,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email',
    callback: (resp) => {
      if (resp.error) {
        if (!silentAuthAttempt) toast('Sign-in failed: ' + resp.error);
        silentAuthAttempt = false;
        return;
      }
      silentAuthAttempt = false;
      accessToken = resp.access_token;
      saveAdminSession(accessToken, resp.expires_in);
      refreshView();
      loadKnownStatuses();
      fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer ' + accessToken }
      }).then((r) => r.json()).then((u) => { adminEmail = u.email || ''; }).catch(() => {});
    }
  });
}

function signIn() {
  if (!tokenClient) initAuth();
  if (!tokenClient) { toast('Add settings first'); return; }
  tokenClient.requestAccessToken({ prompt: '' });
}

function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  clearAdminSession();
  currentRow = null;
  refreshView();
}

/* ===== Sheets API ===== */
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function apiGet(url) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!res.ok) throw await res.json().catch(() => new Error('Sheets read failed'));
  return res.json();
}

async function apiBatchUpdate(data) {
  const url = `${SHEETS_BASE}/${config.sheetId}/values:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ valueInputOption: 'RAW', data })
  });
  if (!res.ok) throw await res.json().catch(() => new Error('Sheets update failed'));
  return res.json();
}

// Quote a tab name for use in an A1-notation range if it needs it
function quoteTab(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

async function getAllTabNames() {
  const url = `${SHEETS_BASE}/${config.sheetId}?fields=sheets.properties.title`;
  const data = await apiGet(url);
  return (data.sheets || []).map((s) => s.properties.title);
}

// Populates the admin status dropdown with the standard status list plus
// any other distinct, non-empty values already used in the writable tab's
// Status column — so older/custom statuses already in the sheet still show
// up even if they're not in the standard list.
let adminKnownStatuses = [];
async function loadKnownStatuses() {
  if (!accessToken || !config.sheetId || !config.progressTab) return;
  try {
    const range = encodeURIComponent(`${quoteTab(config.progressTab)}!${config.colStatus}1:${config.colStatus}5000`);
    const url = `${SHEETS_BASE}/${config.sheetId}/values/${range}`;
    const data = await apiGet(url);
    const values = (data.values || []).map((r) => (r[0] || '').toString().trim()).filter(Boolean);
    const extra = [...new Set(values)].filter((s) => !STATUS_LIST.includes(s)).sort((a, b) => a.localeCompare(b));
    adminKnownStatuses = [...STATUS_LIST, ...extra];
    populateStatusSelect(el('statusSelect').value);
  } catch (e) { /* ignore — dropdown just falls back to the standard list */ }
}

function populateStatusSelect(current) {
  const select = el('statusSelect');
  const options = adminKnownStatuses.length ? adminKnownStatuses : STATUS_LIST;
  const full = current && !options.includes(current) ? [...options, current] : options;
  select.innerHTML = full.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  if (current) select.value = current;
}

async function batchGetAllTabs(tabNames) {
  const ranges = tabNames.map((t) => `ranges=${encodeURIComponent(quoteTab(t) + '!A1:Z5000')}`).join('&');
  const url = `${SHEETS_BASE}/${config.sheetId}/values:batchGet?${ranges}`;
  const data = await apiGet(url);
  return data.valueRanges || [];
}

/* ===== Search across every tab ===== */
el('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el('orderIdInput').value.trim();
  if (!q) return;
  const statusLine = el('searchStatus');
  statusLine.textContent = 'Searching all tabs…';
  statusLine.className = 'status-line loading';
  tabPicker.classList.add('hidden');
  orderCard.classList.add('hidden');

  try {
    const tabNames = await getAllTabNames();
    const valueRanges = await batchGetAllTabs(tabNames);
    const orderIdIdx = colToIndex(config.colOrderId);
    const needle = q.toLowerCase();

    const matches = [];
    valueRanges.forEach((vr, tabIdx) => {
      const rows = vr.values || [];
      for (let i = 0; i < rows.length; i++) {
        const cell = (rows[i][orderIdIdx] || '').toString().trim().toLowerCase();
        if (cell && cell.includes(needle)) {
          matches.push({ tabName: tabNames[tabIdx], rowNum: i + 1, row: rows[i] });
        }
      }
    });

    lastMatches = matches;

    if (matches.length === 0) {
      statusLine.textContent = 'No order found with that number in any tab.';
      statusLine.className = 'status-line err';
      return;
    }

    statusLine.textContent = '';
    statusLine.className = 'status-line';

    if (matches.length === 1) {
      loadMatch(matches[0]);
    } else {
      showTabPicker(matches);
    }
  } catch (err) {
    console.error(err);
    statusLine.textContent = 'Error reading sheet — check settings & sign-in.';
    statusLine.className = 'status-line err';
  }
});

function showTabPicker(matches) {
  const list = el('tabPickerList');
  list.innerHTML = '';
  matches.forEach((m) => {
    const isWritable = m.tabName === config.progressTab;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab-option';
    btn.innerHTML = `
      <span>
        <span class="tab-name">${m.tabName}</span>
        <span class="tab-sub">${cellAt(m.row, config.colOrderId) || 'Order ' + config.colOrderId}</span>
      </span>
      <span class="tab-badge ${isWritable ? '' : 'readonly'}">${isWritable ? 'Editable' : 'View only'}</span>
    `;
    btn.addEventListener('click', () => loadMatch(m));
    list.appendChild(btn);
  });
  tabPicker.classList.remove('hidden');
  tabPicker.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function loadMatch(match) {
  tabPicker.classList.add('hidden');
  currentTab = match.tabName;
  populateOrderCard(match.rowNum, match.row);
}

function cellAt(row, letter) {
  return row[colToIndex(letter)] || '';
}

function populateOrderCard(rowNum, row) {
  currentRow = rowNum;

  const writable = currentTab === config.progressTab;
  const readOnlyNotice = el('readOnlyNotice');
  readOnlyNotice.classList.toggle('hidden', writable);
  el('readOnlyTabName').textContent = currentTab;
  el('writableTabLabel').textContent = config.progressTab;

  el('statusSelect').disabled = !writable;
  el('descInput').disabled = !writable;
  el('saveBtn').classList.toggle('hidden', !writable);

  el('orderTeam').textContent = (cellAt(row, META_COLS.team) || '—') + '  ·  ' + currentTab;
  el('orderName').textContent = cellAt(row, META_COLS.name) || '—';
  el('metaOrderId').textContent = cellAt(row, config.colOrderId) || '—';
  el('metaRl').textContent = cellAt(row, META_COLS.rl) || '—';
  el('metaGsm').textContent = cellAt(row, META_COLS.gsm) || '—';
  el('metaPop').textContent = cellAt(row, META_COLS.pop) || '—';
  el('metaType').textContent = cellAt(row, META_COLS.type) || '—';
  el('metaDate').textContent = cellAt(row, META_COLS.date) || '—';

  const status = cellAt(row, config.colStatus) || '';
  el('statusPillPreview').textContent = status || '—';
  populateStatusSelect(status);
  el('descInput').value = cellAt(row, config.colDesc) || '';

  el('saveStatus').textContent = '';
  el('saveStatus').className = 'status-line';
  orderCard.classList.remove('hidden');
  orderCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ===== Save update ===== */
el('updateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentRow || currentTab !== config.progressTab) return;
  const saveBtn = el('saveBtn');
  const saveStatus = el('saveStatus');
  saveBtn.disabled = true;
  saveStatus.textContent = 'Saving…';
  saveStatus.className = 'status-line loading';

  const status = el('statusSelect').value.trim();
  const desc = el('descInput').value;
  const tabRef = quoteTab(config.progressTab);

  try {
    await apiBatchUpdate([
      { range: `${tabRef}!${config.colStatus}${currentRow}`, values: [[status]] },
      { range: `${tabRef}!${config.colDesc}${currentRow}`, values: [[desc]] }
    ]);
    saveStatus.textContent = 'Saved ✓';
    saveStatus.className = 'status-line ok';
    el('statusPillPreview').textContent = status;
    toast('Order updated');
    loadKnownStatuses();
  } catch (err) {
    console.error(err);
    saveStatus.textContent = 'Save failed — try again.';
    saveStatus.className = 'status-line err';
  } finally {
    saveBtn.disabled = false;
  }
});

el('cancelBtn').addEventListener('click', () => {
  orderCard.classList.add('hidden');
  tabPicker.classList.add('hidden');
  el('orderIdInput').value = '';
  el('orderIdInput').focus();
});

/* ===== Settings drawer ===== */
const settingsOverlay = el('settingsOverlay');
function openSettings() {
  el('clientIdInput').value = config.clientId || '';
  el('sheetIdInput').value = config.sheetId || '';
  el('progressTabInput').value = config.progressTab || '';
  el('colOrderId').value = config.colOrderId || 'B';
  el('colStatus').value = config.colStatus || 'H';
  el('colDesc').value = config.colDesc || 'L';
  settingsOverlay.classList.remove('hidden');
}
el('settingsBtn').addEventListener('click', openSettings);
el('closeSettings').addEventListener('click', () => settingsOverlay.classList.add('hidden'));
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
});

el('settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  config = {
    clientId: el('clientIdInput').value.trim(),
    sheetId: el('sheetIdInput').value.trim(),
    progressTab: el('progressTabInput').value.trim(),
    colOrderId: (el('colOrderId').value.trim() || 'B').toUpperCase(),
    colStatus: (el('colStatus').value.trim() || 'H').toUpperCase(),
    colDesc: (el('colDesc').value.trim() || 'L').toUpperCase()
  };
  saveConfig(config);
  settingsOverlay.classList.add('hidden');
  accessToken = null; // require re-auth against (possibly) new client id
  clearAdminSession();
  initAuth();
  refreshView();
  toast('Settings saved');
});

/* ===== Sign in / out buttons ===== */
el('signInBtn').addEventListener('click', signIn);
el('signInBtn2').addEventListener('click', signIn);
el('signOutBtn').addEventListener('click', signOut);

/* =========================================================
 * TECHNICIAN MODE — separate login (username/password) and a
 * restricted view. All reads/writes go through Netlify Functions,
 * which enforce team scope and hold edits for admin approval.
 * ========================================================= */
const FN_BASE = '/.netlify/functions';
const TECH_KEY = 'orderUpdateTechSession';

let techToken = null;
let techSession = null; // { username, team, fullName }
let techCurrentRowNum = null;
let techCurrentOrderId = null;

(function loadTechSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(TECH_KEY));
    if (stored && stored.token) {
      techToken = stored.token;
      techSession = { username: stored.username, team: stored.team, fullName: stored.fullName };
    }
  } catch (e) { /* ignore */ }
})();

async function techApiCall(path, opts = {}) {
  const res = await fetch(FN_BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + techToken,
      ...(opts.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) techSignOut();
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

/* ---- Role tabs on sign-in gate ---- */
el('roleTabAdmin').addEventListener('click', () => {
  el('roleTabAdmin').classList.add('active');
  el('roleTabTech').classList.remove('active');
  el('adminSignInPanel').classList.remove('hidden');
  el('techLoginForm').classList.add('hidden');
});
el('roleTabTech').addEventListener('click', () => {
  el('roleTabTech').classList.add('active');
  el('roleTabAdmin').classList.remove('active');
  el('techLoginForm').classList.remove('hidden');
  el('adminSignInPanel').classList.add('hidden');
});

/* ---- Technician login/logout ---- */
el('techLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = el('techUsername').value.trim();
  const password = el('techPassword').value;
  const status = el('techLoginStatus');
  if (!username || !password) return;
  status.textContent = 'Signing in…';
  status.className = 'status-line loading';
  try {
    const res = await fetch(FN_BASE + '/tech-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Sign-in failed');
    techToken = data.token;
    techSession = { username: data.username, team: data.team, fullName: data.fullName };
    localStorage.setItem(TECH_KEY, JSON.stringify({ token: techToken, ...techSession }));
    status.textContent = '';
    status.className = 'status-line';
    el('techPassword').value = '';
    refreshView();
    loadMyEdits();
    loadTechOrdersByStatus();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'status-line err';
  }
});

function techSignOut() {
  techToken = null;
  techSession = null;
  techCurrentRowNum = null;
  localStorage.removeItem(TECH_KEY);
  refreshView();
}
el('techSignOutBtn').addEventListener('click', techSignOut);

/* ---- My Orders by status ---- */
// Fixed display order for the known statuses (matches the admin status
// dropdown); anything else found in the sheet is grouped as "Other".
const STATUS_LIST = ['Installation Scheduled', 'Problematic', 'Postponed', 'RL Notified', 'SubContractor Assigned', 'Tomorrow', 'Completed', 'Cancelled'];

let techAllOrders = [];   // every order on the tech's team, from the last load
let techOrdersCols = null;
let techKnownStatuses = [];
let techActiveStatusTab = 'Installation Scheduled';

function techOrderStatus(order) {
  const s = (order.row[colToIndex(techOrdersCols.colStatus)] || '').toString().trim();
  return s || 'No Status';
}

async function loadTechOrdersByStatus() {
  const tabsWrap = el('techStatusTabs');
  const list = el('techStatusOrdersList');
  tabsWrap.innerHTML = '<span class="muted small-label">Loading…</span>';
  list.innerHTML = '';
  try {
    const data = await techApiCall('/tech-orders');
    techAllOrders = data.matches || [];
    techOrdersCols = data.cols;
    techKnownStatuses = data.statuses || [];
    techActiveStatusTab = techAllOrders.some((o) => techOrderStatus(o) === 'Installation Scheduled') ? 'Installation Scheduled' : 'All';
    renderTechStatusTabs();
    renderTechStatusOrdersList();
  } catch (err) {
    tabsWrap.innerHTML = '';
    list.innerHTML = `<p class="status-line err">${err.message}</p>`;
  }
}

function renderTechStatusTabs() {
  const tabsWrap = el('techStatusTabs');
  tabsWrap.innerHTML = '';

  if (!techAllOrders.length) {
    tabsWrap.innerHTML = '<span class="muted small-label">No orders found for your team.</span>';
    return;
  }

  const counts = {};
  techAllOrders.forEach((o) => {
    const s = techOrderStatus(o);
    counts[s] = (counts[s] || 0) + 1;
  });
  const knownPresent = STATUS_LIST.filter((s) => counts[s]);
  const otherPresent = Object.keys(counts).filter((s) => !STATUS_LIST.includes(s));
  const tabs = ['All', ...knownPresent, ...otherPresent];

  tabs.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'status-tab' + (s === techActiveStatusTab ? ' active' : '');
    const count = s === 'All' ? techAllOrders.length : counts[s];
    btn.textContent = `${s} (${count})`;
    btn.addEventListener('click', () => {
      techActiveStatusTab = s;
      renderTechStatusTabs();
      renderTechStatusOrdersList();
    });
    tabsWrap.appendChild(btn);
  });
}

function renderTechStatusOrdersList() {
  const list = el('techStatusOrdersList');
  list.innerHTML = '';
  if (!techAllOrders.length) return;

  const filtered = techActiveStatusTab === 'All'
    ? techAllOrders
    : techAllOrders.filter((o) => techOrderStatus(o) === techActiveStatusTab);

  if (!filtered.length) {
    list.innerHTML = '<p class="muted">No orders in this status.</p>';
    return;
  }

  const orderIdx = colToIndex(techOrdersCols.colOrderId);
  filtered.forEach((m) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab-option';
    btn.innerHTML = `
      <span>
        <span class="tab-name">${escapeHtml(m.row[orderIdx] || 'Order')}</span>
        <span class="tab-sub">${escapeHtml(m.row[colToIndex('D')] || '')}</span>
      </span>
      <span class="tab-badge">${m.pending ? 'Pending approval' : escapeHtml(techOrderStatus(m))}</span>
    `;
    btn.addEventListener('click', () => {
      el('techMatchesList').classList.add('hidden');
      el('techSearchStatus').textContent = '';
      populateTechOrderCard(m.rowNum, m.row, techOrdersCols, m.pending);
    });
    list.appendChild(btn);
  });
}

/* ---- Technician search ---- */
el('techSearchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el('techOrderIdInput').value.trim();
  if (!q) return;
  const status = el('techSearchStatus');
  const matchesList = el('techMatchesList');
  status.textContent = 'Searching…';
  status.className = 'status-line loading';
  matchesList.classList.add('hidden');
  matchesList.innerHTML = '';
  el('techOrderCard').classList.add('hidden');

  try {
    const data = await techApiCall('/tech-orders?q=' + encodeURIComponent(q));
    const matches = data.matches || [];
    if (matches.length === 0) {
      status.textContent = 'No matching order found for your team.';
      status.className = 'status-line err';
      return;
    }
    status.textContent = '';
    status.className = 'status-line';
    if (matches.length === 1) {
      populateTechOrderCard(matches[0].rowNum, matches[0].row, data.cols, matches[0].pending);
    } else {
      matches.forEach((m) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tab-option';
        const orderIdx = colToIndex(data.cols.colOrderId);
        btn.innerHTML = `<span class="tab-name">${m.row[orderIdx] || 'Order'}</span>`;
        btn.addEventListener('click', () => {
          matchesList.classList.add('hidden');
          populateTechOrderCard(m.rowNum, m.row, data.cols, m.pending);
        });
        matchesList.appendChild(btn);
      });
      matchesList.classList.remove('hidden');
    }
  } catch (err) {
    status.textContent = err.message;
    status.className = 'status-line err';
  }
});

function populateTechStatusOptions(current) {
  const select = el('techCurrentStatus');
  const options = [...new Set([
    'Installation Scheduled', 'Problematic', 'Postponed', 'RL Notified',
    'SubContractor Assigned', 'Tomorrow', 'Completed', 'Cancelled', current
  ].filter(Boolean))];
  const allOptions = [...new Set([...techKnownStatuses, ...options])];
  select.innerHTML = allOptions.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  select.value = current;
}

function populateTechOrderCard(rowNum, row, cols, hasPending = false) {
  techCurrentRowNum = rowNum;
  const c = (letter) => row[colToIndex(letter)] || '—';
  el('techOrderTeam').textContent = (row[colToIndex('A')] || '—') + '  ·  ' + cols.progressTab;
  el('techOrderName').textContent = c('D');
  el('techMetaOrderId').textContent = c(cols.colOrderId);
  el('techMetaRl').textContent = c('C');
  el('techMetaGsm').textContent = c('E');
  el('techMetaPop').textContent = c('K');
  el('techMetaType').textContent = c('J');
  el('techMetaDate').textContent = c('G');
  el('techStatusPill').textContent = c(cols.colStatus);
  populateTechStatusOptions(c(cols.colStatus) === '—' ? '' : c(cols.colStatus));
  el('techLastUpdate').textContent = row[colToIndex(cols.colDesc)] || 'No previous update';
  el('techDescInput').value = '';
  el('techSubmitBtn').disabled = hasPending;
  el('techSubmitStatus').textContent = hasPending ? 'Previous update is waiting for admin approval.' : '';
  el('techSubmitStatus').className = 'status-line';
  el('techOrderCard').classList.remove('hidden');
  el('techOrderCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

el('techCancelBtn').addEventListener('click', () => {
  el('techOrderCard').classList.add('hidden');
  el('techMatchesList').classList.add('hidden');
  el('techOrderIdInput').value = '';
  el('techOrderIdInput').focus();
});

el('techDescInput').addEventListener('input', () => {
  const input = el('techDescInput');
  input.value = input.value
    .replace(/[^A-Za-z0-9 ]/g, '')
    .replace(/ +/g, ' ')
    .replace(/^ +/, '');
});

el('techEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!techCurrentRowNum) return;
  const btn = el('techSubmitBtn');
  const status = el('techSubmitStatus');
  btn.disabled = true;
  status.textContent = 'Submitting…';
  status.className = 'status-line loading';
  try {
    const updateText = el('techDescInput').value.trim();
    const newStatus = el('techCurrentStatus').value.trim();
    if (!/^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(updateText)) {
      throw new Error('Update may contain only letters, numbers, and single spaces');
    }
    if (!newStatus) throw new Error('Please select a status');
    await techApiCall('/tech-submit-edit', {
      method: 'POST',
      body: JSON.stringify({ rowNum: techCurrentRowNum, newDesc: updateText, newStatus })
    });
    status.textContent = 'Submitted — waiting for admin approval ✓';
    status.className = 'status-line ok';
    toast('Submitted for approval');
    loadMyEdits();
    btn.disabled = true;
  } catch (err) {
    status.textContent = err.message;
    status.className = 'status-line err';
  } finally {
    if (!status.textContent.startsWith('Submitted')) btn.disabled = false;
  }
});

async function loadMyEdits() {
  const list = el('techMyEditsList');
  try {
    const data = await techApiCall('/tech-my-edits');
    list.innerHTML = '';
    if (!data.edits.length) {
      list.innerHTML = '<p class="muted">No submissions yet.</p>';
      return;
    }
    data.edits.forEach((ed) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `
        <div class="list-row-head">
          <span class="list-row-title">${ed.orderId || 'Order'}</span>
          <span class="pill ${ed.status}">${ed.status}</span>
        </div>
        <div class="list-row-sub">${new Date(ed.submittedAt).toLocaleString()}</div>
        <div class="list-row-diff"><span class="old">${escapeHtml(ed.oldDesc)}</span><br><span class="new">${escapeHtml(ed.newDesc)}</span></div>
        ${ed.adminNote ? `<div class="list-row-sub">Note: ${escapeHtml(ed.adminNote)}</div>` : ''}
      `;
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = `<p class="status-line err">${err.message}</p>`;
  }
}

function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* =========================================================
 * ADMIN TOOLS — Technicians + Pending Edits, layered on top of
 * the existing Google sign-in. Uses the admin's own OAuth token
 * as proof of admin identity (same trust model as the rest of
 * the app: anyone with edit access to the sheet is an admin).
 * ========================================================= */
async function adminApiCall(path, opts = {}) {
  const res = await fetch(FN_BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + accessToken,
      ...(opts.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function refreshPendingBadge() {
  if (!accessToken) return;
  try {
    const data = await adminApiCall('/admin-edits');
    const pendingCount = (data.edits || []).filter((ed) => ed.status === 'pending').length;
    const badge = el('pendingBadge');
    badge.textContent = pendingCount;
    badge.classList.toggle('hidden', pendingCount === 0);
  } catch (e) { /* ignore — badge is a nicety, not critical */ }
}

/* ---- Technicians drawer ---- */
const techniciansOverlay = el('techniciansOverlay');
el('techniciansBtn').addEventListener('click', () => {
  techniciansOverlay.classList.remove('hidden');
  loadTechniciansList();
});
el('closeTechnicians').addEventListener('click', () => techniciansOverlay.classList.add('hidden'));
techniciansOverlay.addEventListener('click', (e) => {
  if (e.target === techniciansOverlay) techniciansOverlay.classList.add('hidden');
});

async function loadTechniciansList() {
  const list = el('techniciansList');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await adminApiCall('/admin-technicians');
    list.innerHTML = '';
    if (!data.technicians.length) {
      list.innerHTML = '<p class="muted">No technicians yet.</p>';
      return;
    }
    data.technicians.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `
        <div class="list-row-head">
          <span class="list-row-title">${escapeHtml(t.fullName || t.username)}</span>
          <span class="pill ${t.active ? 'approved' : 'inactive'}">${t.active ? 'active' : 'inactive'}</span>
        </div>
        <div class="list-row-sub">@${escapeHtml(t.username)} · Team: ${escapeHtml(t.team)}</div>
        <div class="field-row tech-edit-fields">
          <div class="field"><label>Username</label><input class="edit-tech-username" value="${escapeHtml(t.username)}"></div>
          <div class="field"><label>Full name</label><input class="edit-tech-name" value="${escapeHtml(t.fullName)}"></div>
        </div>
        <div class="field-row tech-edit-fields">
          <div class="field"><label>Team</label><input class="edit-tech-team" value="${escapeHtml(t.team)}"></div>
          <div class="field"><label>New password</label><input class="edit-tech-password" type="password" placeholder="Leave blank to keep"></div>
        </div>
        <div class="list-row-actions">
          <button type="button" class="btn primary save-tech-btn">Save changes</button>
          <button type="button" class="btn ghost toggle-active-btn">${t.active ? 'Deactivate' : 'Reactivate'}</button>
        </div>
      `;
      row.querySelector('.save-tech-btn').addEventListener('click', async () => {
        try {
          await adminApiCall('/admin-technicians', {
            method: 'PATCH',
            body: JSON.stringify({
              rowNum: t.rowNum,
              username: row.querySelector('.edit-tech-username').value,
              fullName: row.querySelector('.edit-tech-name').value,
              team: row.querySelector('.edit-tech-team').value,
              password: row.querySelector('.edit-tech-password').value
            })
          });
          toast('Technician updated');
          loadTechniciansList();
        } catch (err) { toast(err.message); }
      });
      row.querySelector('.toggle-active-btn').addEventListener('click', async () => {
        try {
          await adminApiCall('/admin-technicians', {
            method: 'PATCH',
            body: JSON.stringify({ rowNum: t.rowNum, active: !t.active })
          });
          loadTechniciansList();
        } catch (err) { toast(err.message); }
      });
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = `<p class="status-line err">${err.message}</p>`;
  }
}

el('addTechForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = el('addTechStatus');
  const payload = {
    username: el('newTechUsername').value.trim(),
    password: el('newTechPassword').value,
    team: el('newTechTeam').value.trim(),
    fullName: el('newTechName').value.trim()
  };
  status.textContent = 'Adding…';
  status.className = 'status-line loading';
  try {
    await adminApiCall('/admin-technicians', { method: 'POST', body: JSON.stringify(payload) });
    status.textContent = 'Technician added ✓';
    status.className = 'status-line ok';
    el('addTechForm').reset();
    loadTechniciansList();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'status-line err';
  }
});

/* ---- Appearance drawer ---- */
const themeOverlay = el('themeOverlay');
el('themeBtn').addEventListener('click', () => {
  themeOverlay.classList.remove('hidden');
  renderThemeFields();
});
el('closeTheme').addEventListener('click', () => themeOverlay.classList.add('hidden'));
themeOverlay.addEventListener('click', (e) => {
  if (e.target === themeOverlay) themeOverlay.classList.add('hidden');
});

function renderThemeFields() {
  const wrap = el('themeFields');
  wrap.innerHTML = '';
  const computed = getComputedStyle(document.documentElement);
  THEME_VARS.forEach((v) => {
    const current = computed.getPropertyValue(v.key).trim() || '#000000';
    const row = document.createElement('div');
    row.className = 'theme-row';
    row.innerHTML = `
      <span class="theme-row-label">${v.label}<span class="theme-row-var">${v.key}</span></span>
      <input type="color" value="${current}">
    `;
    row.querySelector('input').addEventListener('input', (e) => {
      document.documentElement.style.setProperty(v.key, e.target.value);
      saveThemeOverride(v.key, e.target.value);
    });
    wrap.appendChild(row);
  });
}

el('resetThemeBtn').addEventListener('click', () => {
  resetTheme();
  renderThemeFields();
  toast('Appearance reset to default');
});

/* ---- Admin orders dashboard ---- */
const ordersDashboardOverlay = el('ordersDashboardOverlay');
el('ordersDashboardBtn').addEventListener('click', () => {
  ordersDashboardOverlay.classList.remove('hidden');
  loadOrdersDashboard();
});
el('closeOrdersDashboard').addEventListener('click', () => ordersDashboardOverlay.classList.add('hidden'));
ordersDashboardOverlay.addEventListener('click', (e) => {
  if (e.target === ordersDashboardOverlay) ordersDashboardOverlay.classList.add('hidden');
});
el('refreshOrdersDashboard').addEventListener('click', loadOrdersDashboard);

async function loadOrdersDashboard() {
  const box = el('ordersDashboardContent');
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await adminApiCall('/admin-orders');
    const statuses = Object.entries(data.byStatus || {}).sort((a,b) => b[1]-a[1]);
    const teams = Object.entries(data.byTeam || {}).sort((a,b) => b[1]-a[1]);
    const teamStatus = data.byTeamStatus || {};
    box.innerHTML = `
      <div class="dashboard-card"><h3>Total orders</h3><strong>${data.total || 0}</strong></div>
      <div class="dashboard-card"><h3>By status</h3>${statuses.map(([s,n]) => `<div class="dash-row"><span>${escapeHtml(s)}</span><b>${n}</b></div>`).join('')}</div>
      <div class="dashboard-card"><h3>By team</h3>${teams.map(([t,n]) => `<div class="dash-row"><span>${escapeHtml(t)}</span><b>${n}</b></div>`).join('')}</div>
      <div class="dashboard-card"><h3>Team + status</h3>${teams.map(([t]) => `
        <div class="dash-team"><b>${escapeHtml(t)}</b>
          ${Object.entries(teamStatus[t] || {}).sort((a,b)=>b[1]-a[1]).map(([s,n]) => `<div class="dash-row"><span>${escapeHtml(s)}</span><b>${n}</b></div>`).join('')}
        </div>`).join('')}</div>
    `;
  } catch (err) {
    box.innerHTML = `<p class="status-line err">${escapeHtml(err.message)}</p>`;
  }
}

/* ---- Pending edits drawer ---- */
const pendingEditsOverlay = el('pendingEditsOverlay');
el('pendingEditsBtn').addEventListener('click', () => {
  pendingEditsOverlay.classList.remove('hidden');
  loadPendingEditsList();
});
el('closePendingEdits').addEventListener('click', () => pendingEditsOverlay.classList.add('hidden'));
el('refreshPendingEdits').addEventListener('click', loadPendingEditsList);
pendingEditsOverlay.addEventListener('click', (e) => {
  if (e.target === pendingEditsOverlay) pendingEditsOverlay.classList.add('hidden');
});

async function loadPendingEditsList() {
  const list = el('pendingEditsList');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await adminApiCall('/admin-edits');
    list.innerHTML = '';
    if (!data.edits.length) {
      list.innerHTML = '<p class="muted">No edits submitted yet.</p>';
      return;
    }
    data.edits.forEach((ed) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `
        <div class="list-row-head">
          <span class="list-row-title">${escapeHtml(ed.orderId || 'Order')}</span>
          <span class="pill ${ed.status}">${ed.status}</span>
        </div>
        <div class="list-row-sub">${escapeHtml(ed.technician)} · ${new Date(ed.submittedAt).toLocaleString()}</div>
        <div class="list-row-diff">
          <span class="old">Previous: ${escapeHtml(ed.oldDesc)}</span><br>
          <span class="old">Previous status: ${escapeHtml(ed.oldStatus)}</span>
        </div>
        ${ed.status === 'pending' ? `
          <div class="field"><label>Update</label><input class="pending-desc" value="${escapeHtml(ed.newDesc)}"></div>
          <div class="field"><label>Status</label><input class="pending-status" value="${escapeHtml(ed.newStatus)}"></div>
          <div class="list-row-actions">
            <button type="button" class="btn ghost edit-pending-btn">Save edit</button>
            <button type="button" class="btn primary approve-btn">Approve</button>
            <button type="button" class="btn ghost reject-btn">Reject</button>
          </div>` : `
          <div class="list-row-diff">Approved update: ${escapeHtml(ed.newDesc)} · ${escapeHtml(ed.newStatus)}</div>
          <div class="list-row-sub">Resolved by ${escapeHtml(ed.resolvedBy)} · ${ed.resolvedAt ? new Date(ed.resolvedAt).toLocaleString() : ''}</div>`}
      `;
      if (ed.status === 'pending') {
        row.querySelector('.edit-pending-btn').addEventListener('click', async () => {
          try {
            const newDesc = row.querySelector('.pending-desc').value.trim();
            const newStatus = row.querySelector('.pending-status').value.trim();
            if (!/^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(newDesc) || !/^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(newStatus)) {
              throw new Error('Only letters, numbers and single spaces are allowed');
            }
            await adminApiCall('/admin-edits', { method: 'PATCH', body: JSON.stringify({ editId: ed.editId, newDesc, newStatus }) });
            toast('Pending edit changed');
            loadPendingEditsList();
          } catch (err) { toast(err.message); }
        });
        row.querySelector('.approve-btn').addEventListener('click', () => resolveEdit(ed.editId, 'approved'));
        row.querySelector('.reject-btn').addEventListener('click', () => resolveEdit(ed.editId, 'rejected'));
      }
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = `<p class="status-line err">${err.message}</p>`;
  }
}

async function resolveEdit(editId, decision) {
  try {
    await adminApiCall('/admin-edits', {
      method: 'POST',
      body: JSON.stringify({ editId, decision, adminName: adminEmail || 'Admin' })
    });
    toast(decision === 'approved' ? 'Edit approved' : 'Edit rejected');
    loadPendingEditsList();
    refreshPendingBadge();
  } catch (err) {
    toast(err.message);
  }
}

/* ===== Install app banner (Android/desktop: beforeinstallprompt; iOS: manual hint) ===== */
const INSTALL_DISMISSED_KEY = 'orderUpdateInstallDismissed';
let deferredInstallPrompt = null;

function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}

const installBanner = el('installBanner');

// Fires on Android Chrome / desktop Chrome-family browsers when the app is
// installable. Listen at top level (not inside window.load) since this can
// fire before the load event.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (isStandaloneDisplay() || localStorage.getItem(INSTALL_DISMISSED_KEY)) return;
  el('installHintText').textContent = 'Install this app for quick access from your home screen.';
  el('installBtn').classList.remove('hidden');
  installBanner.classList.remove('hidden');
});

el('installBtn').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  installBanner.classList.add('hidden');
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => {});
  deferredInstallPrompt = null;
});

el('dismissInstallBtn').addEventListener('click', () => {
  installBanner.classList.add('hidden');
  localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
});

window.addEventListener('appinstalled', () => {
  installBanner.classList.add('hidden');
  deferredInstallPrompt = null;
});

// iOS Safari has no install prompt API at all — Add to Home Screen is only
// reachable through the Share sheet, so just point people at it.
function maybeShowIOSInstallHint() {
  if (!isIOSDevice() || isStandaloneDisplay() || localStorage.getItem(INSTALL_DISMISSED_KEY)) return;
  el('installBtn').classList.add('hidden');
  el('installHintText').textContent = 'Install this app: tap the Share icon, then "Add to Home Screen".';
  installBanner.classList.remove('hidden');
}

/* ===== Boot ===== */
window.addEventListener('load', () => {
  restoreAdminSession(); // instant — no need to wait for the Google script
  refreshView();
  maybeShowIOSInstallHint();
  if (accessToken) loadKnownStatuses();
  if (techToken) {
    loadMyEdits();
    loadTechOrdersByStatus();
  }
  if (configComplete()) {
    // GIS script loads async; poll briefly until available
    const t = setInterval(() => {
      if (window.google && google.accounts) {
        initAuth();
        clearInterval(t);
        // Don't auto-request a token here. Google Identity Services opens
        // an actual popup window for every requestAccessToken() call —
        // prompt:'' only controls what happens inside that popup, not
        // whether one opens — so doing this on every page load caused a
        // Google popup to flash on every reload. If the cached admin
        // session restored above is still valid we're already signed in;
        // otherwise the normal Sign in button is shown and only opens a
        // popup when the user actually clicks it.
      }
    }, 150);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
});
