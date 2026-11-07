// A permanent record of who did what, for settling disputes. There's deliberately
// no way to edit or delete entries. Never log passwords, tokens or dates of birth.

const ACTIVITY_CATEGORIES = {
  registration: 'Registrations',
  competition: 'Competitions',
  bouts: 'Bout lists',
  result: 'Results',
  club: 'Clubs',
  coach: 'Coaches',
  athlete: 'Athletes',
  document: 'Documents',
  account: 'Accounts',
};

function actorName(user) {
  if (!user) return 'System';
  return user.full_name ? `${user.full_name} (${user.email})` : user.email;
}

function logActivity(db, { user = null, action, summary, competitionId = null }) {
  db.prepare('INSERT INTO activity_log (user_id, actor, action, summary, competition_id) VALUES (?, ?, ?, ?, ?)')
    .run(user ? user.id : null, actorName(user), action, summary, competitionId);
}

function buildFilter({ category, competitionId }) {
  const where = [];
  const params = {};
  if (category && ACTIVITY_CATEGORIES[category]) {
    where.push('action LIKE @category');
    params.category = `${category}.%`;
  }
  if (competitionId) {
    where.push('competition_id = @competitionId');
    params.competitionId = competitionId;
  }
  return { clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
}

function listActivity(db, filter, { limit, offset }) {
  const { clause, params } = buildFilter(filter);
  return db
    .prepare(`SELECT * FROM activity_log ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });
}

function countActivity(db, filter) {
  const { clause, params } = buildFilter(filter);
  return db.prepare(`SELECT COUNT(*) AS n FROM activity_log ${clause}`).get(params).n;
}

// Times are stored in UTC and shown in the server's time zone.
function formatActivityTime(value) {
  return new Date(`${value.replace(' ', 'T')}Z`).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

module.exports = { ACTIVITY_CATEGORIES, logActivity, listActivity, countActivity, formatActivityTime };
