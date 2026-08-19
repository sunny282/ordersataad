const { verifyAdmin, readTab, appendRow, updateCell, TEAMS_TAB, json } = require('./_lib');

// Teams tab: single column A, one team name per row. Admin-managed only —
// this is the one place team names come from, so technician and
// coordinator accounts always pick from a real, admin-approved list
// instead of free-typing a name that might not match anything.
exports.handler = async (event) => {
  const isAdmin = await verifyAdmin(event);
  if (!isAdmin) return json(401, { error: 'Admin sign-in required' });

  try {
    if (event.httpMethod === 'GET') {
      const rows = await readTab(TEAMS_TAB);
      const teams = rows.map((r) => (r[0] || '').trim()).filter(Boolean);
      return json(200, { teams });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const name = (body.name || '').trim();
      if (!name) return json(400, { error: 'Team name is required' });

      const rows = await readTab(TEAMS_TAB);
      if (rows.some((r) => (r[0] || '').trim().toLowerCase() === name.toLowerCase())) {
        return json(409, { error: 'That team already exists' });
      }
      await appendRow(TEAMS_TAB, [name]);
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const body = JSON.parse(event.body || '{}');
      const name = (body.name || '').trim();
      if (!name) return json(400, { error: 'Team name is required' });

      const rows = await readTab(TEAMS_TAB);
      const idx = rows.findIndex((r) => (r[0] || '').trim().toLowerCase() === name.toLowerCase());
      if (idx === -1) return json(404, { error: 'Team not found' });
      await updateCell(TEAMS_TAB, `A${idx + 1}`, '');
      await updateCell(TEAMS_TAB, `B${idx + 1}`, '');
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Request failed — try again shortly' });
  }
};
