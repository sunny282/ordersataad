const {
  verifyCoordinatorSession, getBearer, readTab, colToIndex, getSheetConfig,
  PENDING_TAB, json
} = require('./_lib');

// GET /coordinator-orders?q=02576395
// Coordinators only ever see rows in the writable tab whose Team column is
// one of their assigned teams — never other teams, never other tabs.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const token = getBearer(event);
  const session = token && verifyCoordinatorSession(token);
  if (!session) return json(401, { error: 'Session expired — please log in again' });

  const q = ((event.queryStringParameters || {}).q || '').trim().toLowerCase();
  const myTeams = (session.teams || []).map((t) => t.trim().toLowerCase());

  try {
    const cfg = getSheetConfig();
    const rows = await readTab(cfg.progressTab);
    const orderIdx = colToIndex(cfg.colOrderId);
    const teamIdx = colToIndex(cfg.colTeam);

    const pendingRows = await readTab(PENDING_TAB);
    const pendingByOrder = new Set(
      pendingRows.filter((r) => (r[8] || '').toString().trim().toLowerCase() === 'pending')
        .map((r) => (r[1] || '').toString().trim().toLowerCase())
    );
    const statuses = [...new Set(rows.map((r) => (r[colToIndex(cfg.colStatus)] || '').toString().trim()).filter(Boolean))];

    const matches = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cell = (row[orderIdx] || '').toString().trim().toLowerCase();
      const team = (row[teamIdx] || '').toString().trim().toLowerCase();
      if (!cell) continue;
      if (!myTeams.includes(team)) continue;
      if (q && !cell.includes(q)) continue;
      matches.push({ rowNum: i + 1, row, pending: pendingByOrder.has(cell) });
    }
    return json(200, { matches, tab: cfg.progressTab, cols: cfg, statuses });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Search failed — try again shortly' });
  }
};
