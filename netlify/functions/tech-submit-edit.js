const {
  verifyTechSession, getBearer, readTab, appendRow, updateCell, colToIndex, getSheetConfig,
  getStatusConfig, computeTechStatusOptions, statusCfgFor, PENDING_TAB, json
} = require('./_lib');

// POST { rowNum, newDesc, newStatus }
// A comment is mandatory on every submission — Keep Current Status, next-
// step, and Problematic all require it. The chosen status is never trusted
// from the client: it's re-validated here against computeTechStatusOptions
// for the order's ACTUAL current status read fresh from the sheet, so a
// crafted request can't skip a step, go backward, or write to a view-only
// status. When the destination status is flagged Auto-approve, this writes
// straight to the sheet (still logged as an 'auto-approved' row so it shows
// in history/Pending Edits); otherwise it's held pending like before.
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
  if (!newDesc) return json(400, { error: 'A comment is required' });
  if (!cleanText(newDesc)) return json(400, { error: 'Comment may contain only letters, numbers, and single spaces' });
  if (!newStatus) return json(400, { error: 'Please choose an option' });

  try {
    const cfg = getSheetConfig();
    const rows = await readTab(cfg.progressTab);
    const row = rows[rowNum - 1];
    if (!row) return json(404, { error: 'Order row not found' });

    const teamIdx = colToIndex(cfg.colTeam);
    const orderIdx = colToIndex(cfg.colOrderId);
    const descIdx = colToIndex(cfg.colDesc);
    const statusIdx = colToIndex(cfg.colStatus);
    const team = (row[teamIdx] || '').toString().trim().toLowerCase();
    if (team !== session.team.trim().toLowerCase()) {
      return json(403, { error: "This order isn't on your team" });
    }

    const oldStatus = (row[statusIdx] || '').toString().trim();
    const statusConfig = await getStatusConfig();
    const { viewOnly, options } = computeTechStatusOptions(oldStatus, statusConfig);
    if (viewOnly) {
      return json(403, { error: 'This order is view-only right now — no changes are allowed' });
    }
    const chosen = options.find((o) => o.value.toLowerCase() === newStatus.toLowerCase());
    if (!chosen) {
      return json(403, { error: 'That option is no longer available for this order — reopen it and try again' });
    }

    const editId = `E${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const oldDesc = row[descIdx] || '';
    const orderId = row[orderIdx] || '';

    // Only one pending update per order at a time.
    const pendingRows = await readTab(PENDING_TAB);
    const hasPending = pendingRows.some((r) =>
      (r[1] || '').toString().trim().toLowerCase() === orderId.toString().trim().toLowerCase() &&
      (r[8] || '').toString().trim().toLowerCase() === 'pending'
    );
    if (hasPending) return json(409, { error: 'This order already has an update waiting for admin approval' });

    const submittedAt = new Date().toISOString();
    const destCfg = statusCfgFor(statusConfig, chosen.value);
    const autoApprove = !!(destCfg && destCfg.autoApprove);

    // PendingEdits columns:
    // A edit_id B order_id C tab_name D row_num E technician F old_desc
    // G new_desc H submitted_at I status J resolved_by K resolved_at L admin_note
    // M old_status N new_status O team
    const rowStatus = autoApprove ? 'auto-approved' : 'pending';
    await appendRow(PENDING_TAB, [
      editId, orderId, cfg.progressTab, rowNum, session.username,
      oldDesc, newDesc, submittedAt, rowStatus,
      autoApprove ? 'System' : '', autoApprove ? submittedAt : '', '',
      oldStatus, chosen.value, session.team || ''
    ]);

    if (autoApprove) {
      await updateCell(cfg.progressTab, `${cfg.colDesc}${rowNum}`, newDesc);
      await updateCell(cfg.progressTab, `${cfg.colStatus}${rowNum}`, chosen.value);
    }

    return json(200, { ok: true, editId, status: rowStatus });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Submit failed — try again shortly' });
  }
};
