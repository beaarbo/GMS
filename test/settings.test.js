const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin, createCompetition, createCoachAccount, createClub, applyToClub, approveApplication, cleanUpDocuments } = require('../src/services');
const { loadSettings, saveSettings, shortenNames, readSiteSettings } = require('../src/settings');
const { currentCode } = require('../src/totp');
const { notifyNewsPosted } = require('../src/notifications');

const PASSWORD = 'test-password-123';

async function setup() {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const sent = [];
  const mailer = { sent, configured: true, send: async (message) => { sent.push(message); } };
  return { db, mailer, app: createApp({ db, sessionSecret: 'test-secret', mailer, publicUrl: 'https://gms.test' }) };
}

async function csrfFrom(agent, path) {
  const page = await agent.get(path);
  const match = page.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, `no CSRF token on ${path}`);
  return match[1];
}

async function post(agent, path, fields, formPath = '/login') {
  const _csrf = await csrfFrom(agent, formPath);
  return agent.post(path).type('form').send({ _csrf, ...fields });
}

async function login(app, email) {
  const agent = request.agent(app);
  const res = await post(agent, '/login', { email, password: PASSWORD });
  assert.equal(res.status, 302);
  return agent;
}

const siteForm = (changes = {}) => ({ ...loadSettingsDefaults(), ...changes });
function loadSettingsDefaults() {
  const { raw } = loadSettings(openDb(':memory:'));
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('default_')));
}

test('the site name, footer and sign-up setting show on pages, and sign-up can be closed', async () => {
  const { app } = await setup();
  const admin = await login(app, 'admin@test.test');
  const saved = await post(admin, '/admin/settings', siteForm({ site_name: 'Lions Taekwondo', contact_email: 'help@lions.test', coach_signup: '0', require_document: '1' }), '/admin/settings');
  assert.equal(saved.status, 302);

  const home = await request(app).get('/');
  assert.match(home.text, /<title>[^<]*Lions Taekwondo<\/title>/);
  assert.match(home.text, /help@lions\.test/);
  assert.doesNotMatch(home.text, /href="\/register"/);
  assert.equal((await request(app).get('/register')).status, 403);

  const bad = await post(admin, '/admin/settings', siteForm({ site_name: '', time_zone: 'Mars/Base' }), '/admin/settings');
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Enter a site name/);
  assert.match(bad.text, /time zone is not recognised/);
});

test('new competitions start from the saved defaults', async () => {
  const { db, app } = await setup();
  const admin = await login(app, 'admin@test.test');
  const form = {
    default_age_basis: 'date', default_max_per_club: '2', default_bout_courts: '4', default_bout_start: '08:30', default_bout_minutes: '6', default_bout_rest: '15',
    default_poomsae_format: 'cut', default_poomsae_cut: '8', default_poomsae_judges: '5', default_poomsae_courts: '2', default_poomsae_start: '10:00', default_poomsae_minutes: '4', default_poomsae_rest: '5',
    age_name: ['Open'], age_min: ['10'], age_max: ['40'], age_male: ['-60,+60'], age_female: ['-55,+55'],
    poomsae_name: ['All ages'], poomsae_min: ['6'], poomsae_max: ['99'],
  };
  assert.equal((await post(admin, '/admin/settings/defaults', form, '/admin/settings/defaults')).status, 302);

  const id = createCompetition(db, { name: 'Cup', event_date: '2099-05-01', registration_deadline: '2099-04-01', venue: 'Hall' });
  const c = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  assert.deepEqual(
    [c.age_basis, c.max_per_club_division, c.bout_courts, c.bout_start, c.bout_minutes, c.bout_rest_minutes, c.poomsae_format, c.poomsae_cut, c.poomsae_judges, c.poomsae_courts],
    ['date', 2, 4, '08:30', 6, 15, 'cut', 8, 5, 2]
  );
  assert.deepEqual(db.prepare('SELECT name FROM age_groups WHERE competition_id = ?').all(id).map((g) => g.name), ['Open']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM weight_classes WHERE competition_id = ? AND gender = 'M'").get(id).n, 2);
  assert.deepEqual(db.prepare('SELECT name FROM poomsae_age_groups WHERE competition_id = ?').all(id).map((g) => g.name), ['All ages']);

  const overlapping = await post(admin, '/admin/settings/defaults', { ...form, age_name: ['A', 'B'], age_min: ['10', '12'], age_max: ['20', '30'], age_male: ['-60', '-60'], age_female: ['-55', '-55'] }, '/admin/settings/defaults');
  assert.equal(overlapping.status, 400);
});

test('two-step login: set up with a code, then every login needs one, and a recovery code works once', async () => {
  const { db, app } = await setup();
  const admin = await login(app, 'admin@test.test');
  await post(admin, '/account/two-step/start', {}, '/account');
  const page = await admin.get('/account');
  const key = page.text.match(/class="setup-key">([A-Z2-7 ]+)</)[1].replace(/ /g, '');
  assert.equal((await post(admin, '/account/two-step/confirm', { code: '000000' }, '/account')).status, 400);
  const confirmed = await post(admin, '/account/two-step/confirm', { code: currentCode(key) }, '/account');
  const recovery = [...confirmed.text.matchAll(/<li><code>([0-9a-f]{5}-[0-9a-f]{5})<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(recovery.length, 10);
  assert.ok(!db.prepare('SELECT totp_recovery FROM users WHERE email = ?').get('admin@test.test').totp_recovery.includes(recovery[0]));

  // The password alone no longer logs in.
  const agent = request.agent(app);
  const step = await post(agent, '/login', { email: 'admin@test.test', password: PASSWORD });
  assert.equal(step.headers.location, '/login/code');
  assert.equal((await agent.get('/admin')).status, 302);
  assert.equal((await post(agent, '/login/code', { code: '123456' }, '/login/code')).status, 401);
  const done = await post(agent, '/login/code', { code: currentCode(key) }, '/login/code');
  assert.equal(done.headers.location, '/admin');
  assert.equal((await agent.get('/admin')).status, 200);

  const second = request.agent(app);
  await post(second, '/login', { email: 'admin@test.test', password: PASSWORD });
  assert.equal((await post(second, '/login/code', { code: recovery[0] }, '/login/code')).status, 302);
  const third = request.agent(app);
  await post(third, '/login', { email: 'admin@test.test', password: PASSWORD });
  assert.equal((await post(third, '/login/code', { code: recovery[0] }, '/login/code')).status, 401);
});

test('requiring two-step login for admins needs the saving admin to have it, then holds back admins without it', async () => {
  const { db, app } = await setup();
  const admin = await login(app, 'admin@test.test');
  const refused = await post(admin, '/admin/settings', siteForm({ require_2fa_admins: '1' }), '/admin/settings');
  assert.equal(refused.status, 400);
  assert.match(refused.text, /Set up two-step login on My account first/);

  saveSettings(db, { require_2fa_admins: '1' });
  const blocked = await admin.get('/admin/competitions');
  assert.equal(blocked.headers.location, '/account#two-step');
  assert.equal((await admin.get('/account')).status, 200);
});

test('coaches choose which emails they get; security emails still come', async () => {
  const { db, app, mailer } = await setup();
  const clubId = createClub(db, { name: 'Tigers', city: 'City' });
  const coachId = await createCoachAccount(db, { full_name: 'Coach', phone: '1', email: 'coach@test.test', password: PASSWORD });
  approveApplication(db, applyToClub(db, coachId, clubId).id);
  const coach = await login(app, 'coach@test.test');
  await post(coach, '/account/emails', { kind: ['decisions', 'reminders'] }, '/account');
  assert.deepEqual(JSON.parse(db.prepare('SELECT email_opt_out FROM users WHERE id = ?').get(coachId).email_opt_out), ['published', 'divisions', 'news']);

  await notifyNewsPosted({ db, mailer, publicUrl: 'https://gms.test' }, { id: 1, title: 'T', body: 'B' });
  assert.equal(mailer.sent.length, 0);
  await post(coach, '/account/password', { current_password: PASSWORD, new_password: 'another-password-1', confirm_password: 'another-password-1' }, '/account');
  assert.equal(mailer.sent.length, 1);
});

test('admins add coaches straight into a club, and visitors can get shortened names', async () => {
  const { db, app } = await setup();
  const clubId = createClub(db, { name: 'Tigers', city: 'City' });
  const admin = await login(app, 'admin@test.test');
  const added = await post(admin, '/admin/accounts/coaches', { full_name: 'New Coach', phone: '9', email: 'new@test.test', password: PASSWORD, club_id: String(clubId) }, '/admin/accounts');
  assert.equal(added.status, 302);
  assert.equal(db.prepare('SELECT club_id FROM users WHERE email = ?').get('new@test.test').club_id, clubId);
  assert.equal((await (await login(app, 'new@test.test')).get('/club')).status, 200);

  assert.deepEqual(shortenNames({ name: 'Junior', bouts: [{ name: 'Rossi Ana', club: 'T' }] }), { name: 'Junior', bouts: [{ name: 'Rossi A.', club: 'T' }] });
});

test('reading the settings form keeps values in range', () => {
  const { errors } = readSiteSettings({ site_name: 'X', reminder_days: '0', backup_keep_daily: '400', backup_keep_manual: '5', document_retention_days: 'abc' });
  assert.equal(errors.length, 3);
});

test('document clean-up keeps documents of athletes in recent or coming competitions', async () => {
  const { db } = await setup();
  const clubId = createClub(db, { name: 'Tigers', city: 'City' });
  const fighter = (name) => Number(db.prepare("INSERT INTO fighters (club_id, first_name, last_name, gender, date_of_birth, belt_rank) VALUES (?, ?, 'X', 'M', '2010-01-01', 1)").run(clubId, name).lastInsertRowid);
  const [oldOne, entered] = [fighter('Old'), fighter('Entered')];
  [oldOne, entered].forEach((id) => db.prepare("INSERT INTO fighter_documents (fighter_id, doc_type, content_type, data, uploaded_at) VALUES (?, 'grading_card', 'image/png', x'00', datetime('now', '-400 days'))").run(id));
  const compId = createCompetition(db, { name: 'Cup', event_date: '2099-05-01', registration_deadline: '2099-04-01', venue: 'Hall' });
  const group = (table) => db.prepare(`SELECT id FROM ${table} WHERE competition_id = ?`).get(compId).id;
  db.prepare("INSERT INTO registrations (competition_id, fighter_id, club_id, age_at_event, age_group_id, belt_group_id, weight_class_id, status) VALUES (?, ?, ?, 16, ?, ?, ?, 'pending')")
    .run(compId, entered, clubId, group('age_groups'), group('belt_groups'), group('weight_classes'));
  assert.equal(cleanUpDocuments(db, 365), 1);
  assert.deepEqual(db.prepare('SELECT fighter_id FROM fighter_documents').all().map((d) => d.fighter_id), [entered]);
});
