// Emails sent by the system. `ctx` is { db, mailer, publicUrl }. Each person gets
// their own message, so recipients never see each other's addresses.

const { formatEventDates } = require('./divisions');
const { getEventDates } = require('./services');

const REMINDER_WINDOW_MS = 72 * 3600000;

function deadlineText(competition) {
  return `${competition.registration_deadline} at ${competition.registration_deadline_time}`;
}

function clubCoachEmails(db, clubId) {
  return db.prepare("SELECT email FROM users WHERE role = 'coach' AND club_id = ?").all(clubId).map((u) => u.email);
}

function sendAll(ctx, emails, subject, text) {
  return Promise.all(emails.map((to) => ctx.mailer.send({ to, subject, text })));
}

function sendPasswordReset(ctx, email, token) {
  return ctx.mailer.send({
    to: email,
    subject: 'Reset your password',
    text: `Use this link to choose a new password. It works once and expires in 1 hour:\n\n${ctx.publicUrl}/reset-password/${token}\n\nIf you didn't ask for this, you can ignore this email and your password won't change.`,
  });
}

function notifyAdminsOfApplication(ctx, userId, clubId) {
  const { db } = ctx;
  const coach = db
    .prepare('SELECT u.full_name, u.email, c.name AS current FROM users u LEFT JOIN clubs c ON c.id = u.club_id WHERE u.id = ?')
    .get(userId);
  const club = db.prepare('SELECT name FROM clubs WHERE id = ?').get(clubId);
  const admins = db.prepare("SELECT email FROM users WHERE role = 'admin'").all().map((u) => u.email);
  const request = coach.current ? `has asked to move from ${coach.current} to ${club.name}` : `has applied to join ${club.name}`;
  return sendAll(
    ctx,
    admins,
    `Coach application: ${club.name}`,
    `${coach.full_name} (${coach.email}) ${request}.\n\nReview it here: ${ctx.publicUrl}/admin/clubs`
  );
}

// A security notice for changes the account holder should know about.
function notifyAccountChange(ctx, email, what) {
  return ctx.mailer.send({
    to: email,
    subject: 'Your account was changed',
    text: `${what}\n\nIf this wasn't you, reset your password straight away at ${ctx.publicUrl}/forgot-password and contact the organiser.`,
  });
}

function notifyApplicationApproved(ctx, applicationId) {
  const row = ctx.db
    .prepare(
      `SELECT u.email, c.name AS club FROM club_applications a
       JOIN users u ON u.id = a.user_id JOIN clubs c ON c.id = a.club_id WHERE a.id = ?`
    )
    .get(applicationId);
  return ctx.mailer.send({
    to: row.email,
    subject: `You're approved for ${row.club}`,
    text: `An admin approved you as a coach for ${row.club}. You can now register its athletes:\n\n${ctx.publicUrl}/club`,
  });
}

function notifyApplicationRejected(ctx, applicationId, note) {
  const row = ctx.db
    .prepare(
      `SELECT u.email, c.name AS club FROM club_applications a
       JOIN users u ON u.id = a.user_id JOIN clubs c ON c.id = a.club_id WHERE a.id = ?`
    )
    .get(applicationId);
  return ctx.mailer.send({
    to: row.email,
    subject: `Your application to ${row.club} was rejected`,
    text: `An admin rejected your application to join ${row.club}.\n\nReason: ${note}\n\nYou can apply again here: ${ctx.publicUrl}/coach`,
  });
}

function notifyCoachRemoved(ctx, email, clubName) {
  return ctx.mailer.send({
    to: email,
    subject: `You were removed from ${clubName}`,
    text: `An admin removed you as a coach for ${clubName}, so you can no longer register its athletes.\n\nYou can apply to a club here: ${ctx.publicUrl}/coach`,
  });
}

// Sends each club one summary of the decisions in a single review action.
function notifyRegistrationDecisions(ctx, competition, registrationIds, decision) {
  if (registrationIds.length === 0 || decision === 'pending') return Promise.resolve();
  const { db } = ctx;
  const rows = registrationIds.map((id) =>
    db
      .prepare(
        `SELECT r.club_id, r.review_note, f.first_name, f.last_name FROM registrations r
         JOIN fighters f ON f.id = r.fighter_id WHERE r.id = ?`
      )
      .get(id)
  );
  const clubs = new Map();
  rows.forEach((row) => clubs.set(row.club_id, [...(clubs.get(row.club_id) || []), row]));

  const sends = [...clubs.entries()].map(([clubId, list]) => {
    const lines = list.map((r) => `- ${r.first_name} ${r.last_name}${decision === 'rejected' ? `: ${r.review_note}` : ''}`);
    return sendAll(
      ctx,
      clubCoachEmails(db, clubId),
      `Registrations ${decision}: ${competition.name}`,
      `These registrations for ${competition.name} were ${decision}:\n\n${lines.join('\n')}\n\nDetails: ${ctx.publicUrl}/club/competitions/${competition.id}`
    );
  });
  return Promise.all(sends);
}

// The same for poomsae: entries carry club_id, names, event and review_note.
function notifyPoomsaeDecisions(ctx, competition, entries, decision) {
  if (entries.length === 0 || decision === 'pending') return Promise.resolve();
  const clubs = new Map();
  entries.forEach((e) => clubs.set(e.club_id, [...(clubs.get(e.club_id) || []), e]));
  return Promise.all(
    [...clubs.entries()].map(([clubId, list]) => {
      const lines = list.map((e) => `- ${e.names} (${e.event})${decision === 'rejected' ? `: ${e.review_note}` : ''}`);
      return sendAll(
        ctx,
        clubCoachEmails(ctx.db, clubId),
        `Poomsae entries ${decision}: ${competition.name}`,
        `These poomsae entries for ${competition.name} were ${decision}:\n\n${lines.join('\n')}\n\nDetails: ${ctx.publicUrl}/club/competitions/${competition.id}/poomsae`
      );
    })
  );
}

function notifyBoutListPublished(ctx, competition) {
  const { db } = ctx;
  const clubs = db
    .prepare(
      `SELECT DISTINCT r.club_id FROM bouts b
       JOIN registrations r ON r.id IN (b.blue_registration_id, b.red_registration_id)
       WHERE b.competition_id = ? AND b.round = 1`
    )
    .all(competition.id);
  const emails = clubs.flatMap((club) => clubCoachEmails(db, club.club_id));
  return sendAll(
    ctx,
    emails,
    `Bout list published: ${competition.name}`,
    `The bout list for ${competition.name} (${formatEventDates(getEventDates(db, competition.id))}) is ready.\n\nSee your athletes' bouts, courts and times: ${ctx.publicUrl}/club/competitions/${competition.id}/bouts`
  );
}

// Reminds every approved coach once, when a deadline is within 3 days.
async function sendDeadlineReminders(ctx, now = Date.now()) {
  const { db } = ctx;
  const open = db.prepare("SELECT * FROM competitions WHERE status = 'open' AND reminder_sent_at IS NULL").all();
  const due = open.filter((c) => {
    const closesAt = new Date(`${c.registration_deadline}T${c.registration_deadline_time}:59`).getTime();
    return closesAt > now && closesAt - now <= REMINDER_WINDOW_MS;
  });
  if (due.length === 0) return 0;

  const emails = db.prepare("SELECT email FROM users WHERE role = 'coach' AND club_id IS NOT NULL").all().map((u) => u.email);
  await Promise.all(
    due.map((competition) => {
      db.prepare("UPDATE competitions SET reminder_sent_at = datetime('now') WHERE id = ?").run(competition.id);
      return sendAll(
        ctx,
        emails,
        `Registration closes soon: ${competition.name}`,
        `Registration for ${competition.name} closes on ${deadlineText(competition)}.\n\nRegister your athletes here: ${ctx.publicUrl}/club/competitions/${competition.id}`
      );
    })
  );
  return due.length;
}

// A news post, emailed to every coach who asked for it on publishing. Returns how many.
async function notifyNewsPosted(ctx, post) {
  const coaches = ctx.db.prepare("SELECT email FROM users WHERE role = 'coach'").all().map((u) => u.email);
  await sendAll(ctx, coaches, `News: ${post.title}`, `${post.title}\n\n${post.body}\n\nRead it on the site: ${ctx.publicUrl}/news/${post.id}\n`);
  return coaches.length;
}

// Tells each club's coaches which of their athletes moved division, and where to.
// `moves` are { clubId, name, from, to }, with division titles.
function notifyDivisionMerged(ctx, competition, moves) {
  const byClub = new Map();
  moves.forEach((m) => byClub.set(m.clubId, [...(byClub.get(m.clubId) || []), m]));
  return Promise.all([...byClub.entries()].map(([clubId, clubMoves]) => sendAll(
    ctx,
    clubCoachEmails(ctx.db, clubId),
    `Division change: ${competition.name}`,
    `The organiser moved ${clubMoves.length === 1 ? 'an athlete' : 'athletes'} from your club into another division, so ${clubMoves.length === 1 ? 'they have' : 'they have'} an opponent:\n\n${clubMoves.map((m) => `- ${m.name}: from ${m.from} to ${m.to}`).join('\n')}\n\nSee your entries: ${ctx.publicUrl}/club/competitions/${competition.id}\n`
  )));
}

module.exports = {
  notifyNewsPosted,
  notifyDivisionMerged,
  sendPasswordReset,
  notifyAdminsOfApplication,
  notifyAccountChange,
  notifyApplicationApproved,
  notifyApplicationRejected,
  notifyCoachRemoved,
  notifyRegistrationDecisions,
  notifyPoomsaeDecisions,
  notifyBoutListPublished,
  sendDeadlineReminders,
};
