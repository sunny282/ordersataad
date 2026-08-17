const { readTab, USERS_TAB, comparePassword, signTechSession, json } = require('./_lib');

// Users tab columns: A username | B password_hash | C team | D full_name | E active | F created_at
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
    const rows = await readTab(USERS_TAB);
    const row = rows.find((r) => (r[0] || '').trim().toLowerCase() === username);
    if (!row) return json(401, { error: 'Invalid username or password' });

    const [, passwordHash, team, fullName, active] = row;
    if ((active || '').toString().trim().toUpperCase() !== 'TRUE') {
      return json(403, { error: 'This account has been deactivated' });
    }

    const ok = await comparePassword(password, passwordHash || '');
    if (!ok) return json(401, { error: 'Invalid username or password' });

    const token = signTechSession({ username, team, fullName, role: 'technician' });
    return json(200, { token, username, team, fullName });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Login failed — try again shortly' });
  }
};
