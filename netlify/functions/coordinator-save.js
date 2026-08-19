const {
  verifyCoordinatorSession, getBearer, readTab, colToIndex, updateCell,
  getSheetConfig, json
} = require('./_lib');

// POST { rowNum, newStatus, newDesc }
// Unlike a technician's submission, this writes straight to the sheet —
// coordinators don't need approval, only admins review coordinators'
// access (which teams they can touch). Still re-checks server-side that
// the row belongs to one of the coordinator's teams, so a coordinator
// can't edit an order outside their access even by crafting the request.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const token = getBearer(event);
  const session = token && verifyCoordinatorSession(token);
  if (!session) return json(401, { error: 'Session expired — please log in again' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid request body' });
  }
  const rowNum = parseInt(body.rowNum, 10);
  const newStatus = (body.newStatus || '').toString().trim();
  const newDesc = (body.newDesc || '').toString();
  if (!rowNum || rowNum < 1) return json(400, { error: 'Missing or invalid rowNum' });
  if (!newStatus) return json(400, { error: 'Status is required' });

  try {
    const cfg = getSheetConfig();
    const rows = await readTab(cfg.progressTab);
    const row = rows[rowNum - 1];
    if (!row) return json(404, { error: 'Order row not found' });

    const teamIdx = colToIndex(cfg.colTeam);
    const team = (row[teamIdx] || '').toString().trim().toLowerCase();
    const myTeams = (session.teams || []).map((t) => t.trim().toLowerCase());
    if (!myTeams.includes(team)) {
      return json(403, { error: "This order isn't on one of your teams" });
    }

    await updateCell(cfg.progressTab, `${cfg.colStatus}${rowNum}`, newStatus);
    await updateCell(cfg.progressTab, `${cfg.colDesc}${rowNum}`, newDesc);
    return json(200, { ok: true });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Save failed — try again shortly' });
  }
};
