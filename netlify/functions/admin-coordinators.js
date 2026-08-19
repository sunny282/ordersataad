const {
  verifyAdmin, readTab, appendRow, updateCell, COORDINATORS_TAB, hashPassword, json
} = require('./_lib');

// Coordinators tab columns: A username | B password_hash | C teams (comma-
// separated) | D full_name | E active | F created_at
// Admin-only, same trust model as admin-technicians.js.
exports.handler = async (event) => {
  const isAdmin = await verifyAdmin(event);
  if (!isAdmin) return json(401, { error: 'Admin sign-in required' });

  try {
    if (event.httpMethod === 'GET') {
      const rows = await readTab(COORDINATORS_TAB);
      const coordinators = rows.map((r, i) => ({
        rowNum: i + 1,
        username: r[0] || '',
        teams: (r[2] || '').split(',').map((t) => t.trim()).filter(Boolean),
        fullName: r[3] || '',
        active: (r[4] || '').toString().trim().toUpperCase() === 'TRUE'
      }));
      return json(200, { coordinators });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const username = (body.username || '').trim().toLowerCase();
      const password = body.password || '';
      const teams = Array.isArray(body.teams) ? body.teams.map((t) => t.trim()).filter(Boolean) : [];
      const fullName = (body.fullName || '').trim();
      if (!username || !password || !teams.length) {
        return json(400, { error: 'Username, password, and at least one team are required' });
      }

      const rows = await readTab(COORDINATORS_TAB);
      if (rows.some((r) => (r[0] || '').trim().toLowerCase() === username)) {
        return json(409, { error: 'That username already exists' });
      }

      const hash = await hashPassword(password);
      await appendRow(COORDINATORS_TAB, [username, hash, teams.join(','), fullName, 'TRUE', new Date().toISOString()]);
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const rowNum = parseInt(body.rowNum, 10);
      if (!rowNum) return json(400, { error: 'Missing rowNum' });

      const rows = await readTab(COORDINATORS_TAB);
      if (!rows[rowNum - 1]) return json(404, { error: 'Coordinator not found' });

      if (body.active !== undefined) {
        await updateCell(COORDINATORS_TAB, `E${rowNum}`, !!body.active ? 'TRUE' : 'FALSE');
      }
      if (body.username !== undefined) {
        const username = (body.username || '').trim().toLowerCase();
        if (!username) return json(400, { error: 'Username is required' });
        if (rows.some((r, i) => i !== rowNum - 1 && (r[0] || '').trim().toLowerCase() === username)) {
          return json(409, { error: 'That username already exists' });
        }
        await updateCell(COORDINATORS_TAB, `A${rowNum}`, username);
      }
      if (body.teams !== undefined) {
        const teams = Array.isArray(body.teams) ? body.teams.map((t) => t.trim()).filter(Boolean) : [];
        if (!teams.length) return json(400, { error: 'At least one team is required' });
        await updateCell(COORDINATORS_TAB, `C${rowNum}`, teams.join(','));
      }
      if (body.fullName !== undefined) {
        await updateCell(COORDINATORS_TAB, `D${rowNum}`, (body.fullName || '').trim());
      }
      if (body.password !== undefined && body.password !== '') {
        const hash = await hashPassword(body.password);
        await updateCell(COORDINATORS_TAB, `B${rowNum}`, hash);
      }
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Request failed — try again shortly' });
  }
};
