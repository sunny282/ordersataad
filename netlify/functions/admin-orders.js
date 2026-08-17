const { verifyAdmin, readTab, colToIndex, getSheetConfig, json } = require('./_lib');

exports.handler = async (event) => {
  const isAdmin = await verifyAdmin(event);
  if (!isAdmin) return json(401, { error: 'Admin sign-in required' });
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  try {
    const cfg = getSheetConfig();
    const rows = await readTab(cfg.progressTab);
    const teamIdx = colToIndex(cfg.colTeam);
    const statusIdx = colToIndex(cfg.colStatus);
    const orderIdx = colToIndex(cfg.colOrderId);
    const orders = [];
    const byStatus = {};
    const byTeam = {};
    const byTeamStatus = {};
    rows.forEach((row, i) => {
      const orderId = (row[orderIdx] || '').toString().trim();
      if (!orderId) return;
      const status = (row[statusIdx] || '').toString().trim() || 'No Status';
      const team = (row[teamIdx] || '').toString().trim() || 'No Team';
      orders.push({ rowNum: i + 1, orderId, status, team, name: row[3] || '' });
      byStatus[status] = (byStatus[status] || 0) + 1;
      byTeam[team] = (byTeam[team] || 0) + 1;
      byTeamStatus[team] ||= {};
      byTeamStatus[team][status] = (byTeamStatus[team][status] || 0) + 1;
    });
    return json(200, { orders, byStatus, byTeam, byTeamStatus, total: orders.length, tab: cfg.progressTab });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Could not load order dashboard' });
  }
};