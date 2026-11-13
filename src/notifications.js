// Emails sent by the system. `ctx` is { db, mailer, publicUrl }. Each person gets
// their own message, so recipients never see each other's addresses.

const fs = require('fs');
const path = require('path');
const { formatEventDates } = require('./divisions');
const { getEventDates } = require('./services');
const { loadSettings } = require('./settings');

const DAY_MS = 24 * 3600000;

// Emails people can turn off on their account page, by kind. Security emails
// (password resets, account changes, club approvals) always go.
const EMAIL_KINDS = {
  decisions: { label: 'Registration and entry decisions', roles: ['coach'] },
  reminders: { label: 'Registration deadline reminders', roles: ['coach'] },
  published: { label: 'Bout lists and poomsae orders published', roles: ['coach'] },
  divisions: { label: 'Athletes moved to another division', roles: ['coach'] },
  news: { label: 'News posts', roles: ['coach'] },
  applications: { label: 'Coach applications to review', roles: ['admin'] },
};

// SQL that drops people who turned off this kind of email (users table aliased u).
const wants = (kind) => `NOT EXISTS (SELECT 1 FROM json_each(u.email_opt_out) WHERE value = '${kind}')`;

function deadlineText(competition) {
  return `${competition.registration_deadline} at ${competition.registration_deadline_time}`;
}

function clubCoachEmails(db, clubId, kind) {
  return db.prepare(`SELECT u.email FROM users u WHERE u.role = 'coach' AND u.club_id = ? AND ${wants(kind)}`).all(clubId).map((u) => u.email);
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
  const admins = db.prepare(`SELECT u.email FROM users u WHERE u.role = 'admin' AND ${wants('applications')}`).all().map((u) => u.email);
  const request = coach.current ? `has asked to move from ${coach.current} to ${club.name}` : `has applied to join ${club.name}`;
  return sendAll(
    ctx,
    admins,
    `Coach application: ${club.name}`,
    `${coach.full_name} (${coach.email}) ${request}.\n\nReview it here: ${ctx.publicUrl}/admin/clubs`
  );
}

// A new sub-admin's invite, with their one-time password. Sent to them alone;
// the password works until they replace it, which the site makes them do first.
function sendAdminInvite(ctx, { email, name, password, invitedBy }) {
  const site = loadSettings(ctx.db).siteName;
  return ctx.mailer.send({
    to: email,
    subject: `You've been made an admin of ${site}`,
    text: `Hello ${name},\n\n${invitedBy} has made you an admin of ${site}.\n\nLog in at ${ctx.publicUrl}/login with:\n\nEmail: ${email}\nOne-time password: ${password}\n\nWhen you log in, you'll be asked to choose your own password straight away. Until you do, the one-time password is the only way in, so don't share this email.\n\nIf you weren't expecting this, ignore it and tell ${invitedBy}.`,
  });
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
      clubCoachEmails(db, clubId, 'decisions'),
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
        clubCoachEmails(ctx.db, clubId, 'decisions'),
        `Poomsae entries ${decision}: ${competition.name}`,
        `These poomsae entries for ${competition.name} were ${decision}:\n\n${lines.join('\n')}\n\nDetails: ${ctx.publicUrl}/club/competitions/${competition.id}/poomsae`
      );
    })
  );
}

// Coaches of clubs with approved poomsae entries, once the lists and brackets are out.
// `what` is the stage published: "performance order" or "brackets".
function notifyPoomsaePublished(ctx, competition, what = 'performance order') {
  const { db } = ctx;
  const clubs = db.prepare("SELECT DISTINCT club_id FROM poomsae_entries WHERE competition_id = ? AND status = 'approved'").all(competition.id);
  return sendAll(
    ctx,
    clubs.flatMap((club) => clubCoachEmails(db, club.club_id, 'published')),
    `Poomsae ${what} published: ${competition.name}`,
    `The poomsae ${what} for ${competition.name} (${formatEventDates(getEventDates(db, competition.id))}) ${what === 'brackets' ? 'are' : 'is'} ready.\n\nSee when your athletes perform: ${ctx.publicUrl}/club/competitions/${competition.id}/poomsae`
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
  const emails = clubs.flatMap((club) => clubCoachEmails(db, club.club_id, 'published'));
  return sendAll(
    ctx,
    emails,
    `Bout list published: ${competition.name}`,
    `The bout list for ${competition.name} (${formatEventDates(getEventDates(db, competition.id))}) is ready.\n\nSee your athletes' bouts, courts and times: ${ctx.publicUrl}/club/competitions/${competition.id}/bouts`
  );
}

// Reminds every approved coach once, when a deadline is within the days set on
// the Settings page (3 unless changed).
async function sendDeadlineReminders(ctx, now = Date.now()) {
  const { db } = ctx;
  const window = loadSettings(db).reminderDays * DAY_MS;
  const open = db.prepare("SELECT * FROM competitions WHERE status = 'open' AND reminder_sent_at IS NULL").all();
  const due = open.filter((c) => {
    const closesAt = new Date(`${c.registration_deadline}T${c.registration_deadline_time}:59`).getTime();
    return closesAt > now && closesAt - now <= window;
  });
  if (due.length === 0) return 0;

  const emails = db.prepare(`SELECT u.email FROM users u WHERE u.role = 'coach' AND u.club_id IS NOT NULL AND ${wants('reminders')}`).all().map((u) => u.email);
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
  const coaches = ctx.db.prepare(`SELECT u.email FROM users u WHERE u.role = 'coach' AND ${wants('news')}`).all().map((u) => u.email);
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
    clubCoachEmails(ctx.db, clubId, 'divisions'),
    `Division change: ${competition.name}`,
    `The organiser moved ${clubMoves.length === 1 ? 'an athlete' : 'athletes'} from your club into another division, so ${clubMoves.length === 1 ? 'they have' : 'they have'} an opponent:\n\n${clubMoves.map((m) => `- ${m.name}: from ${m.from} to ${m.to}`).join('\n')}\n\nSee your entries: ${ctx.publicUrl}/club/competitions/${competition.id}\n`
  )));
}

// Email services cap a message near 10 MB once encoded, so larger backups stay on the server.
const MAX_EMAILED_BACKUP_BYTES = 7 * 1024 * 1024;

// Emails a backup (an entry from listBackups) to the off-site address on the Settings page. Returns
// { sent } or { sent: false, reason }.
async function emailBackup(ctx, dir, backup) {
  const to = loadSettings(ctx.db).offsiteBackupEmail;
  if (!to) return { sent: false, reason: 'No off-site address is set.' };
  if (!ctx.mailer.configured) return { sent: false, reason: 'Email is not set up.' };
  if (backup.size > MAX_EMAILED_BACKUP_BYTES) {
    return { sent: false, reason: `The backup is ${Math.round(backup.size / 1024 / 1024)} MB, over the 7 MB an email can carry. Download it from the Backups page instead.` };
  }
  await ctx.mailer.send({
    to,
    subject: `Database backup ${backup.name}`,
    text: `The attached file is a full backup of the database, made ${backup.createdAt}. It holds everyone's personal data and password hashes, so keep it somewhere safe.\n\nTo restore it, see "Restore a backup" in the README.\n\nThis address was set on ${ctx.publicUrl}/admin/settings.`,
    attachments: [{ filename: backup.name, content: fs.readFileSync(path.join(dir, backup.name)) }],
  });
  return { sent: true };
}

module.exports = {
  sendAdminInvite,
  EMAIL_KINDS,
  MAX_EMAILED_BACKUP_BYTES,
  emailBackup,
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
  notifyPoomsaePublished,
  notifyBoutListPublished,
  sendDeadlineReminders,
};
