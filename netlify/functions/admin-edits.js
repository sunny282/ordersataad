const {
  verifyRequester, readTab, updateCell, getSheetConfig,
  PENDING_TAB, json
} = require('./_lib');

// PendingEdits tab columns:
// A edit_id | B order_id | C tab_name | D row_num | E technician | F old_desc
// G new_desc | H submitted_at | I status | J resolved_by | K resolved_at
// L admin_note | M old_status | N new_status | O team
//
// Reachable by admins (unrestricted) and coordinators (scoped to their
// assigned teams — an edit whose team isn't theirs is invisible to them
// and can't be approved/rejected/edited by them, even if they know the
// editId).

exports.handler = async (event) => {
  const requester = await verifyRequester(event);
  if (!requester) return json(401, { error: 'Sign-in required' });

  const myTeams = requester.role === 'coordinator'
    ? requester.teams.map((t) => t.trim().toLowerCase())
    : null;

  try {
    if (event.httpMethod === 'GET') {
      const rows = await readTab(PENDING_TAB);
      let edits = rows.map((r, i) => ({
        sheetRow: i + 1,
        editId: r[0], orderId: r[1], tabName: r[2], rowNum: parseInt(r[3], 10),
        technician: r[4], oldDesc: r[5], newDesc: r[6], submittedAt: r[7],
        status: r[8], resolvedBy: r[9] || '', resolvedAt: r[10] || '', adminNote: r[11] || '',
        oldStatus: r[12] || '', newStatus: r[13] || '', team: r[14] || ''
      }));
      if (myTeams) {
        edits = edits.filter((e) => myTeams.includes((e.team || '').trim().toLowerCase()));
      }
      return json(200, { edits: edits.reverse() });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const editId = body.editId;
      const decision = body.decision; // 'approved' | 'rejected'
      const adminNote = (body.adminNote || '').trim();
      if (!editId || !['approved', 'rejected'].includes(decision)) {
        return json(400, { error: 'Missing or invalid editId/decision' });
      }

      const rows = await readTab(PENDING_TAB);
      const idx = rows.findIndex((r) => r[0] === editId);
      if (idx === -1) return json(404, { error: 'Edit not found' });
      const row = rows[idx];
      const sheetRow = idx + 1;

      if (myTeams && !myTeams.includes((row[14] || '').trim().toLowerCase())) {
        return json(403, { error: "You don't have access to this team's edits" });
      }
      if ((row[8] || '').trim() !== 'pending') {
        return json(409, { error: `This edit was already ${row[8]}` });
      }

      if (decision === 'approved') {
        const cfg = getSheetConfig();
        const tabName = row[2];
        const rowNum = parseInt(row[3], 10);
        const newDesc = row[6];
        const newStatus = row[13] || '';
        await updateCell(tabName, `${cfg.colDesc}${rowNum}`, newDesc);
        if (newStatus) await updateCell(tabName, `${cfg.colStatus}${rowNum}`, newStatus);
      }

      // Resolver identity: admins are trusted to say who they are (their
      // Google email, sent from the client); coordinators are recorded
      // from their verified session, not whatever the client claims.
      const resolvedBy = requester.role === 'coordinator'
        ? (requester.fullName || requester.username)
        : ((body.adminName || '').trim() || 'Admin');

      const resolvedAt = new Date().toISOString();
      await updateCell(PENDING_TAB, `I${sheetRow}`, decision);
      await updateCell(PENDING_TAB, `J${sheetRow}`, resolvedBy);
      await updateCell(PENDING_TAB, `K${sheetRow}`, resolvedAt);
      if (adminNote) await updateCell(PENDING_TAB, `L${sheetRow}`, adminNote);

      return json(200, { ok: true, status: decision });
    }

    if (event.httpMethod === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const editId = body.editId;
      const newDesc = (body.newDesc || '').toString().trim();
      const newStatus = (body.newStatus || '').toString().trim();
      const cleanText = (v) => /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(v);
      if (!editId || !newDesc || !newStatus) return json(400, { error: 'Edit ID, update text and status are required' });
      if (!cleanText(newDesc) || !cleanText(newStatus)) return json(400, { error: 'Only letters, numbers and single spaces are allowed' });

      const rows = await readTab(PENDING_TAB);
      const idx = rows.findIndex((r) => r[0] === editId);
      if (idx === -1) return json(404, { error: 'Edit not found' });
      const row = rows[idx];
      if (myTeams && !myTeams.includes((row[14] || '').trim().toLowerCase())) {
        return json(403, { error: "You don't have access to this team's edits" });
      }
      if ((row[8] || '').trim() !== 'pending') return json(409, { error: 'Only pending edits can be changed' });
      const sheetRow = idx + 1;
      await updateCell(PENDING_TAB, `G${sheetRow}`, newDesc);
      await updateCell(PENDING_TAB, `N${sheetRow}`, newStatus);
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Request failed — try again shortly' });
  }
};
