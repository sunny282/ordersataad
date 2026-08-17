const { verifyTechSession, getBearer, readTab, PENDING_TAB, json } = require('./_lib');

// GET — last 20 edits submitted by the logged-in technician, most recent first.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const token = getBearer(event);
  const session = token && verifyTechSession(token);
  if (!session) return json(401, { error: 'Session expired — please log in again' });

  try {
    const rows = await readTab(PENDING_TAB);
    const mine = rows
      .filter((r) => (r[4] || '').trim().toLowerCase() === session.username.trim().toLowerCase())
      .map((r) => ({
        editId: r[0], orderId: r[1], oldDesc: r[5], newDesc: r[6],
        submittedAt: r[7], status: r[8], adminNote: r[11] || '', oldStatus: r[12] || '', newStatus: r[13] || ''
      }))
      .reverse()
      .slice(0, 20);
    return json(200, { edits: mine });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Could not load your edits' });
  }
};
