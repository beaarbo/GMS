const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin } = require('../src/services');
const { createMailer, explainMailError, maskUser } = require('../src/mailer');

const PASSWORD = 'test-password-123';

test('mail errors come with advice an organiser can act on', () => {
  assert.match(explainMailError({ code: 'NOT_CONFIGURED' }), /SMTP_HOST/);
  assert.match(explainMailError({ code: 'EAUTH', responseCode: 535, error: 'Invalid login' }), /App Password/);
  assert.match(explainMailError({ code: 'ETIMEDOUT', error: 'Connection timeout' }), /block outgoing email/);
  assert.match(explainMailError({ code: 'EDNS', error: 'getaddrinfo ENOTFOUND smtp.gmial.com' }), /typos/);
  assert.match(explainMailError({ code: 'ESOCKET', error: 'wrong version number' }), /587/);
  assert.match(explainMailError({ code: 'ESOCKET', error: 'connect ETIMEDOUT 142.250.4.108:587' }), /block outgoing email/, 'a blocked port reported as ESOCKET');
  assert.equal(maskUser('marvin@gmail.com'), 'ma***@gmail.com');
  assert.equal(maskUser(''), '');
});

test('a mailer without SMTP says so, and an unreachable server is reported, not hidden', async () => {
  const none = createMailer({ logger: { log() {}, warn() {}, error() {} } });
  assert.equal(none.details().configured, false);
  assert.deepEqual(await none.test({ to: 'a@b.test', subject: 's', text: 't' }), { ok: false, code: 'NOT_CONFIGURED', error: 'SMTP_HOST is not set.' });

  // Nothing listens on port 1, so the connection is refused straight away.
  const broken = createMailer({ host: '127.0.0.1', port: 1, user: 'organiser@example.test', pass: 'secret' });
  const details = broken.details();
  assert.equal(details.user, 'or***@example.test');
  assert.ok(!JSON.stringify(details).includes('secret'), 'the password is never in the details');
  const result = await broken.test({ to: 'a@b.test', subject: 's', text: 't' });
  assert.equal(result.ok, false);
  assert.match(explainMailError(result), /could not reach the mail server/);
});

async function adminAgent(app) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  await agent.post('/login').type('form').send({ _csrf, email: 'admin@test.test', password: PASSWORD });
  return agent;
}

async function sendTest(agent, to) {
  const page = await agent.get('/admin/email');
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  return agent.post('/admin/email/test').type('form').send({ _csrf, to });
}

test('admins send a test email and see why it failed', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const sent = [];
  let outcome = { ok: false, code: 'EAUTH', responseCode: 535, error: '535 5.7.8 Username and Password not accepted' };
  const mailer = {
    configured: true,
    details: () => ({ configured: true, host: 'smtp.gmail.com', port: 587, secure: false, user: 'or***@gmail.com', from: 'GMS <x@gmail.com>' }),
    async test(message) { sent.push(message); return outcome; },
    async send() {},
  };
  const app = createApp({ db, sessionSecret: 'test-secret', mailer, publicUrl: 'https://gms.test' });
  const admin = await adminAgent(app);

  const settings = await admin.get('/admin/email');
  assert.match(settings.text, /smtp\.gmail\.com, port 587/);
  assert.match(settings.text, /or\*\*\*@gmail\.com/);
  assert.doesNotMatch((await admin.get('/admin')).text, /Email is not set up/);

  await sendTest(admin, 'someone@test.test');
  assert.equal(sent[0].to, 'someone@test.test');
  assert.match(sent[0].text, /Links in emails point to: https:\/\/gms\.test/);
  const failed = await admin.get('/admin/email');
  assert.match(failed.text, /The test email to someone@test\.test failed/);
  assert.match(failed.text, /App Password/);
  assert.match(failed.text, /Username and Password not accepted/);
  assert.doesNotMatch((await admin.get('/admin/email')).text, /failed\./, 'the result shows once');

  outcome = { ok: true };
  await sendTest(admin, '');
  assert.equal(sent[1].to, 'admin@test.test', 'blank means the admin\'s own address');
  assert.match((await admin.get('/admin/email')).text, /was accepted by the mail server/);

  const log = db.prepare("SELECT summary FROM activity_log WHERE action = 'account.email_test' ORDER BY id").all().map((r) => r.summary);
  assert.deepEqual(log, ['Sent a test email to someone@test.test: it failed (EAUTH)', 'Sent a test email to admin@test.test: it worked']);

  assert.equal((await request(app).get('/admin/email')).status, 302, 'visitors are sent to log in');
});

test('the dashboard warns when email is not set up', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', mailer: createMailer({ logger: { log() {}, warn() {}, error() {} } }), publicUrl: 'http://localhost:3000' });
  const admin = await adminAgent(app);
  assert.match((await admin.get('/admin')).text, /Email is not set up[\s\S]*href="\/admin\/email"/);
  const settings = (await admin.get('/admin/email')).text;
  assert.match(settings, /Email is not set up, so nothing is sent/);
  assert.match(settings, /PUBLIC_URL points at this computer/);
});
