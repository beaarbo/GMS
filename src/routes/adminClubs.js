// Admin management of clubs and of coach applications to join them.
const express = require('express');
const { createClub, approveApplication, rejectApplication, removeCoach } = require('../services');
const { notifyApplicationApproved, notifyApplicationRejected, notifyCoachRemoved } = require('../notifications');
const { clean, requireRole, notFound } = require('./helpers');
const { COUNTRY_OPTIONS, readCountry } = require('../countries');

const router = express.Router();
router.use(requireRole('admin'));

function readClub(body) {
  const values = { name: clean(body.name), country: readCountry(body.country) };
  const errors = [];
  if (!values.name) errors.push('Enter a club name.');
  return { values, errors };
}

function nameTaken(db, name, exceptId = 0) {
  return Boolean(db.prepare('SELECT 1 FROM clubs WHERE name = ? AND id != ?').get(name, exceptId));
}

router.get('/', (req, res) => {
  const { db } = req.app.locals;
  const coaches = db
    .prepare("SELECT id, full_name, email, phone, club_id FROM users WHERE role = 'coach' AND club_id IS NOT NULL ORDER BY full_name")
    .all();
  res.render('admin/clubs', {
    title: 'Clubs and coaches',
    countries: COUNTRY_OPTIONS,
    applications: db
      .prepare(
        `SELECT a.id, a.created_at, u.full_name, u.email, u.phone, c.name AS club_name,
           (SELECT cur.name FROM clubs cur WHERE cur.id = u.club_id) AS current_club
         FROM club_applications a JOIN users u ON u.id = a.user_id JOIN clubs c ON c.id = a.club_id
         WHERE a.status = 'pending' ORDER BY a.id`
      )
      .all(),
    clubs: db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM fighters f WHERE f.club_id = c.id) AS fighter_count
         FROM clubs c ORDER BY c.name`
      )
      .all()
      .map((club) => ({ ...club, coaches: coaches.filter((coach) => coach.club_id === club.id) })),
  });
});

router.post('/', (req, res) => {
  const { db } = req.app.locals;
  const { values, errors } = readClub(req.body);
  if (nameTaken(db, values.name)) errors.push('A club with this name already exists.');
  if (errors.length > 0) errors.forEach((error) => req.flash('error', error));
  else {
    createClub(db, values);
    req.logActivity('club.created', `Created club ${values.name}${values.country ? ` (${values.country})` : ''}`);
    req.flash('success', `${values.name} created. Coaches can now apply to join it.`);
  }
  return res.redirect('/admin/clubs');
});

router.post('/:id(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const id = Number(req.params.id);
  const club = db.prepare('SELECT * FROM clubs WHERE id = ?').get(id);
  if (!club) return notFound(res);
  const { values, errors } = readClub(req.body);
  if (nameTaken(db, values.name, id)) errors.push('A club with this name already exists.');
  if (errors.length > 0) errors.forEach((error) => req.flash('error', error));
  else {
    db.prepare('UPDATE clubs SET name = ?, country = ? WHERE id = ?').run(values.name, values.country, id);
    req.logActivity('club.updated', `Changed club ${club.name}${club.country ? ` (${club.country})` : ''} to ${values.name}${values.country ? ` (${values.country})` : ''}`);
    req.flash('success', 'Club updated.');
  }
  return res.redirect('/admin/clubs');
});

router.post('/:id(\\d+)/delete', (req, res) => {
  const { db } = req.app.locals;
  const id = Number(req.params.id);
  const inUse =
    db.prepare('SELECT 1 FROM fighters WHERE club_id = ? LIMIT 1').get(id) ||
    db.prepare('SELECT 1 FROM users WHERE club_id = ? LIMIT 1').get(id);
  if (inUse) {
    req.flash('error', 'Only clubs with no coaches or athletes can be deleted.');
  } else {
    const club = db.prepare('SELECT name FROM clubs WHERE id = ?').get(id);
    if (db.prepare('DELETE FROM clubs WHERE id = ?').run(id).changes > 0) {
      req.logActivity('club.deleted', `Deleted club ${club.name}`);
      req.flash('success', 'Club deleted.');
    }
  }
  return res.redirect('/admin/clubs');
});

function applicationText(db, id) {
  const row = db
    .prepare(
      `SELECT u.full_name, u.email, c.name AS club FROM club_applications a
       JOIN users u ON u.id = a.user_id JOIN clubs c ON c.id = a.club_id WHERE a.id = ?`
    )
    .get(id);
  return row ? `${row.full_name} (${row.email}) for ${row.club}` : 'a coach';
}

router.post('/applications/:id(\\d+)/approve', (req, res) => {
  if (approveApplication(req.app.locals.db, Number(req.params.id))) {
    req.logActivity('coach.approved', `Approved ${applicationText(req.app.locals.db, Number(req.params.id))}`);
    req.flash('success', 'Coach approved. They can now register athletes for this club.');
    notifyApplicationApproved(req.app.locals.notify, Number(req.params.id));
  } else {
    req.flash('error', 'That application is no longer waiting for approval.');
  }
  return res.redirect('/admin/clubs');
});

router.post('/applications/:id(\\d+)/reject', (req, res) => {
  const note = clean(req.body.note, 300);
  if (!note) {
    req.flash('error', 'Add a reason when rejecting, so the coach knows what to do next.');
  } else if (rejectApplication(req.app.locals.db, Number(req.params.id), note)) {
    req.logActivity('coach.rejected', `Rejected ${applicationText(req.app.locals.db, Number(req.params.id))}: ${note}`);
    req.flash('success', 'Application rejected.');
    notifyApplicationRejected(req.app.locals.notify, Number(req.params.id), note);
  }
  return res.redirect('/admin/clubs');
});

router.post('/coaches/:id(\\d+)/remove', (req, res) => {
  const { db, notify } = req.app.locals;
  const coach = db
    .prepare('SELECT u.email, c.name AS club FROM users u JOIN clubs c ON c.id = u.club_id WHERE u.id = ?')
    .get(Number(req.params.id));
  if (removeCoach(db, Number(req.params.id))) {
    req.logActivity('coach.removed', `Removed ${coach.email} from ${coach.club}`);
    req.flash('success', "Coach removed. The club's athletes and registrations stay with the club.");
    notifyCoachRemoved(notify, coach.email, coach.club);
  }
  return res.redirect('/admin/clubs');
});

module.exports = router;
