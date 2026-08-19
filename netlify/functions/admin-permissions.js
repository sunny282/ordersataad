const {
  verifyAdmin, readTab, appendRow, updateCell, getSheetConfig, colToIndex,
  getStatusConfig, STATUS_PERM_TAB, PROBLEMATIC_STATUS, json
} = require('./_lib');

// Admin-only. StatusPermissions tab is the source of truth for the
// technician sequence + per-status Auto-approve/View-only flags — see
// _lib.js for the row layout and computeTechStatusOptions for how it's
// applied. Nothing here is auto-picked from the sheet's Status column;
// statuses only enter the sequence when an admin adds them here.
exports.handler = async (event) => {
  const isAdmin = await verifyAdmin(event);
  if (!isAdmin) return json(401, { error: 'Admin sign-in required' });

  try {
    if (event.httpMethod === 'GET') {
      const statusConfig = await getStatusConfig();

      // Passive visibility only: statuses currently live in the writable
      // tab's Status column that aren't configured here yet. Shown so the
      // admin can see them and decide whether to add them — never
      // selectable by technicians on their own.
      const cfg = getSheetConfig();
      const rows = await readTab(cfg.progressTab);
      const statusIdx = colToIndex(cfg.colStatus);
      const configuredNames = new Set(statusConfig.list.map((s) => s.name.toLowerCase()));
      const unconfigured = [...new Set(
        rows.map((r) => (r[statusIdx] || '').toString().trim()).filter(Boolean)
      )].filter((s) => !configuredNames.has(s.toLowerCase())).sort((a, b) => a.localeCompare(b));

      return json(200, {
        statuses: statusConfig.list,
        sequence: statusConfig.sequence,
        unconfiguredFromSheet: unconfigured
      });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = body.action;
      const statusConfig = await getStatusConfig();

      if (action === 'addStatus') {
        const name = (body.name || '').trim();
        if (!name) return json(400, { error: 'Status name is required' });
        if (statusConfig.list.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
          return json(409, { error: 'That status already exists' });
        }
        const nextOrder = statusConfig.sequence.length + 1;
        await appendRow(STATUS_PERM_TAB, [name, String(nextOrder), 'FALSE', 'FALSE']);
        return json(200, { ok: true });
      }

      if (action === 'removeFromSequence') {
        const name = (body.name || '').trim();
        const target = statusConfig.list.find((s) => s.name.toLowerCase() === name.toLowerCase());
        if (!target) return json(404, { error: 'Status not found' });
        if (name.toLowerCase() === PROBLEMATIC_STATUS.toLowerCase()) {
          return json(400, { error: 'Problematic can\'t be removed from the sequence' });
        }
        await updateCell(STATUS_PERM_TAB, `B${target.rowNum}`, '');
        // Close the gap so remaining seqOrders stay contiguous.
        const remaining = statusConfig.sequence.filter((s) => s.toLowerCase() !== name.toLowerCase());
        for (let i = 0; i < remaining.length; i++) {
          const row = statusConfig.list.find((s) => s.name === remaining[i]);
          if (row) await updateCell(STATUS_PERM_TAB, `B${row.rowNum}`, String(i + 1));
        }
        return json(200, { ok: true });
      }

      if (action === 'reorder') {
        const order = Array.isArray(body.order) ? body.order.map((s) => (s || '').trim()).filter(Boolean) : [];
        if (!order.length) return json(400, { error: 'A new order is required' });
        for (let i = 0; i < order.length; i++) {
          const row = statusConfig.list.find((s) => s.name.toLowerCase() === order[i].toLowerCase());
          if (row) await updateCell(STATUS_PERM_TAB, `B${row.rowNum}`, String(i + 1));
        }
        return json(200, { ok: true });
      }

      return json(400, { error: 'Unknown action' });
    }

    if (event.httpMethod === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const name = (body.name || '').trim();
      if (!name) return json(400, { error: 'Status name is required' });
      const statusConfig = await getStatusConfig();
      const target = statusConfig.list.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!target) return json(404, { error: 'Status not found' });

      if (typeof body.autoApprove === 'boolean') {
        await updateCell(STATUS_PERM_TAB, `C${target.rowNum}`, body.autoApprove ? 'TRUE' : 'FALSE');
      }
      if (typeof body.viewOnly === 'boolean') {
        await updateCell(STATUS_PERM_TAB, `D${target.rowNum}`, body.viewOnly ? 'TRUE' : 'FALSE');
      }
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Request failed — try again shortly' });
  }
};
