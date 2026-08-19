const { readTab, comparePassword, signCoordinatorSession, COORDINATORS_TAB, json } = require('./_lib');

// Coordinators tab columns: A username | B password_hash | C teams (comma-
// separated) | D full_name | E active | F created_at
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid request body' });
  }
  const username = (body.username || '').trim().toLowerCase();
  const password = body.password || '';
  if (!username || !password) return json(400, { error: 'Username and password required' });

  try {
    const rows = await readTab(COORDINATORS_TAB);
    const row = rows.find((r) => (r[0] || '').trim().toLowerCase() === username);
    if (!row) return json(401, { error: 'Invalid username or password' });

    const [, passwordHash, teamsCsv, fullName, active] = row;
    if ((active || '').toString().trim().toUpperCase() !== 'TRUE') {
      return json(403, { error: 'This account has been deactivated' });
    }

    const ok = await comparePassword(password, passwordHash || '');
    if (!ok) return json(401, { error: 'Invalid username or password' });

    const teams = (teamsCsv || '').split(',').map((t) => t.trim()).filter(Boolean);
    const token = signCoordinatorSession({ username, teams, fullName, role: 'coordinator' });
    return json(200, { token, username, teams, fullName });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Login failed — try again shortly' });
  }
};
