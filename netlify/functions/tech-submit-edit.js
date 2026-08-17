const {
  verifyTechSession, getBearer, readTab, appendRow, colToIndex, getSheetConfig,
  PENDING_TAB, json
} = require('./_lib');

// POST { rowNum, newDesc }
// Never writes to the live sheet — always appends a pending row for admin review.
// Re-checks server-side that this row still belongs to the technician's team,
// so a technician can't submit an edit for a row outside their access even by
// crafting the request directly.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const token = getBearer(event);
  const session = token && verifyTechSession(token);
  if (!session) return json(401, { error: 'Session expired — please log in again' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid request body' });
  }
  const rowNum = parseInt(body.rowNum, 10);
  const newDesc = (body.newDesc || '').toString().trim();
  const newStatus = (body.newStatus || '').toString().trim();
  const cleanText = (v) => /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(v);
  if (!rowNum || rowNum < 1) return json(400, { error: 'Missing or invalid rowNum' });
  if (!newDesc) return json(400, { error: 'Update text is required' });
  if (!cleanText(newDesc)) return json(400, { error: 'Update may contain only letters, numbers, and single spaces' });
  if (!newStatus || !cleanText(newStatus)) return json(400, { error: 'Invalid status' });

  try {
    const cfg = getSheetConfig();
    const rows = await readTab(cfg.progressTab);
    const row = rows[rowNum - 1];
    if (!row) return json(404, { error: 'Order row not found' });

    const teamIdx = colToIndex(cfg.colTeam);
    const orderIdx = colToIndex(cfg.colOrderId);
    const descIdx = colToIndex(cfg.colDesc);
    const team = (row[teamIdx] || '').toString().trim().toLowerCase();
    if (team !== session.team.trim().toLowerCase()) {
      return json(403, { error: "This order isn't on your team" });
    }

    const editId = `E${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const oldDesc = row[descIdx] || '';
    const orderId = row[orderIdx] || '';
    const oldStatus = row[colToIndex(cfg.colStatus)] || '';

    // Only one pending update per order at a time.
    const pendingRows = await readTab(PENDING_TAB);
    const hasPending = pendingRows.some((r) =>
      (r[1] || '').toString().trim().toLowerCase() === orderId.toString().trim().toLowerCase() &&
      (r[8] || '').toString().trim().toLowerCase() === 'pending'
    );
    if (hasPending) return json(409, { error: 'This order already has an update waiting for admin approval' });

    const submittedAt = new Date().toISOString();

    // PendingEdits columns:
    // A edit_id B order_id C tab_name D row_num E technician F old_desc
    // G new_desc H submitted_at I status J resolved_by K resolved_at L admin_note
    // M old_status N new_status
    await appendRow(PENDING_TAB, [
      editId, orderId, cfg.progressTab, rowNum, session.username,
      oldDesc, newDesc, submittedAt, 'pending', '', '', '',
      oldStatus, newStatus
    ]);

    return json(200, { ok: true, editId, status: 'pending' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Submit failed — try again shortly' });
  }
};
