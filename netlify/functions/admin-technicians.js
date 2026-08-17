const {
  verifyAdmin, readTab, appendRow, updateCell, USERS_TAB, hashPassword, json
} = require('./_lib');

// Users tab columns: A username | B password_hash | C team | D full_name | E active | F created_at
exports.handler = async (event) => {
  const isAdmin = await verifyAdmin(event);
  if (!isAdmin) return json(401, { error: 'Admin sign-in required' });

  try {
    if (event.httpMethod === 'GET') {
      const rows = await readTab(USERS_TAB);
      const technicians = rows.map((r, i) => ({
        rowNum: i + 1,
        username: r[0] || '',
        team: r[2] || '',
        fullName: r[3] || '',
        active: (r[4] || '').toString().trim().toUpperCase() === 'TRUE'
      }));
      return json(200, { technicians });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const username = (body.username || '').trim().toLowerCase();
      const password = body.password || '';
      const team = (body.team || '').trim();
      const fullName = (body.fullName || '').trim();
      if (!username || !password || !team) {
        return json(400, { error: 'Username, password, and team are required' });
      }

      const rows = await readTab(USERS_TAB);
      if (rows.some((r) => (r[0] || '').trim().toLowerCase() === username)) {
        return json(409, { error: 'That username already exists' });
      }

      const hash = await hashPassword(password);
      await appendRow(USERS_TAB, [username, hash, team, fullName, 'TRUE', new Date().toISOString()]);
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const rowNum = parseInt(body.rowNum, 10);
      if (!rowNum) return json(400, { error: 'Missing rowNum' });

      const rows = await readTab(USERS_TAB);
      if (!rows[rowNum - 1]) return json(404, { error: 'Technician not found' });
      const current = rows[rowNum - 1];

      if (body.active !== undefined) {
        await updateCell(USERS_TAB, `E${rowNum}`, !!body.active ? 'TRUE' : 'FALSE');
      }
      if (body.username !== undefined) {
        const username = (body.username || '').trim().toLowerCase();
        if (!username) return json(400, { error: 'Username is required' });
        if (rows.some((r, i) => i !== rowNum - 1 && (r[0] || '').trim().toLowerCase() === username)) {
          return json(409, { error: 'That username already exists' });
        }
        await updateCell(USERS_TAB, `A${rowNum}`, username);
      }
      if (body.team !== undefined) {
        const team = (body.team || '').trim();
        if (!team) return json(400, { error: 'Team is required' });
        await updateCell(USERS_TAB, `C${rowNum}`, team);
      }
      if (body.fullName !== undefined) {
        await updateCell(USERS_TAB, `D${rowNum}`, (body.fullName || '').trim());
      }
      if (body.password !== undefined && body.password !== '') {
        const hash = await hashPassword(body.password);
        await updateCell(USERS_TAB, `B${rowNum}`, hash);
      }
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Request failed — try again shortly' });
  }
};
