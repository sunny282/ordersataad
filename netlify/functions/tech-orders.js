const { verifyTechSession, getBearer, readTab, colToIndex, getSheetConfig, json } = require('./_lib');

// GET /tech-orders?q=02576395
// Technicians only ever see rows in the writable tab whose Team column
// matches their assigned team — never other tabs, never other teams.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const token = getBearer(event);
  const session = token && verifyTechSession(token);
  if (!session) return json(401, { error: 'Session expired — please log in again' });

  // q is optional now: no q (or an empty one) returns every order on the
  // technician's team, so the app can group them into status tabs. A q
  // still filters by order-number substring, same as before.
  const q = ((event.queryStringParameters || {}).q || '').trim().toLowerCase();

  try {
    const cfg = getSheetConfig();
    const rows = await readTab(cfg.progressTab);
    const orderIdx = colToIndex(cfg.colOrderId);
    const teamIdx = colToIndex(cfg.colTeam);

    const pendingRows = await readTab('PendingEdits');
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
      if (team !== session.team.trim().toLowerCase()) continue;
      if (q && !cell.includes(q)) continue;
      matches.push({ rowNum: i + 1, row, pending: pendingByOrder.has(cell) });
    }
    return json(200, { matches, tab: cfg.progressTab, cols: cfg, statuses });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Search failed — try again shortly' });
  }
};
