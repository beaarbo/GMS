const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin } = require('../src/services');

const PASSWORD = 'test-password-123';

async function setup() {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'owner@test.test', PASSWORD);
  const sent = [];
  const mailer = { configured: true, send: async (message) => { sent.push(message); } };
  return { db, sent, app: createApp({ db, sessionSecret: 'test-secret', mailer, publicUrl: 'https://gms.test' }) };
}

async function csrfFrom(agent, path) {
  const match = (await agent.get(path)).text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, `no CSRF token on ${path}`);
  return match[1];
}

async function post(agent, path, fields, formPath) {
  const _csrf = await csrfFrom(agent, formPath);
  return agent.post(path).type('form').send({ _csrf, ...fields });
}

async function login(app, email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await post(agent, '/login', { email, password }, '/login');
  return { agent, res };
}

test('the owner adds a sub-admin by email; they must choose their own password before anything else', async () => {
  const { db, sent, app } = await setup();
  const { agent: owner } = await login(app, 'owner@test.test');
  const added = await post(owner, '/admin/accounts/admins', { full_name: 'Sam Sub', email: 'sub@test.test' }, '/admin/accounts');
  assert.equal(added.status, 302);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'sub@test.test');
  const oneTime = sent[0].text.match(/One-time password: (\S+)/)[1];
  assert.doesNotMatch((await owner.get('/admin/accounts?type=admin')).text, new RegExp(oneTime), 'the password is never shown on the site');
  assert.ok(!db.prepare('SELECT summary FROM activity_log').all().some((row) => row.summary.includes(oneTime)), 'nor logged');

  const { agent: sub } = await login(app, 'sub@test.test', oneTime);
  const blocked = await sub.get('/admin/competitions');
  assert.equal(blocked.headers.location, '/account#password');
  assert.match((await sub.get('/account')).text, /one-time password/);
  const same = await post(sub, '/account/password', { current_password: oneTime, new_password: oneTime, confirm_password: oneTime }, '/account');
  assert.equal(same.status, 400);
  const changed = await post(sub, '/account/password', { current_password: oneTime, new_password: 'my-own-password-1', confirm_password: 'my-own-password-1' }, '/account');
  assert.equal(changed.status, 302);
  assert.equal((await sub.get('/admin/competitions')).status, 200, 'a sub-admin then has the admin pages');
  assert.equal((await login(app, 'sub@test.test', oneTime)).res.status, 401, 'the one-time password no longer works');
});

test('sub-admins cannot add or remove admins, touch the owner, download backups or change security settings', async () => {
  const { db, sent, app } = await setup();
  const { agent: owner } = await login(app, 'owner@test.test');
  await post(owner, '/admin/accounts/admins', { full_name: 'Sam Sub', email: 'sub@test.test' }, '/admin/accounts');
  await post(owner, '/admin/accounts/admins', { full_name: 'Pat Two', email: 'two@test.test' }, '/admin/accounts');
  const subPassword = sent[0].text.match(/One-time password: (\S+)/)[1];
  const { agent: sub } = await login(app, 'sub@test.test', subPassword);
  await post(sub, '/account/password', { current_password: subPassword, new_password: 'my-own-password-1', confirm_password: 'my-own-password-1' }, '/account');

  const ownerId = db.prepare("SELECT id FROM users WHERE email = 'owner@test.test'").get().id;
  const twoId = db.prepare("SELECT id FROM users WHERE email = 'two@test.test'").get().id;
  assert.equal((await post(sub, '/admin/accounts/admins', { full_name: 'X', email: 'x@test.test' }, '/admin/accounts')).status, 403);
  assert.equal((await post(sub, `/admin/accounts/admins/${twoId}/remove`, {}, '/admin/accounts')).status, 403);
  assert.equal((await post(sub, `/admin/accounts/admins/${ownerId}/remove`, {}, '/admin/accounts')).status, 403);
  assert.equal((await sub.get('/admin/backups/gms-20260101-000000-daily.sqlite')).status, 403);

  db.prepare("UPDATE users SET totp_secret = 'ABCDEFGHIJKLMNOP' WHERE id = ?").run(ownerId);
  await post(sub, `/admin/accounts/${ownerId}/two-step/off`, {}, '/admin/accounts');
  assert.ok(db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(ownerId).totp_secret, 'the owner keeps two-step login');

  const settings = (await sub.get('/admin/settings')).text;
  const form = { site_name: 'Renamed', reminder_days: '3', backup_keep_daily: '7', backup_keep_manual: '10', offsite_backup_email: 'thief@test.test', require_2fa_admins: '1' };
  assert.match(settings, /main admin only/);
  await post(sub, '/admin/settings', form, '/admin/settings');
  const saved = Object.fromEntries(db.prepare('SELECT key, value FROM site_settings').all().map((r) => [r.key, r.value]));
  assert.equal(saved.site_name, 'Renamed', 'other settings still save');
  assert.equal(saved.offsite_backup_email || '', '', 'the off-site backup address is the owner’s');
  assert.equal(saved.require_2fa_admins || '0', '0');

  // The owner removes a sub-admin, who is logged out at once.
  assert.equal((await post(owner, `/admin/accounts/admins/${db.prepare("SELECT id FROM users WHERE email = 'sub@test.test'").get().id}/remove`, {}, '/admin/accounts')).status, 302);
  assert.equal((await sub.get('/admin/competitions')).status, 302);
  assert.ok(db.prepare("SELECT 1 FROM users WHERE email = 'owner@test.test'").get());
});

test('an existing site’s first admin becomes the owner', async () => {
  const { db } = await setup();
  assert.deepEqual(db.prepare("SELECT email, owner FROM users WHERE role = 'admin'").all(), [{ email: 'owner@test.test', owner: 1 }]);
});
