const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const Database = require('better-sqlite3');
const { openDb, migrate, initialise } = require('../src/db');
const { createApp } = require('../src/app');
const {
  ensureAdmin,
  createCompetition,
  getEventDates,
  createClub,
  applyToClub,
  approveApplication,
  timeLeft,
  deadlinePassed,
  loadDivisionSetup,
  createPasswordReset,
} = require('../src/services');
const { divisionOptions, findWeightClass } = require('../src/divisions');
const { sendDeadlineReminders } = require('../src/notifications');

const PASSWORD = 'test-password-123';

// Dates are relative so the suite keeps working as years pass.
const EVENT_YEAR = new Date().getFullYear() + 1;
const JUNIOR_DOB = `${EVENT_YEAR - 16}-03-01`;
const TODDLER_DOB = `${EVENT_YEAR - 2}-03-01`;

function capturingMailer() {
  const sent = [];
  return { sent, configured: true, send: async (message) => { sent.push(message); } };
}

// The form field choosing the class a weight falls into, for the latest competition.
function weightField(db, fighterRef, kg) {
  const fighter = db.prepare('SELECT * FROM fighters WHERE id = ?').get(fighterRef.id);
  const competition = db.prepare('SELECT * FROM competitions ORDER BY id DESC').get();
  const options = divisionOptions({ fighter, competition, ...loadDivisionSetup(db, competition.id) });
  return { [`weight_class_${fighter.id}`]: String(findWeightClass(options.classes, kg).id) };
}

async function setup() {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const mailer = capturingMailer();
  const app = createApp({ db, sessionSecret: 'test-secret', mailer, publicUrl: 'https://gms.test' });
  return { db, app, mailer };
}

async function csrfFrom(agent, path) {
  const page = await agent.get(path);
  const match = page.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, `no CSRF token on ${path}`);
  return match[1];
}

async function post(agent, path, fields, formPath) {
  const _csrf = await csrfFrom(agent, formPath);
  return agent.post(path).type('form').send({ _csrf, ...fields });
}

async function login(app, email) {
  const agent = request.agent(app);
  const res = await post(agent, '/login', { email, password: PASSWORD }, '/login');
  assert.equal(res.status, 302);
  return agent;
}

async function signUpCoach(app, email) {
  const agent = request.agent(app);
  const res = await post(agent, '/register', { full_name: 'Coach', phone: '555', email, password: PASSWORD }, '/register');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/coach');
  return agent;
}

// Creates a club plus a coach already approved for it.
async function signUpClub(app, name, email) {
  const { db } = app.locals;
  const clubId = createClub(db, { name, city: 'City' });
  const agent = await signUpCoach(app, email);
  const { id: userId } = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  assert.deepEqual(applyToClub(db, userId, clubId), { ok: true });
  const application = db.prepare("SELECT id FROM club_applications WHERE user_id = ? AND status = 'pending'").get(userId);
  assert.equal(approveApplication(db, application.id), true);
  return agent;
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

async function uploadDocument(agent, fighterId, file, name = 'card.png') {
  const path = `/club/fighters/${fighterId}/document`;
  const _csrf = await csrfFrom(agent, path);
  return agent.post(path).field('_csrf', _csrf).attach('document', file, name);
}

// Adds a fighter through the real forms, including their belt document.
async function addFighter(agent, fields, { withDocument = true } = {}) {
  const res = await post(
    agent,
    '/club/fighters',
    { first_name: 'Ana', last_name: 'Reyes', gender: 'F', date_of_birth: '2010-03-01', belt_rank: '3', ...fields },
    '/club/fighters/new'
  );
  assert.equal(res.status, 302);
  const fighterId = res.headers.location.match(/fighters\/(\d+)\/document/)[1];
  if (withDocument) assert.equal((await uploadDocument(agent, fighterId, TINY_PNG)).status, 302);
  return Number(fighterId);
}

function openCompetition(db, overrides = {}) {
  return createCompetition(db, {
    name: 'Open',
    event_date: `${EVENT_YEAR}-12-01`,
    registration_deadline: `${EVENT_YEAR}-11-01`,
    venue: 'Hall',
    status: 'open',
    ...overrides,
  });
}

test('club registers a fighter, who is placed in a division, and admin approves', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  await addFighter(club, { date_of_birth: JUNIOR_DOB });
  const fighter = db.prepare('SELECT * FROM fighters').get();

  await post(
    club,
    `/club/competitions/${compId}/enter`,
    { fighter_ids: String(fighter.id), ...weightField(db, fighter, 48.5) },
    `/club/competitions/${compId}`
  );

  const reg = db.prepare('SELECT * FROM registrations').get();
  assert.equal(reg.status, 'pending');
  const page = await club.get(`/club/competitions/${compId}`);
  assert.match(page.text, /Female · Junior · Black Belt · -49 kg/);

  const admin = await login(app, 'admin@test.test');
  await post(
    admin,
    `/admin/competitions/${compId}/registrations/review`,
    { single: `approved:${reg.id}` },
    `/admin/competitions/${compId}/registrations`
  );
  assert.equal(db.prepare('SELECT status FROM registrations').get().status, 'approved');

  const divisions = await admin.get(`/admin/competitions/${compId}/divisions`);
  assert.match(divisions.text, /Female · Junior · Black Belt · -49 kg/);
  assert.match(divisions.text, /Reyes, Ana/);

  const csv = await admin.get(`/admin/competitions/${compId}/export.csv`);
  assert.match(csv.text, /"Reyes","Ana","Tigers"/);
});

test('rejecting needs a reason, and a rejected fighter can re-enter', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  await addFighter(club, { date_of_birth: JUNIOR_DOB });
  const fighter = db.prepare('SELECT * FROM fighters').get();
  const enter = () =>
    post(
      club,
      `/club/competitions/${compId}/enter`,
      { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) },
      `/club/competitions/${compId}`
    );
  await enter();
  const reg = db.prepare('SELECT * FROM registrations').get();
  const admin = await login(app, 'admin@test.test');
  const review = `/admin/competitions/${compId}/registrations`;

  await post(admin, `${review}/review`, { single: `rejected:${reg.id}` }, review);
  assert.equal(db.prepare('SELECT status FROM registrations').get().status, 'pending');

  await post(admin, `${review}/review`, { single: `rejected:${reg.id}`, [`note_${reg.id}`]: 'Wrong belt' }, review);
  const rejected = db.prepare('SELECT * FROM registrations').get();
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.review_note, 'Wrong belt');

  await enter();
  const again = db.prepare('SELECT * FROM registrations').all();
  assert.equal(again.length, 1);
  assert.equal(again[0].status, 'pending');
  assert.equal(again[0].review_note, '');
});

test('a fighter cannot be entered twice', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  await addFighter(club, { date_of_birth: JUNIOR_DOB });
  const fighter = db.prepare('SELECT * FROM fighters').get();
  const fields = { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) };
  await post(club, `/club/competitions/${compId}/enter`, fields, `/club/competitions/${compId}`);
  await post(club, `/club/competitions/${compId}/enter`, fields, `/club/competitions/${compId}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, 1);
});

test('clubs cannot touch another club\'s fighters or registrations', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const tigers = await signUpClub(app, 'Tigers', 'tigers@test.test');
  const dragons = await signUpClub(app, 'Dragons', 'dragons@test.test');
  await addFighter(tigers, { date_of_birth: JUNIOR_DOB });
  const fighter = db.prepare('SELECT * FROM fighters').get();
  const form = `/club/competitions/${compId}`;

  const edit = await dragons.get(`/club/fighters/${fighter.id}/edit`);
  assert.equal(edit.status, 404);

  const del = await post(dragons, `/club/fighters/${fighter.id}/delete`, {}, form);
  assert.equal(del.status, 404);
  assert.ok(db.prepare('SELECT 1 FROM fighters WHERE id = ?').get(fighter.id));

  await post(dragons, `/club/competitions/${compId}/enter`, { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) }, form);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, 0);

  await post(tigers, `/club/competitions/${compId}/enter`, { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) }, form);
  const reg = db.prepare('SELECT * FROM registrations').get();
  await post(dragons, `/club/competitions/${compId}/withdraw/${reg.id}`, {}, form);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, 1);
});

test('clubs cannot reach admin pages and visitors must log in', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  assert.equal((await club.get('/admin')).status, 403);
  assert.equal((await club.get(`/admin/competitions/${compId}/registrations`)).status, 403);
  assert.equal((await club.get(`/admin/competitions/${compId}/export.csv`)).status, 403);

  const anonymous = await request(app).get('/club');
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.location, '/login');
});

test('entries are refused after the deadline, when closed, and for drafts', async () => {
  const { db, app } = await setup();
  const past = openCompetition(db, { registration_deadline: '2020-01-01' });
  const closed = openCompetition(db, { status: 'closed' });
  const draft = openCompetition(db, { status: 'draft' });
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  await addFighter(club, { date_of_birth: JUNIOR_DOB });
  const fighter = db.prepare('SELECT * FROM fighters').get();
  const fields = { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) };

  await post(club, `/club/competitions/${past}/enter`, fields, `/club/competitions/${past}`);
  await post(club, `/club/competitions/${closed}/enter`, fields, `/club/competitions/${closed}`);
  const draftAttempt = await post(club, `/club/competitions/${draft}/enter`, fields, '/club');
  assert.equal(draftAttempt.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, 0);
});

test('coaches choose a weight class, limited to the fighter\'s age group and gender', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  await addFighter(club, { date_of_birth: JUNIOR_DOB });
  await addFighter(club, { first_name: 'Tot', date_of_birth: TODDLER_DOB });
  const [teen, toddler] = db.prepare('SELECT * FROM fighters ORDER BY id').all();
  const form = `/club/competitions/${compId}`;
  const enter = (fighter, classId) => post(club, `/club/competitions/${compId}/enter`, { fighter_ids: String(fighter.id), [`weight_class_${fighter.id}`]: String(classId) }, form);
  const classId = (gender, ageGroup, label) => db.prepare(
    `SELECT w.id FROM weight_classes w JOIN age_groups a ON a.id = w.age_group_id
     WHERE w.competition_id = ? AND w.gender = ? AND a.name = ? AND w.label = ?`
  ).get(compId, gender, ageGroup, label).id;
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n;

  const page = await club.get(form);
  assert.match(page.text, /-42 kg/, 'female junior classes are offered');
  assert.match(page.text, /No age group for age 2/);

  await post(club, `/club/competitions/${compId}/enter`, { fighter_ids: String(teen.id) }, form);
  assert.match((await club.get(form)).text, /Select a weight class/);
  await enter(teen, classId('M', 'Junior', '-45 kg'));
  await enter(teen, classId('F', 'Cadet', '-29 kg'));
  await enter(teen, 999999);
  assert.equal(count(), 0, 'classes from another gender or age group are refused');

  await enter(toddler, classId('F', 'Junior', '-42 kg'));
  assert.equal(count(), 0);

  await enter(teen, classId('F', 'Junior', '-49 kg'));
  assert.match((await club.get(form)).text, /Female · Junior · Black Belt · -49 kg/);
  const reg = db.prepare('SELECT * FROM registrations').get();
  assert.equal(reg.weight_class_id, classId('F', 'Junior', '-49 kg'));
  assert.ok(!('declared_weight_kg' in reg));
});

test('a fighter with an active registration cannot be edited', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  await addFighter(club, { date_of_birth: JUNIOR_DOB });
  const fighter = db.prepare('SELECT * FROM fighters').get();
  const form = `/club/competitions/${compId}`;
  await post(club, `${form}/enter`, { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) }, form);

  await post(
    club,
    `/club/fighters/${fighter.id}`,
    { first_name: 'Changed', last_name: 'Reyes', gender: 'M', date_of_birth: JUNIOR_DOB, belt_rank: '1' },
    form
  );
  assert.equal(db.prepare('SELECT gender FROM fighters').get().gender, 'F');
});

test('division setup locks once registrations exist', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const admin = await login(app, 'admin@test.test');
  const setupPath = `/admin/competitions/${compId}/setup`;
  const fields = {
    age_name: 'Only', age_min: '5', age_max: '99', age_male: '-50,+50', age_female: '-50,+50',
    belt_name: 'All', belt_min: '1', belt_max: '9',
  };
  await post(admin, setupPath, fields, setupPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM age_groups WHERE competition_id = ?').get(compId).n, 1);

  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  await addFighter(club, { date_of_birth: JUNIOR_DOB });
  const fighter = db.prepare('SELECT * FROM fighters').get();
  const form = `/club/competitions/${compId}`;
  await post(club, `${form}/enter`, { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) }, form);

  await post(admin, setupPath, { ...fields, age_name: 'Changed' }, setupPath);
  assert.equal(db.prepare('SELECT name FROM age_groups WHERE competition_id = ?').get(compId).name, 'Only');
});

test('in production, login works behind an HTTPS proxy with a Secure cookie', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', production: true });

  const plain = await request(app).get('/login');
  assert.equal(plain.headers['set-cookie'], undefined);

  const page = await request(app).get('/login').set('X-Forwarded-Proto', 'https');
  const [cookie] = page.headers['set-cookie'];
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];

  const res = await request(app)
    .post('/login')
    .set('X-Forwarded-Proto', 'https')
    .set('Cookie', cookie.split(';')[0])
    .type('form')
    .send({ _csrf, email: 'admin@test.test', password: PASSWORD });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin');
});

async function closedCompetitionWithFighters(db, app, fighters) {
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  const other = await signUpClub(app, 'Dragons', 'dragons@test.test');
  const form = `/club/competitions/${compId}`;
  for (const [agent, lastName] of fighters.map(([c, n]) => [c === 'T' ? club : other, n])) {
    await addFighter(agent, { last_name: lastName, date_of_birth: JUNIOR_DOB });
    const fighter = db.prepare('SELECT id FROM fighters ORDER BY id DESC').get();
    await post(agent, `${form}/enter`, { fighter_ids: String(fighter.id), ...weightField(db, fighter, 48) }, form);
  }
  db.prepare("UPDATE registrations SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(compId);
  const admin = await login(app, 'admin@test.test');
  return { compId, admin, club };
}

test('the bout list is only generated after registration closes', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const admin = await login(app, 'admin@test.test');
  const path = `/admin/competitions/${compId}/bouts`;
  await post(admin, `${path}/generate`, {}, '/admin');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bouts').get().n, 0);
  assert.equal((await admin.get(`${path}.pdf`)).status, 302);
});

test('generating draws approved fighters only and separates club-mates', async () => {
  const { db, app } = await setup();
  const { compId, admin } = await closedCompetitionWithFighters(db, app, [
    ['T', 'Alpha'], ['T', 'Bravo'], ['D', 'Charlie'], ['D', 'Delta'], ['D', 'Excluded'],
  ]);
  db.prepare(
    "UPDATE registrations SET status = 'pending' WHERE fighter_id = (SELECT id FROM fighters WHERE last_name = 'Excluded')"
  ).run();

  const path = `/admin/competitions/${compId}/bouts`;
  await post(admin, `${path}/generate`, {}, path);
  const page = await admin.get(path);
  assert.match(page.text, /Alpha/);
  assert.ok(!page.text.includes('Excluded'));
  assert.match(page.text, /<svg class="bracket"/);
  assert.match(page.text, /KYORUGI BLACK BELT, Junior \d{4}-\d{4}, Female, -49 kg/);

  const firstRound = db.prepare('SELECT * FROM bouts WHERE round = 1 ORDER BY position').all();
  assert.equal(firstRound.length, 2);
  const clubOf = (regId) => db.prepare('SELECT club_id FROM registrations WHERE id = ?').get(regId).club_id;
  firstRound.forEach((bout) => {
    assert.notEqual(clubOf(bout.blue_registration_id), clubOf(bout.red_registration_id));
  });
  assert.deepEqual(db.prepare('SELECT bout_number FROM bouts ORDER BY bout_number').all().map((b) => b.bout_number), [1, 2, 3]);
});

test('a bout list blocks approval changes and reopening until deleted', async () => {
  const { db, app } = await setup();
  const { compId, admin } = await closedCompetitionWithFighters(db, app, [['T', 'Alpha'], ['D', 'Bravo']]);
  const path = `/admin/competitions/${compId}/bouts`;
  const review = `/admin/competitions/${compId}/registrations`;
  await post(admin, `${path}/generate`, {}, path);
  const reg = db.prepare('SELECT id FROM registrations').get();

  await post(admin, `${review}/review`, { single: `rejected:${reg.id}`, [`note_${reg.id}`]: 'No' }, review);
  assert.equal(db.prepare('SELECT status FROM registrations WHERE id = ?').get(reg.id).status, 'approved');

  await post(admin, `/admin/competitions/${compId}/status`, { status: 'open' }, path);
  assert.equal(db.prepare('SELECT status FROM competitions WHERE id = ?').get(compId).status, 'closed');

  await post(admin, `${path}/delete`, {}, path);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bouts').get().n, 0);
  await post(admin, `${review}/review`, { single: `rejected:${reg.id}`, [`note_${reg.id}`]: 'No' }, review);
  assert.equal(db.prepare('SELECT status FROM registrations WHERE id = ?').get(reg.id).status, 'rejected');
});

test('the bout list downloads as a PDF for admins only', async () => {
  const { db, app } = await setup();
  const { compId, admin, club } = await closedCompetitionWithFighters(db, app, [['T', 'Alpha'], ['D', 'Bravo']]);
  const path = `/admin/competitions/${compId}/bouts`;
  await post(admin, `${path}/generate`, {}, path);

  const pdf = await admin
    .get(`${path}.pdf`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.match(pdf.headers['content-disposition'], /attachment; filename="bout-list-competition-\d+\.pdf"/);
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  assert.equal((pdf.body.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1, 'one page per division');

  assert.equal((await club.get(path)).status, 403);
  assert.equal((await club.get(`${path}.pdf`)).status, 403);
});

test('schedule settings set courts and times without changing the draw', async () => {
  const { db, app } = await setup();
  const { compId, admin } = await closedCompetitionWithFighters(db, app, [
    ['T', 'Alpha'], ['T', 'Bravo'], ['D', 'Charlie'], ['D', 'Delta'],
  ]);
  const path = `/admin/competitions/${compId}/bouts`;
  await post(admin, `${path}/generate`, { courts: '1', days: '1', start: '10:30', minutes: '15' }, path);

  const pairs = () => db.prepare('SELECT blue_registration_id, red_registration_id FROM bouts ORDER BY id').all();
  const before = pairs();
  assert.deepEqual(
    db.prepare('SELECT start_time FROM bouts WHERE is_bye = 0 ORDER BY bout_number').all().map((b) => b.start_time),
    ['10:30', '10:45', '11:00']
  );

  await post(admin, `${path}/schedule`, { courts: '1', days: '1', start: '08:00', minutes: '20' }, path);
  assert.deepEqual(pairs(), before);
  assert.deepEqual(
    db.prepare('SELECT start_time FROM bouts WHERE is_bye = 0 ORDER BY bout_number').all().map((b) => b.start_time),
    ['08:00', '08:20', '08:40']
  );

  await post(admin, `${path}/schedule`, { courts: '0', days: '1', start: '25:00', minutes: '20' }, path);
  assert.equal(db.prepare('SELECT bout_start FROM competitions WHERE id = ?').get(compId).bout_start, '08:00');
});

test('schedule migration clears old draws and keeps competitions', () => {
  const db = openDb(':memory:');
  const compId = createCompetition(db, {
    name: 'Old', event_date: '2030-01-01', registration_deadline: '2029-01-01', venue: 'Hall',
  });
  const [age] = db.prepare('SELECT id FROM age_groups').all();
  const [belt] = db.prepare('SELECT id FROM belt_groups').all();
  const [weight] = db.prepare('SELECT id FROM weight_classes').all();
  db.prepare(
    `INSERT INTO bouts (competition_id, gender, age_group_id, belt_group_id, weight_class_id, round, total_rounds, position)
     VALUES (?, 'M', ?, ?, ?, 1, 1, 0)`
  ).run(compId, age.id, belt.id, weight.id);
  db.pragma('user_version = 1');

  migrate(db);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bouts').get().n, 0);
  assert.equal(db.prepare('SELECT bout_courts FROM competitions WHERE id = ?').get(compId).bout_courts, 2);
  assert.equal(db.pragma('user_version', { simple: true }), 5);
});

test('admin creates a club, a coach applies, and only approval unlocks athlete registration', async () => {
  const { db, app } = await setup();
  const admin = await login(app, 'admin@test.test');
  await post(admin, '/admin/clubs', { name: 'Tigers', city: 'Manila' }, '/admin/clubs');
  const club = db.prepare("SELECT id FROM clubs WHERE name = 'Tigers'").get();
  assert.ok(club);

  const coach = await signUpCoach(app, 'coach@test.test');
  assert.equal((await coach.get('/club')).headers.location, '/coach');

  await post(coach, '/coach/apply', { club_id: String(club.id) }, '/coach');
  assert.match((await coach.get('/coach')).text, /Waiting for approval/);
  assert.equal((await coach.get('/club')).headers.location, '/coach', 'pending coaches stay locked out');
  assert.equal(db.prepare('SELECT club_id FROM users WHERE email = ?').get('coach@test.test').club_id, null);

  const application = db.prepare('SELECT id FROM club_applications').get();
  assert.match((await admin.get('/admin/clubs')).text, /coach@test\.test/);
  await post(admin, `/admin/clubs/applications/${application.id}/approve`, {}, '/admin/clubs');

  assert.equal((await coach.get('/club')).status, 200);
  await addFighter(coach, { date_of_birth: JUNIOR_DOB });
  assert.equal(db.prepare('SELECT club_id FROM fighters').get().club_id, club.id);
});

test('a rejected coach sees why and can apply again', async () => {
  const { db, app } = await setup();
  const clubId = createClub(db, { name: 'Tigers', city: 'Manila' });
  const admin = await login(app, 'admin@test.test');
  const coach = await signUpCoach(app, 'coach@test.test');
  await post(coach, '/coach/apply', { club_id: String(clubId) }, '/coach');
  const { id } = db.prepare('SELECT id FROM club_applications').get();

  await post(admin, `/admin/clubs/applications/${id}/reject`, {}, '/admin/clubs');
  assert.equal(db.prepare('SELECT status FROM club_applications').get().status, 'pending', 'a reason is required');

  await post(admin, `/admin/clubs/applications/${id}/reject`, { note: 'Not on our staff list' }, '/admin/clubs');
  assert.match((await coach.get('/coach')).text, /Not on our staff list/);
  assert.equal((await coach.get('/club')).status, 302);

  await post(coach, '/coach/apply', { club_id: String(clubId) }, '/coach');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM club_applications WHERE status = 'pending'").get().n, 1);
});

test('a coach has one open application and cannot create clubs or approve themselves', async () => {
  const { db, app } = await setup();
  const clubId = createClub(db, { name: 'Tigers', city: 'Manila' });
  const coach = await signUpCoach(app, 'coach@test.test');
  await post(coach, '/coach/apply', { club_id: String(clubId) }, '/coach');
  await post(coach, '/coach/apply', { club_id: String(clubId) }, '/coach');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM club_applications').get().n, 1);

  const { id } = db.prepare('SELECT id FROM club_applications').get();
  assert.equal((await post(coach, `/admin/clubs/applications/${id}/approve`, {}, '/coach')).status, 403);
  assert.equal((await post(coach, '/admin/clubs', { name: 'Mine', city: 'X' }, '/coach')).status, 403);
  assert.equal((await coach.get('/admin/clubs')).status, 403);
  assert.equal(db.prepare('SELECT club_id FROM users WHERE email = ?').get('coach@test.test').club_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clubs').get().n, 1);
});

test('removing a coach locks them out but the club keeps its fighters', async () => {
  const { db, app } = await setup();
  const coach = await signUpClub(app, 'Tigers', 'coach@test.test');
  await addFighter(coach, { date_of_birth: JUNIOR_DOB });
  const admin = await login(app, 'admin@test.test');
  const { id } = db.prepare('SELECT id FROM users WHERE email = ?').get('coach@test.test');

  const clubId = db.prepare('SELECT id FROM clubs').get().id;
  await post(admin, `/admin/clubs/${clubId}/delete`, {}, '/admin/clubs');
  assert.ok(db.prepare('SELECT 1 FROM clubs WHERE id = ?').get(clubId), 'clubs in use are not deleted');

  await post(admin, `/admin/clubs/coaches/${id}/remove`, {}, '/admin/clubs');
  assert.equal((await coach.get('/club')).headers.location, '/coach');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fighters').get().n, 1);
});

test('registration closes by itself when the date and time pass', async () => {
  const { db, app } = await setup();
  const now = new Date();
  const todayText = now.toLocaleDateString('en-CA');
  const earlier = openCompetition(db, { registration_deadline: todayText, registration_deadline_time: '00:00' });
  const later = openCompetition(db);
  // Only a run in the first minute after midnight could see this as still open.
  await request(app).get('/');
  const status = (id) => db.prepare('SELECT status FROM competitions WHERE id = ?').get(id).status;
  if (now.getHours() !== 0 || now.getMinutes() !== 0) assert.equal(status(earlier), 'closed');
  assert.equal(status(later), 'open');
});

test('a passed deadline blocks reopening until the admin sets a later one', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db, { registration_deadline: '2020-01-01', event_date: `${EVENT_YEAR}-12-01` });
  const admin = await login(app, 'admin@test.test');
  const status = () => db.prepare('SELECT status FROM competitions WHERE id = ?').get(compId).status;
  assert.equal(status(), 'closed');

  await post(admin, `/admin/competitions/${compId}/status`, { status: 'open' }, '/admin');
  assert.equal(status(), 'closed');

  await post(
    admin,
    `/admin/competitions/${compId}`,
    {
      name: 'Open', venue: 'Hall', event_dates: `${EVENT_YEAR}-12-01`,
      registration_deadline: `${EVENT_YEAR}-11-01`, registration_deadline_time: '17:30',
    },
    `/admin/competitions/${compId}/edit`
  );
  await post(admin, `/admin/competitions/${compId}/status`, { status: 'open' }, '/admin');
  assert.equal(status(), 'open');
  assert.match((await request(app).get('/')).text, /17:30/);
});

test('deadline helpers report what is left', () => {
  const at = (ms) => {
    const d = new Date(Date.now() + ms);
    const pad = (n) => String(n).padStart(2, '0');
    return {
      registration_deadline: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      registration_deadline_time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  };
  const hour = 3600000;
  assert.equal(timeLeft(at(5 * 24 * hour)), '5 days left');
  assert.equal(timeLeft(at(5 * hour)), '5 hours left');
  assert.equal(timeLeft(at(10 * 60000)), 'Closing soon');
  assert.equal(deadlinePassed(at(hour)), false);
  assert.equal(deadlinePassed(at(-2 * 60000)), true);
});

test('migrating old club accounts keeps logins and fighters and approves each coach', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE clubs (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, coach_name TEXT NOT NULL,
      phone TEXT NOT NULL, city TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'club')), club_id INTEGER REFERENCES clubs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO clubs (id, name, coach_name, phone, city) VALUES (1, 'Tigers', 'Coach Ana', '555', 'Manila');
    INSERT INTO users (id, email, password_hash, role, club_id) VALUES (1, 'a@test.test', 'hash1', 'admin', NULL);
    INSERT INTO users (id, email, password_hash, role, club_id) VALUES (2, 'c@test.test', 'hash2', 'club', 1);
  `);
  db.pragma('user_version = 2');

  initialise(db);

  const coach = db.prepare('SELECT * FROM users WHERE id = 2').get();
  assert.equal(coach.role, 'coach');
  assert.equal(coach.full_name, 'Coach Ana');
  assert.equal(coach.phone, '555');
  assert.equal(coach.password_hash, 'hash2');
  assert.equal(coach.club_id, 1);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = 1').get().role, 'admin');
  const application = db.prepare('SELECT * FROM club_applications').all();
  assert.equal(application.length, 1);
  assert.equal(application[0].status, 'approved');
  const clubColumns = db.pragma('table_info(clubs)').map((c) => c.name);
  assert.ok(!clubColumns.includes('coach_name'));
  assert.equal(db.pragma('foreign_key_check').length, 0);
  assert.equal(db.pragma('user_version', { simple: true }), 5);
});

test('a fighter alone in a division has no bout number', async () => {
  const { db, app } = await setup();
  const { compId, admin } = await closedCompetitionWithFighters(db, app, [['T', 'Alpha']]);
  const path = `/admin/competitions/${compId}/bouts`;
  await post(admin, `${path}/generate`, {}, path);
  const [row] = db.prepare('SELECT * FROM bouts').all();
  assert.equal(row.bout_number, null);
  assert.match((await admin.get(path)).text, /No opponent/);
});

test('the belt migration converts old ranks and moves registrations', () => {
  const db = openDb(':memory:');
  db.pragma('user_version = 0');
  const compId = db
    .prepare("INSERT INTO competitions (name, event_date, registration_deadline, venue) VALUES ('Old', '2030-01-01', '2029-01-01', 'Hall')")
    .run().lastInsertRowid;
  const age = db.prepare("INSERT INTO age_groups (competition_id, name, min_age, max_age) VALUES (?, 'A', 1, 99)").run(compId).lastInsertRowid;
  const weight = db.prepare("INSERT INTO weight_classes (competition_id, age_group_id, gender, label, max_kg) VALUES (?, ?, 'F', '+1 kg', NULL)").run(compId, age).lastInsertRowid;
  const oldBelt = db.prepare("INSERT INTO belt_groups (competition_id, name, min_rank, max_rank) VALUES (?, 'Old group', 1, 9)").run(compId).lastInsertRowid;
  const club = db.prepare("INSERT INTO clubs (name, city) VALUES ('C', 'C')").run().lastInsertRowid;

  const addOld = (name, rank) => {
    const fighter = db
      .prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, 'X', 'F', '2010-01-01', ?)")
      .run(club, name, rank).lastInsertRowid;
    db.prepare(
      `INSERT INTO registrations (competition_id, fighter_id, club_id, age_at_event, age_group_id, belt_group_id, weight_class_id)
       VALUES (?, ?, ?, 20, ?, ?, ?)`
    ).run(compId, fighter, club, age, oldBelt, weight);
  };
  [['White', 1], ['Blue', 5], ['Purple', 6], ['Red', 8], ['Black', 9]].forEach(([n, r]) => addOld(n, r));

  migrate(db);

  const placed = db
    .prepare(
      `SELECT f.first_name AS name, f.belt_rank AS rank, b.name AS grp FROM registrations r
       JOIN fighters f ON f.id = r.fighter_id JOIN belt_groups b ON b.id = r.belt_group_id ORDER BY f.id`
    )
    .all();
  assert.deepEqual(placed, [
    { name: 'White', rank: 1, grp: 'Blue Belt' },
    { name: 'Blue', rank: 1, grp: 'Blue Belt' },
    { name: 'Purple', rank: 2, grp: 'Red Belt' },
    { name: 'Red', rank: 2, grp: 'Red Belt' },
    { name: 'Black', rank: 3, grp: 'Black Belt' },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM belt_groups WHERE competition_id = ?').get(compId).n, 3);

  // Running again must not convert anything a second time.
  migrate(db);
  assert.equal(db.prepare("SELECT belt_rank FROM fighters WHERE first_name = 'Black'").get().belt_rank, 3);
});

test('a competition can run over two separate weekends', async () => {
  const { db, app } = await setup();
  const admin = await login(app, 'admin@test.test');
  const y = EVENT_YEAR;
  await post(
    admin,
    '/admin/competitions',
    {
      name: 'Two Weekends', venue: 'Hall', status: 'draft',
      // Out of order, with a duplicate and a blank box, as a form could send them.
      event_dates: [`${y}-02-13`, `${y}-02-06`, `${y}-02-07`, `${y}-02-14`, `${y}-02-07`, ''],
      registration_deadline: `${y}-01-20`, registration_deadline_time: '17:00',
    },
    '/admin/competitions/new'
  );
  const competition = db.prepare("SELECT * FROM competitions WHERE name = 'Two Weekends'").get();
  assert.equal(competition.event_date, `${y}-02-06`);
  assert.deepEqual(getEventDates(db, competition.id), [`${y}-02-06`, `${y}-02-07`, `${y}-02-13`, `${y}-02-14`]);

  await post(admin, `/admin/competitions/${competition.id}/status`, { status: 'open' }, '/admin');
  assert.match((await request(app).get('/')).text, new RegExp(`6-7 &amp; 13-14 Feb ${y}`));
  assert.match((await request(app).get(`/competitions/${competition.id}`)).text, new RegExp(`6-7 &amp; 13-14 Feb ${y}`));
});

test('event date validation needs one valid date, before which the deadline falls', async () => {
  const { db, app } = await setup();
  const admin = await login(app, 'admin@test.test');
  const y = EVENT_YEAR;
  const base = { name: 'Bad', venue: 'Hall', registration_deadline: `${y}-01-01`, registration_deadline_time: '17:00' };
  const form = '/admin/competitions/new';
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM competitions').get().n;

  assert.equal((await post(admin, '/admin/competitions', { ...base, event_dates: '' }, form)).status, 400);
  assert.equal((await post(admin, '/admin/competitions', { ...base, event_dates: `${y}-02-30` }, form)).status, 400);
  assert.equal((await post(admin, '/admin/competitions', { ...base, registration_deadline: `${y}-03-01`, event_dates: `${y}-02-01` }, form)).status, 400);
  assert.equal(count(), 0);
});

test('after entries, later days can change but the first day cannot', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  await addFighter(club, { date_of_birth: JUNIOR_DOB });
  const fighter = db.prepare('SELECT * FROM fighters').get();
  const entry = `/club/competitions/${compId}`;
  await post(club, `${entry}/enter`, { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) }, entry);

  const admin = await login(app, 'admin@test.test');
  const edit = `/admin/competitions/${compId}`;
  const first = `${EVENT_YEAR}-12-01`;
  const base = { name: 'Open', venue: 'Hall', registration_deadline: `${EVENT_YEAR}-11-01`, registration_deadline_time: '17:00' };

  await post(admin, edit, { ...base, event_dates: `${EVENT_YEAR}-12-08` }, `${edit}/edit`);
  assert.deepEqual(getEventDates(db, compId), [first, `${EVENT_YEAR}-12-08`]);

  const earlier = await post(admin, edit, { ...base, event_dates: `${EVENT_YEAR}-11-20` }, `${edit}/edit`);
  assert.equal(earlier.status, 400);
  assert.deepEqual(getEventDates(db, compId), [first, `${EVENT_YEAR}-12-08`]);

  await post(admin, edit, base, `${edit}/edit`);
  assert.deepEqual(getEventDates(db, compId), [first]);
});

test('bouts are spread across the event days and move when days change', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  const other = await signUpClub(app, 'Dragons', 'dragons@test.test');
  const form = `/club/competitions/${compId}`;
  const enter = async (agent, gender, weight) => {
    await addFighter(agent, { gender, date_of_birth: JUNIOR_DOB });
    const fighter = db.prepare('SELECT id FROM fighters ORDER BY id DESC').get();
    await post(agent, `${form}/enter`, { fighter_ids: String(fighter.id), ...weightField(db, fighter, String(weight)) }, form);
  };
  await enter(club, 'M', 50);
  await enter(other, 'M', 50);
  await enter(club, 'F', 50);
  await enter(other, 'F', 50);
  db.prepare("UPDATE registrations SET status = 'approved'").run();
  db.prepare("UPDATE competitions SET status = 'closed' WHERE id = ?").run(compId);

  const admin = await login(app, 'admin@test.test');
  const path = `/admin/competitions/${compId}/bouts`;
  await post(admin, `${path}/generate`, {}, path);
  const days = () => db.prepare('SELECT DISTINCT day FROM bouts ORDER BY day').all().map((b) => b.day);
  const pairs = () => db.prepare('SELECT blue_registration_id, red_registration_id FROM bouts ORDER BY id').all();
  assert.deepEqual(days(), [1]);
  const before = pairs();

  await post(
    admin,
    `/admin/competitions/${compId}`,
    {
      name: 'Open', venue: 'Hall', registration_deadline: `${EVENT_YEAR}-11-01`, registration_deadline_time: '17:00',
      event_dates: `${EVENT_YEAR}-12-08`,
    },
    `/admin/competitions/${compId}/edit`
  );
  assert.deepEqual(days(), [1, 2]);
  assert.deepEqual(pairs(), before, 'changing days keeps the draw');
  assert.match((await admin.get(path)).text, /2 \(\w{3} 8 Dec\)/);
});

test('migration turns a day count into consecutive dates', () => {
  const db = openDb(':memory:');
  db.exec('ALTER TABLE competitions ADD COLUMN bout_days INTEGER NOT NULL DEFAULT 1');
  db.prepare(
    "INSERT INTO competitions (name, event_date, registration_deadline, venue, bout_days) VALUES ('Old', '2030-01-30', '2030-01-01', 'Hall', 3)"
  ).run();
  db.pragma('user_version = 3');

  migrate(db);

  const { id } = db.prepare('SELECT id FROM competitions').get();
  assert.deepEqual(getEventDates(db, id), ['2030-01-30', '2030-01-31', '2030-02-01']);
  assert.ok(!db.pragma('table_info(competitions)').some((c) => c.name === 'bout_days'));
  assert.equal(db.pragma('user_version', { simple: true }), 5);
});

const tokenIn = (message) => message.text.match(/reset-password\/([0-9a-f]{64})/)[1];

test('password reset changes the password once and logs out old sessions', async () => {
  const { db, app, mailer } = await setup();
  const old = await login(app, 'admin@test.test');
  assert.equal((await old.get('/admin')).status, 200);

  const visitor = request.agent(app);
  const res = await post(visitor, '/forgot-password', { email: 'ADMIN@test.test' }, '/forgot-password');
  assert.match(res.text, /If that email has an account/);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'admin@test.test');
  assert.match(mailer.sent[0].text, /https:\/\/gms\.test\/reset-password\//, 'links use the configured address');
  const token = tokenIn(mailer.sent[0]);
  assert.ok(!db.prepare('SELECT token_hash FROM password_resets').get().token_hash.includes(token), 'only a hash is stored');

  const path = `/reset-password/${token}`;
  const short = await post(visitor, path, { password: 'short' }, path);
  assert.equal(short.status, 400);

  const done = await post(visitor, path, { password: 'a-brand-new-password' }, path);
  assert.equal(done.headers.location, '/login');

  assert.equal((await old.get('/admin')).status, 302, 'existing sessions are logged out');
  const again = request.agent(app);
  assert.equal((await post(again, '/login', { email: 'admin@test.test', password: PASSWORD }, '/login')).status, 401);
  assert.equal((await post(again, '/login', { email: 'admin@test.test', password: 'a-brand-new-password' }, '/login')).status, 302);

  assert.equal((await request(app).get(path)).status, 400, 'a link works only once');
});

test('password reset does not reveal accounts, and links expire', async () => {
  const { db, app, mailer } = await setup();
  const visitor = request.agent(app);
  const known = await post(visitor, '/forgot-password', { email: 'admin@test.test' }, '/forgot-password');
  const unknown = await post(visitor, '/forgot-password', { email: 'nobody@test.test' }, '/forgot-password');
  assert.equal(known.status, unknown.status);
  assert.match(unknown.text, /If that email has an account/);
  assert.equal(mailer.sent.length, 1, 'no email for unknown addresses');

  await post(visitor, '/forgot-password', { email: 'admin@test.test' }, '/forgot-password');
  assert.equal(mailer.sent.length, 1, 'repeat requests within minutes send nothing more');

  const { id } = db.prepare('SELECT id FROM users').get();
  db.prepare('DELETE FROM password_resets').run();
  const stale = createPasswordReset(db, id, Date.now() - 2 * 3600000);
  assert.ok(stale);
  assert.equal((await request(app).get(`/reset-password/${stale}`)).status, 400);
  assert.equal((await request(app).get('/reset-password/not-a-token')).status, 404);
});

test('coach application decisions and registration decisions send email', async () => {
  const { db, app, mailer } = await setup();
  const clubId = createClub(db, { name: 'Tigers', city: 'Manila' });
  const admin = await login(app, 'admin@test.test');
  const coach = await signUpCoach(app, 'coach@test.test');
  const sentTo = (address) => mailer.sent.filter((m) => m.to === address).map((m) => m.subject);

  await post(coach, '/coach/apply', { club_id: String(clubId) }, '/coach');
  assert.deepEqual(sentTo('admin@test.test'), ['Coach application: Tigers']);

  const application = db.prepare('SELECT id FROM club_applications').get();
  await post(admin, `/admin/clubs/applications/${application.id}/approve`, {}, '/admin/clubs');
  assert.deepEqual(sentTo('coach@test.test'), ["You're approved for Tigers"]);

  const compId = openCompetition(db);
  await addFighter(coach, { date_of_birth: JUNIOR_DOB });
  const fighter = db.prepare('SELECT * FROM fighters').get();
  const form = `/club/competitions/${compId}`;
  await post(coach, `/club/competitions/${compId}/enter`, { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) }, form);
  const reg = db.prepare('SELECT id FROM registrations').get();
  const review = `/admin/competitions/${compId}/registrations`;

  await post(admin, `/admin/competitions/${compId}/registrations/review`, { single: `rejected:${reg.id}`, [`note_${reg.id}`]: 'Wrong belt' }, review);
  const rejected = mailer.sent[mailer.sent.length - 1];
  assert.equal(rejected.subject, 'Registrations rejected: Open');
  assert.match(rejected.text, /Reyes: Wrong belt/);

  const before = mailer.sent.length;
  await post(admin, `/admin/competitions/${compId}/registrations/review`, { single: `approved:${reg.id}` }, review);
  assert.equal(mailer.sent.length, before + 1);
  await post(admin, `/admin/competitions/${compId}/registrations/review`, { single: `approved:${reg.id}` }, review);
  assert.equal(mailer.sent.length, before + 1, 'no email when nothing changed');
});

test('deadline reminders go out once, only inside the 3-day window, and again after a new deadline', async () => {
  const { db, app, mailer } = await setup();
  await signUpClub(app, 'Tigers', 'tigers@test.test');
  await signUpCoach(app, 'waiting@test.test');
  const dateIn = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA');
  const near = openCompetition(db, { name: 'Near', registration_deadline: dateIn(2) });
  openCompetition(db, { name: 'Far', registration_deadline: dateIn(30) });
  const ctx = { db, mailer, publicUrl: 'https://gms.test' };

  assert.equal(await sendDeadlineReminders(ctx), 1);
  assert.deepEqual(mailer.sent.map((m) => m.to), ['tigers@test.test'], 'only coaches in a club are reminded');
  assert.match(mailer.sent[0].subject, /Near/);
  assert.equal(await sendDeadlineReminders(ctx), 0, 'each competition is reminded once');

  const admin = await login(app, 'admin@test.test');
  await post(
    admin,
    `/admin/competitions/${near}`,
    { name: 'Near', venue: 'Hall', event_dates: `${EVENT_YEAR}-12-01`, registration_deadline: dateIn(1), registration_deadline_time: '12:00' },
    `/admin/competitions/${near}/edit`
  );
  assert.equal(await sendDeadlineReminders(ctx), 1);
});

async function publishedFour(db, app) {
  const made = await closedCompetitionWithFighters(db, app, [['T', 'Alpha'], ['T', 'Bravo'], ['D', 'Charlie'], ['D', 'Delta']]);
  const path = `/admin/competitions/${made.compId}/bouts`;
  await post(made.admin, `${path}/generate`, {}, path);
  return { ...made, path, results: `/admin/competitions/${made.compId}/results` };
}

const realBouts = (db) => db.prepare('SELECT * FROM bouts WHERE is_bye = 0 ORDER BY round, position').all();

test('winners advance, and results can be undone only from the latest bout back', async () => {
  const { db, app } = await setup();
  const { admin, results, compId } = await publishedFour(db, app);
  const [semiA, semiB, final] = realBouts(db);
  const record = (bout, winner) => post(admin, `${results}/${bout.id}`, { winner }, results);
  const clear = (bout) => post(admin, `${results}/${bout.id}`, { action: 'clear' }, results);
  const row = (bout) => db.prepare('SELECT * FROM bouts WHERE id = ?').get(bout.id);

  await record(final, 'blue');
  assert.equal(row(final).winner_registration_id, null, 'a bout without both fighters is refused');

  await record(semiA, 'red');
  assert.equal(row(final).blue_registration_id, semiA.red_registration_id);
  await record(semiA, 'blue');
  assert.equal(row(final).blue_registration_id, semiA.blue_registration_id, 'a winner can be changed before the next bout');

  await record(semiB, 'blue');
  assert.equal(row(final).red_registration_id, semiB.blue_registration_id);
  await record(final, 'red');
  assert.equal(row(final).winner_registration_id, semiB.blue_registration_id);

  await record(semiA, 'red');
  assert.equal(row(semiA).winner_registration_id, semiA.blue_registration_id, 'locked once the next bout has a result');
  await clear(semiA);
  assert.equal(row(semiA).winner_registration_id, semiA.blue_registration_id, 'undo is blocked too');

  await clear(final);
  await clear(semiA);
  assert.equal(row(final).blue_registration_id, null, 'undo removes the fighter from the next bout');

  const page = await admin.get(results);
  assert.match(page.text, /Winner of Bout/);
  assert.equal(db.prepare('SELECT status FROM competitions WHERE id = ?').get(compId).status, 'closed');
});

test('medals follow the final and semifinals, and a recorded draw cannot be replaced', async () => {
  const { db, app } = await setup();
  const { admin, results, path, compId } = await publishedFour(db, app);
  const [semiA, semiB, final] = realBouts(db);
  const clubOf = (regId) => db.prepare('SELECT c.name FROM registrations r JOIN clubs c ON c.id = r.club_id WHERE r.id = ?').get(regId).name;
  const sideOf = (bout, club) => (clubOf(bout.blue_registration_id) === club ? 'blue' : 'red');
  await post(admin, `${results}/${semiA.id}`, { winner: sideOf(semiA, 'Tigers') }, results);
  await post(admin, `${results}/${semiB.id}`, { winner: sideOf(semiB, 'Dragons') }, results);
  await post(admin, `${results}/${final.id}`, { winner: 'blue' }, results);

  const page = await admin.get(results);
  const cells = (name) => [...page.text.split(`<strong>${name}</strong>`)[1].matchAll(/medal-count">(\d+)</g)].slice(0, 3).map((m) => Number(m[1]));
  assert.deepEqual(cells('Tigers'), [1, 0, 1], 'gold, plus bronze for the losing semifinalist');
  assert.deepEqual(cells('Dragons'), [0, 1, 1], 'silver, plus bronze for the losing semifinalist');

  const pairs = () => db.prepare('SELECT blue_registration_id FROM bouts ORDER BY id').all();
  const before = pairs();
  await post(admin, `${path}/generate`, {}, path);
  await post(admin, `${path}/delete`, {}, path);
  assert.deepEqual(pairs(), before);

  await post(admin, `${results}/clear-all`, {}, results);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bouts WHERE winner_registration_id IS NOT NULL').get().n, 0);
  assert.equal(db.prepare('SELECT blue_registration_id AS id FROM bouts WHERE round = 2').get().id, null);
  await post(admin, `${path}/delete`, {}, path);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bouts WHERE competition_id = ?').get(compId).n, 0);
});

test('coaches see a bout list only once published, limited to their divisions', async () => {
  const { db, app, mailer } = await setup();
  const { admin, path, compId, club } = await publishedFour(db, app);
  const coachPage = `/club/competitions/${compId}/bouts`;
  assert.equal((await club.get(coachPage)).status, 404);
  assert.equal((await club.get(`${coachPage}.pdf`)).status, 404);

  const before = mailer.sent.length;
  await post(admin, `${path}/publish`, {}, path);
  assert.deepEqual(
    mailer.sent.slice(before).map((m) => m.to).sort(),
    ['dragons@test.test', 'tigers@test.test']
  );

  const page = await club.get(coachPage);
  assert.equal(page.status, 200);
  assert.match(page.text, /Your athletes/);
  assert.match(page.text, /Reyes|Alpha/);
  assert.match(page.text, /Bout \d+, \d\d:\d\d/);
  assert.equal((await club.get(`${coachPage}.pdf`)).headers['content-type'], 'application/pdf');
  assert.match((await club.get(`/club/competitions/${compId}`)).text, /View bout list/);

  // A club with no athletes in the draw sees none of its fighters.
  const other = await signUpClub(app, 'Phoenix', 'phoenix@test.test');
  const outsider = await other.get(coachPage);
  assert.ok(!outsider.text.includes('Alpha'));
  assert.equal((await other.get(`${coachPage}.pdf`)).status, 404);

  assert.equal((await request(app).get(coachPage)).status, 302, 'visitors must log in');
  assert.equal((await club.get(path)).status, 403, 'coaches cannot open the admin page');
  assert.equal((await post(club, `${path}/publish`, {}, coachPage)).status, 403);

  await post(admin, `${path}/generate`, {}, path);
  assert.equal((await club.get(coachPage)).status, 404, 'a redraw hides the list until published again');
});

test('coaches see where each athlete stands as results come in', async () => {
  const { db, app } = await setup();
  const { admin, path, results, compId, club } = await publishedFour(db, app);
  await post(admin, `${path}/publish`, {}, path);
  const [semiA, semiB, final] = realBouts(db);
  const tigersId = db.prepare("SELECT id FROM clubs WHERE name = 'Tigers'").get().id;
  const isTiger = (regId) => db.prepare('SELECT club_id FROM registrations WHERE id = ?').get(regId).club_id === tigersId;
  const side = (bout) => (isTiger(bout.blue_registration_id) ? 'blue' : 'red');

  await post(admin, `${results}/${semiA.id}`, { winner: side(semiA) }, results);
  await post(admin, `${results}/${semiB.id}`, { winner: side(semiB) }, results);
  await post(admin, `${results}/${final.id}`, { winner: 'blue' }, results);

  const page = await club.get(`/club/competitions/${compId}/bouts`);
  assert.match(page.text, /<td>Gold<\/td>/);
  assert.match(page.text, /<td>Silver<\/td>/);
  assert.match(page.text, /class="winner/);
});

test('the results migration removes declared weights and keeps registrations', () => {
  const db = openDb(':memory:');
  db.exec('ALTER TABLE registrations ADD COLUMN declared_weight_kg REAL');
  db.pragma('user_version = 4');
  migrate(db);
  assert.ok(!db.pragma('table_info(registrations)').some((c) => c.name === 'declared_weight_kg'));
  assert.equal(db.pragma('user_version', { simple: true }), 5);
});

test('athletes need the right document before they can enter', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  const form = `/club/competitions/${compId}`;
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n;

  const black = await addFighter(club, { date_of_birth: JUNIOR_DOB, belt_rank: '3' }, { withDocument: false });
  const blue = await addFighter(club, { date_of_birth: JUNIOR_DOB, belt_rank: '1', first_name: 'Bo' }, { withDocument: false });
  assert.match((await club.get(`/club/fighters/${black}/document`)).text, /needs a black belt certificate/);
  assert.match((await club.get(`/club/fighters/${blue}/document`)).text, /needs a grading card/);
  assert.match((await club.get(form)).text, /Upload black belt certificate first/);

  const fighter = { id: black };
  await post(club, `${form}/enter`, { fighter_ids: String(black), ...weightField(db, fighter, 50) }, form);
  assert.equal(count(), 0, 'no document, no entry');
  assert.match((await club.get(form)).text, /Upload their black belt certificate first/);

  await uploadDocument(club, black, TINY_PNG);
  assert.equal(db.prepare('SELECT doc_type FROM fighter_documents WHERE fighter_id = ?').get(black).doc_type, 'black_belt_certificate');
  await post(club, `${form}/enter`, { fighter_ids: String(black), ...weightField(db, fighter, 50) }, form);
  assert.equal(count(), 1);
  await uploadDocument(club, blue, TINY_PNG);
  assert.equal(db.prepare('SELECT doc_type FROM fighter_documents WHERE fighter_id = ?').get(blue).doc_type, 'grading_card');
});

test('uploads are checked by their contents and size', async () => {
  const { db, app } = await setup();
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  const id = await addFighter(club, {}, { withDocument: false });
  const stored = () => db.prepare('SELECT COUNT(*) AS n FROM fighter_documents').get().n;

  const script = await uploadDocument(club, id, Buffer.from('<script>alert(1)</script>padding'), 'card.png');
  assert.equal(script.status, 400);
  assert.match(script.text, /file type is not accepted/);

  const big = Buffer.concat([TINY_PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
  const large = await uploadDocument(club, id, big);
  assert.equal(large.status, 400, 'an oversized file gets a message, not a CSRF error');
  assert.match(large.text, /over the 5 MB limit/);

  const path = `/club/fighters/${id}/document`;
  const token = await csrfFrom(club, path);
  const none = await club.post(path).field('_csrf', token);
  assert.equal(none.status, 400);
  assert.equal(stored(), 0);

  const pdf = await uploadDocument(club, id, Buffer.from('%PDF-1.7 a scanned certificate'), 'scan.pdf');
  assert.equal(pdf.status, 302);
  const served = await club.get(`${path}/file`);
  assert.equal(served.headers['content-type'], 'application/pdf');
  assert.match(served.headers['cache-control'], /no-store/);
  assert.equal(served.headers['x-content-type-options'], 'nosniff');

  const noToken = await club.post(path).attach('document', TINY_PNG, 'card.png');
  assert.equal(noToken.status, 403, 'uploads still need a CSRF token');
});

test('documents are private to the club and admins', async () => {
  const { db, app } = await setup();
  const tigers = await signUpClub(app, 'Tigers', 'tigers@test.test');
  const dragons = await signUpClub(app, 'Dragons', 'dragons@test.test');
  const id = await addFighter(tigers, {});
  const file = `/club/fighters/${id}/document/file`;

  assert.equal((await tigers.get(file)).status, 200);
  assert.equal((await dragons.get(file)).status, 404);
  assert.equal((await dragons.get(`/club/fighters/${id}/document`)).status, 404);
  assert.equal((await request(app).get(file)).status, 302);
  assert.equal((await tigers.get(`/admin/fighters/${id}/document`)).status, 403);
  assert.equal((await request(app).get(`/admin/fighters/${id}/document`)).status, 302);

  const other = await uploadDocument(dragons, id, TINY_PNG).catch(() => null);
  assert.ok(!other || other.status === 404 || other.status === 403);
  assert.equal(db.prepare('SELECT uploaded_by FROM fighter_documents').get().uploaded_by, db.prepare("SELECT id FROM users WHERE email = 'tigers@test.test'").get().id);

  const admin = await login(app, 'admin@test.test');
  const seen = await admin.get(`/admin/fighters/${id}/document`);
  assert.equal(seen.status, 200);
  assert.equal(seen.headers['content-type'], 'image/png');
});

test('an approved athlete keeps their document, and a belt change needs a new one', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  const id = await addFighter(club, { date_of_birth: JUNIOR_DOB, belt_rank: '1' });
  const form = `/club/competitions/${compId}`;

  await post(club, `/club/fighters/${id}`, { first_name: 'Ana', last_name: 'Reyes', gender: 'F', date_of_birth: JUNIOR_DOB, belt_rank: '2' }, `/club/fighters/${id}/edit`);
  assert.ok(db.prepare('SELECT 1 FROM fighter_documents').get(), 'blue to red both use a grading card');

  const toBlack = await post(club, `/club/fighters/${id}`, { first_name: 'Ana', last_name: 'Reyes', gender: 'F', date_of_birth: JUNIOR_DOB, belt_rank: '3' }, `/club/fighters/${id}/edit`);
  assert.equal(toBlack.headers.location, `/club/fighters/${id}/document`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fighter_documents').get().n, 0);

  await uploadDocument(club, id, TINY_PNG);
  await post(club, `${form}/enter`, { fighter_ids: String(id), ...weightField(db, { id }, 50) }, form);
  db.prepare("UPDATE registrations SET status = 'approved'").run();
  const before = db.prepare('SELECT uploaded_at, length(data) AS size FROM fighter_documents').get();
  const locked = await uploadDocument(club, id, Buffer.concat([TINY_PNG, Buffer.alloc(100)]));
  assert.equal(locked.status, 400);
  assert.deepEqual(db.prepare('SELECT uploaded_at, length(data) AS size FROM fighter_documents').get(), before);

  // Athletes approved before documents existed can still add theirs, once.
  db.prepare('DELETE FROM fighter_documents').run();
  assert.match((await club.get(`/club/fighters/${id}/document`)).text, /enctype="multipart\/form-data"/);
  assert.equal((await uploadDocument(club, id, TINY_PNG)).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fighter_documents').get().n, 1);
  assert.equal((await uploadDocument(club, id, TINY_PNG)).status, 400);
});

test('the admin review page links to each document', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  const id = await addFighter(club, { date_of_birth: JUNIOR_DOB });
  const form = `/club/competitions/${compId}`;
  await post(club, `${form}/enter`, { fighter_ids: String(id), ...weightField(db, { id }, 50) }, form);
  const admin = await login(app, 'admin@test.test');
  const review = `/admin/competitions/${compId}/registrations`;
  assert.match((await admin.get(review)).text, /View black belt certificate/);

  db.prepare('DELETE FROM fighter_documents').run();
  assert.match((await admin.get(review)).text, /No document/);
});

const logged = (db) => db.prepare('SELECT * FROM activity_log ORDER BY id').all();
const lastLog = (db) => db.prepare('SELECT * FROM activity_log ORDER BY id DESC').get();

test('the activity log records who made each decision', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  const id = await addFighter(club, { date_of_birth: JUNIOR_DOB });
  const form = `/club/competitions/${compId}`;
  await post(club, `${form}/enter`, { fighter_ids: String(id), ...weightField(db, { id }, 50) }, form);
  assert.equal(lastLog(db).action, 'registration.entered');
  assert.match(lastLog(db).actor, /tigers@test\.test/);
  assert.equal(lastLog(db).competition_id, compId);

  const admin = await login(app, 'admin@test.test');
  const review = `/admin/competitions/${compId}/registrations`;
  const reg = db.prepare('SELECT id FROM registrations').get();
  await post(admin, `${review}/review`, { single: `rejected:${reg.id}`, [`note_${reg.id}`]: 'Blurry certificate' }, review);
  const entry = lastLog(db);
  assert.equal(entry.action, 'registration.rejected');
  assert.equal(entry.actor, 'admin@test.test');
  assert.match(entry.summary, /Rejected Ana Reyes \(Tigers\).*Reason: Blurry certificate/);

  const before = logged(db).length;
  await post(admin, `${review}/review`, { single: `rejected:${reg.id}`, [`note_${reg.id}`]: 'Blurry certificate' }, review);
  assert.equal(logged(db).length, before, 'nothing is logged when nothing changed');

  const noisy = JSON.stringify(logged(db));
  assert.ok(!noisy.includes(JUNIOR_DOB), 'dates of birth are not logged');
  assert.ok(!noisy.includes(PASSWORD), 'passwords are not logged');
});

test('results, draws and automatic closing are logged', async () => {
  const { db, app } = await setup();
  const { admin, results, path } = await publishedFour(db, app);
  assert.equal(lastLog(db).action, 'bouts.generated');
  await post(admin, `${path}/generate`, {}, path);
  assert.equal(lastLog(db).action, 'bouts.redrawn');
  await post(admin, `${path}/publish`, {}, path);
  assert.equal(lastLog(db).action, 'bouts.published');

  const [semi] = realBouts(db);
  await post(admin, `${results}/${semi.id}`, { winner: 'blue' }, results);
  assert.equal(lastLog(db).action, 'result.recorded');
  assert.match(lastLog(db).summary, /won Bout 1 \(Day 1, Court \d\)/);
  await post(admin, `${results}/${semi.id}`, { winner: 'red' }, results);
  assert.match(lastLog(db).summary, /changed from/);
  await post(admin, `${results}/${semi.id}`, { action: 'clear' }, results);
  assert.equal(lastLog(db).action, 'result.cleared');
  assert.match(lastLog(db).summary, /The winner had been/);

  openCompetition(db, { name: 'Expired', registration_deadline: '2020-01-01' });
  await request(app).get('/');
  assert.equal(lastLog(db).action, 'competition.auto_closed');
  assert.equal(lastLog(db).actor, 'System');
  await request(app).get('/');
  assert.equal(logged(db).filter((e) => e.action === 'competition.auto_closed').length, 1, 'closing is logged once');
});

test('club, coach and account actions are logged', async () => {
  const { db, app, mailer } = await setup();
  const admin = await login(app, 'admin@test.test');
  await post(admin, '/admin/clubs', { name: 'Tigers', city: 'Manila' }, '/admin/clubs');
  assert.equal(lastLog(db).action, 'club.created');

  const coach = await signUpCoach(app, 'coach@test.test');
  assert.equal(lastLog(db).action, 'account.created');
  const clubId = db.prepare('SELECT id FROM clubs').get().id;
  await post(coach, '/coach/apply', { club_id: String(clubId) }, '/coach');
  assert.equal(lastLog(db).action, 'coach.applied');

  const application = db.prepare('SELECT id FROM club_applications').get();
  await post(admin, `/admin/clubs/applications/${application.id}/approve`, {}, '/admin/clubs');
  assert.equal(lastLog(db).action, 'coach.approved');
  assert.match(lastLog(db).summary, /coach@test\.test.*Tigers/);

  const visitor = request.agent(app);
  await post(visitor, '/forgot-password', { email: 'coach@test.test' }, '/forgot-password');
  const reset = mailer.sent.find((m) => m.subject === 'Reset your password');
  const link = `/reset-password/${tokenIn(reset)}`;
  await post(visitor, link, { password: 'another-new-password' }, link);
  assert.equal(lastLog(db).action, 'account.password_reset');
  assert.match(lastLog(db).actor, /coach@test\.test/);
  assert.ok(!JSON.stringify(logged(db)).includes(tokenIn(reset)), 'reset tokens are not logged');
});

test('only admins can read the activity log, which filters and exports', async () => {
  const { db, app } = await setup();
  const first = openCompetition(db, { name: 'First' });
  openCompetition(db, { name: 'Second' });
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  const admin = await login(app, 'admin@test.test');
  await post(admin, `/admin/competitions/${first}/status`, { status: 'closed' }, '/admin');

  assert.equal((await club.get('/admin/activity')).status, 403);
  assert.equal((await club.get('/admin/activity.csv')).status, 403);
  assert.equal((await request(app).get('/admin/activity')).status, 302);

  const all = await admin.get('/admin/activity');
  assert.match(all.text, /Closed registration for First/);
  assert.match((await admin.get('/admin/activity?category=competition')).text, /Closed registration/);
  assert.ok(!(await admin.get('/admin/activity?category=club')).text.includes('Closed registration'));
  assert.ok((await admin.get(`/admin/activity?competition=${first}`)).text.includes('Closed registration'));
  assert.ok(!(await admin.get(`/admin/activity?competition=${first + 1}`)).text.includes('Closed registration'));
  assert.equal((await admin.get('/admin/activity?category=bad&competition=x&page=-1')).status, 200);

  db.prepare("INSERT INTO activity_log (actor, action, summary) VALUES ('=SUM(1)', 'club.created', '=cmd')").run();
  const csv = await admin.get('/admin/activity.csv');
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /Closed registration for First/);
  assert.ok(csv.text.includes(`"'=cmd"`), 'spreadsheet formulas are neutralised');
});

test('POST without a CSRF token is refused', async () => {
  const { app } = await setup();
  const res = await request(app).post('/login').type('form').send({ email: 'admin@test.test', password: PASSWORD });
  assert.equal(res.status, 403);
});

test('page output escapes user text', async () => {
  const { db, app } = await setup();
  const club = await signUpClub(app, '<script>alert(1)</script>', 'x@test.test');
  const page = await club.get('/club');
  assert.ok(!page.text.includes('<script>alert(1)</script>'));
  assert.ok(db.prepare('SELECT 1 FROM clubs').get());
});

test('public pages hide drafts and fighter details', async () => {
  const { db, app } = await setup();
  const draft = openCompetition(db, { status: 'draft', name: 'Secret draft' });
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  await addFighter(club, { date_of_birth: JUNIOR_DOB, last_name: 'Hiddenname' });
  const fighter = db.prepare('SELECT * FROM fighters').get();
  const form = `/club/competitions/${compId}`;
  await post(club, `${form}/enter`, { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) }, form);

  const visitor = request(app);
  assert.equal((await visitor.get(`/competitions/${draft}`)).status, 404);
  assert.ok(!(await visitor.get('/')).text.includes('Secret draft'));
  assert.ok(!(await visitor.get(`/competitions/${compId}`)).text.includes('Hiddenname'));
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const { db, app } = await setup();
  const compId = openCompetition(db);
  const club = await signUpClub(app, 'Tigers', 'tigers@test.test');
  await addFighter(club, { date_of_birth: JUNIOR_DOB, last_name: '=HYPERLINK("x")' });
  const fighter = db.prepare('SELECT * FROM fighters').get();
  const form = `/club/competitions/${compId}`;
  await post(club, `${form}/enter`, { fighter_ids: String(fighter.id), ...weightField(db, fighter, 50) }, form);
  db.prepare("UPDATE registrations SET status = 'approved'").run();

  const admin = await login(app, 'admin@test.test');
  const csv = await admin.get(`/admin/competitions/${compId}/export.csv`);
  assert.ok(csv.text.includes(`"'=HYPERLINK(""x"")"`));
});
