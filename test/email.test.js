const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin } = require('../src/services');
const { createMailer, explainMailError, maskUser } = require('../src/mailer');

const PASSWORD = 'test-password-123';

test('mail errors come with advice an organiser can act on', () => {
  assert.match(explainMailError({ code: 'NOT_CONFIGURED' }), /BREVO_API_KEY/);
  assert.match(explainMailError({ code: 'EAUTH', responseCode: 535, error: 'Invalid login' }), /App Password/);
  assert.match(explainMailError({ code: 'ETIMEDOUT', error: 'Connection timeout' }), /blocks outgoing email[\s\S]*BREVO_API_KEY/);
  assert.match(explainMailError({ code: 'EDNS', error: 'getaddrinfo ENOTFOUND smtp.gmial.com' }), /typos/);
  assert.match(explainMailError({ code: 'ESOCKET', error: 'wrong version number' }), /587/);
  assert.match(explainMailError({ code: 'ESOCKET', error: 'connect ETIMEDOUT 142.250.4.108:587' }), /blocks outgoing email/, 'a blocked port reported as ESOCKET');
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

// A fetch stand-in that records each call and answers with `reply`.
function fakeFetch(reply) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    if (reply instanceof Error) throw reply;
    return { ok: reply.status < 300, status: reply.status, statusText: 'x', json: async () => reply.body || {} };
  };
  return { calls, fetchImpl };
}

test('Brevo sends over HTTPS and its errors come with advice', async () => {
  const { calls, fetchImpl } = fakeFetch({ status: 201, body: { messageId: 'm' } });
  const mailer = createMailer({
    brevoApiKey: 'xkeysib-123', host: 'smtp.gmail.com', from: 'Game Management System <club@example.com>', fetchImpl,
  });
  assert.equal(mailer.details().provider, 'Brevo', 'an API key wins over SMTP settings');
  assert.ok(!JSON.stringify(mailer.details()).includes('xkeysib'), 'the key is never in the details');
  assert.deepEqual(await mailer.test({ to: 'coach@test.test', subject: 'Hi', text: 'Body' }), { ok: true });
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].headers['api-key'], 'xkeysib-123');
  assert.deepEqual(calls[0].body, {
    sender: { name: 'Game Management System', email: 'club@example.com' },
    to: [{ email: 'coach@test.test' }],
    subject: 'Hi',
    textContent: 'Body',
  });

  const badKey = await createMailer({ brevoApiKey: 'k', from: 'a@b.test', fetchImpl: fakeFetch({ status: 401, body: { code: 'unauthorized', message: 'Key not found' } }).fetchImpl })
    .test({ to: 'x@y.test', subject: 's', text: 't' });
  assert.equal(badKey.ok, false);
  assert.match(badKey.error, /401 Key not found/);
  assert.match(explainMailError(badKey), /refused the API key[\s\S]*BREVO_API_KEY/);

  const unverified = await createMailer({ brevoApiKey: 'k', from: 'me@gmail.com', fetchImpl: fakeFetch({ status: 400, body: { code: 'invalid_parameter', message: 'Sender is not valid. Please verify it' } }).fetchImpl })
    .test({ to: 'x@y.test', subject: 's', text: 't' });
  assert.match(explainMailError(unverified), /Brevo only sends from an address you have verified/);

  const offline = await createMailer({ brevoApiKey: 'k', from: 'a@b.test', fetchImpl: fakeFetch(Object.assign(new Error('timed out'), { name: 'TimeoutError' })).fetchImpl })
    .test({ to: 'x@y.test', subject: 's', text: 't' });
  assert.equal(offline.code, 'ETIMEDOUT');
  assert.match(explainMailError(offline), /could not reach the email service/);

  // send() logs a failure instead of throwing, so the page carries on.
  const logged = [];
  const quiet = createMailer({ brevoApiKey: 'k', from: 'a@b.test', logger: { error: (m) => logged.push(m) }, fetchImpl: fakeFetch({ status: 500, body: { message: 'down' } }).fetchImpl });
  await quiet.send({ to: 'x@y.test', subject: 'Reset your password', text: 't' });
  assert.match(logged[0], /Email failed: "Reset your password" to x@y\.test: 500 down/);
});

test('Resend sends over HTTPS and explains unverified domains', async () => {
  const { calls, fetchImpl } = fakeFetch({ status: 200, body: { id: 'e' } });
  const mailer = createMailer({ resendApiKey: 're_123', from: 'GMS <no-reply@club.org>', fetchImpl });
  assert.equal(mailer.details().provider, 'Resend');
  assert.deepEqual(await mailer.test({ to: 'coach@test.test', subject: 'Hi', text: 'Body' }), { ok: true });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].headers.authorization, 'Bearer re_123');
  assert.deepEqual(calls[0].body, { from: 'GMS <no-reply@club.org>', to: ['coach@test.test'], subject: 'Hi', text: 'Body' });

  const domain = await createMailer({ resendApiKey: 'k', from: 'me@gmail.com', fetchImpl: fakeFetch({ status: 403, body: { message: 'The gmail.com domain is not verified. Please, add and verify your domain.' } }).fetchImpl })
    .test({ to: 'x@y.test', subject: 's', text: 't' });
  assert.match(explainMailError(domain), /verified in Resend/);
});

test('behind a proxy, each visitor gets their own rate limit', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', publicUrl: 'https://gms.test', trustProxy: 1 });
  const ask = async (ip) => {
    const agent = request.agent(app);
    const page = await agent.get('/forgot-password').set('X-Forwarded-For', ip);
    const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    return agent.post('/forgot-password').set('X-Forwarded-For', ip).type('form').send({ _csrf, email: 'nobody@test.test' });
  };
  let last;
  for (let i = 0; i < 11; i += 1) last = await ask('203.0.113.1');
  assert.equal(last.status, 429, 'one visitor hits the limit');
  assert.notEqual((await ask('203.0.113.2')).status, 429, 'another visitor is not blocked by them');
});

test('the Settings sender name and backup attachments reach Brevo and Resend', async () => {
  const brevo = fakeFetch({ status: 201, body: {} });
  await createMailer({ brevoApiKey: 'k', from: 'GMS <club@example.com>', senderName: () => 'Lions TKD', fetchImpl: brevo.fetchImpl })
    .send({ to: 'a@b.test', subject: 's', text: 't', attachments: [{ filename: 'gms.sqlite', content: Buffer.from('db') }] });
  assert.deepEqual(brevo.calls[0].body.sender, { name: 'Lions TKD', email: 'club@example.com' });
  assert.deepEqual(brevo.calls[0].body.attachment, [{ name: 'gms.sqlite', content: Buffer.from('db').toString('base64') }]);

  const resend = fakeFetch({ status: 200, body: {} });
  await createMailer({ resendApiKey: 'k', from: 'club@example.com', fetchImpl: resend.fetchImpl })
    .send({ to: 'a@b.test', subject: 's', text: 't', attachments: [{ filename: 'gms.sqlite', content: Buffer.from('db') }] });
  assert.equal(resend.calls[0].body.from, 'club@example.com');
  assert.deepEqual(resend.calls[0].body.attachments, [{ filename: 'gms.sqlite', content: Buffer.from('db').toString('base64') }]);
});
