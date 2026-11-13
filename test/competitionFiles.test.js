const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin } = require('../src/services');
const { detectAttachmentType, safeFilename } = require('../src/documents');

const PASSWORD = 'test-password-123';
const YEAR = new Date().getFullYear() + 1;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n%fake prospectus\n');
const ZIP = Buffer.from('PK\u0003\u0004 pretend office file');

test('attachments are checked by content, and Word or Excel by name too', () => {
  assert.equal(detectAttachmentType(PDF, 'x.exe').contentType, 'application/pdf');
  assert.equal(detectAttachmentType(ZIP, 'Rules.DOCX').extension, 'docx');
  assert.equal(detectAttachmentType(ZIP, 'entries.xlsx').extension, 'xlsx');
  assert.equal(detectAttachmentType(ZIP, 'bundle.zip'), null);
  assert.equal(detectAttachmentType(Buffer.from('MZ not a document'), 'form.pdf'), null);
  assert.equal(safeFilename('Prospectus "2027"/../x.pdf', 'pdf'), 'Prospectus 2027..x.pdf');
});

async function csrfFrom(agent, path) {
  const page = await agent.get(path);
  return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
}

test('the new-competition form can include the logo and files', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', publicUrl: 'https://gms.test' });
  const admin = request.agent(app);
  const loginToken = await csrfFrom(admin, '/login');
  await admin.post('/login').type('form').send({ _csrf: loginToken, email: 'admin@test.test', password: PASSWORD });

  const form = await admin.get('/admin/competitions/new');
  assert.match(form.text, /enctype="multipart\/form-data"/);
  assert.match(form.text, /name="files" type="file"[^>]*multiple/);
  const _csrf = form.text.match(/name="_csrf" value="([^"]+)"/)[1];

  const fill = (req) => req
    .field('_csrf', _csrf)
    .field('name', 'Harbour Cup').field('venue', 'Arena').field('description', 'Open to all clubs.')
    .field('event_dates', `${YEAR}-05-02`).field('event_dates', `${YEAR}-05-03`).field('event_dates', '')
    .field('registration_deadline', `${YEAR}-04-01`).field('registration_deadline_time', '17:00')
    .field('age_basis', 'year');

  // One bad file means nothing is saved, and the admin is told to choose them again.
  const bad = await fill(admin.post('/admin/competitions'))
    .attach('logo', PNG, 'logo.png').attach('files', PDF, 'rules.pdf').attach('files', Buffer.from('MZ'), 'setup.exe');
  assert.equal(bad.status, 400);
  assert.match(bad.text, /setup.exe is not an accepted file type/);
  assert.match(bad.text, /choose the logo and files again/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM competitions').get().n, 0);

  const tooBigLogo = await fill(admin.post('/admin/competitions')).attach('logo', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), 'big.png');
  assert.equal(tooBigLogo.status, 400);
  assert.match(tooBigLogo.text, /logo is over the 1 MB limit/);

  const ok = await fill(admin.post('/admin/competitions'))
    .attach('logo', PNG, 'logo.png').attach('files', PDF, 'Prospectus.pdf').attach('files', ZIP, 'Entry form.xlsx');
  assert.equal(ok.status, 302);
  const id = Number(ok.headers.location.match(/competitions\/(\d+)\/files/)[1]);
  const comp = db.prepare('SELECT name, status, description FROM competitions WHERE id = ?').get(id);
  assert.deepEqual(comp, { name: 'Harbour Cup', status: 'draft', description: 'Open to all clubs.' });
  assert.deepEqual(db.prepare('SELECT event_date FROM competition_dates WHERE competition_id = ? ORDER BY event_date').all(id).map((r) => r.event_date), [`${YEAR}-05-02`, `${YEAR}-05-03`]);
  assert.equal(db.prepare('SELECT content_type FROM competition_logos WHERE competition_id = ?').get(id).content_type, 'image/png');
  assert.deepEqual(db.prepare('SELECT title, filename FROM competition_files WHERE competition_id = ? ORDER BY id').all(id), [
    { title: 'Prospectus', filename: 'Prospectus.pdf' },
    { title: 'Entry form', filename: 'Entry form.xlsx' },
  ]);

  // With the logo already in, it can be published straight away.
  const publishToken = await csrfFrom(admin, `/admin/competitions/${id}/files`);
  await admin.post(`/admin/competitions/${id}/status`).type('form').send({ _csrf: publishToken, status: 'open' });
  assert.equal(db.prepare('SELECT status FROM competitions WHERE id = ?').get(id).status, 'open');

  // Without any files, the form still works as before.
  const plain = await fill(admin.post('/admin/competitions'));
  assert.equal(plain.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM competitions').get().n, 2);

  // Editing keeps its plain form and points to Logo and files.
  const edit = await admin.get(`/admin/competitions/${id}/edit`);
  assert.doesNotMatch(edit.text, /multipart/);
  assert.match(edit.text, new RegExp(`href="/admin/competitions/${id}/files">Logo and files`));
});

test('a competition needs a logo and description to open, and shows its files', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', publicUrl: 'https://gms.test' });
  const admin = request.agent(app);
  const loginToken = await csrfFrom(admin, '/login');
  await admin.post('/login').type('form').send({ _csrf: loginToken, email: 'admin@test.test', password: PASSWORD });

  const fields = {
    name: 'City Open', venue: 'Hall', event_dates: `${YEAR}-03-01`,
    registration_deadline: `${YEAR}-02-01`, registration_deadline_time: '17:00',
  };
  let _csrf = await csrfFrom(admin, '/admin/competitions/new');
  const noDescription = await admin.post('/admin/competitions').type('form').send({ _csrf, ...fields });
  assert.equal(noDescription.status, 400);
  assert.match(noDescription.text, /Enter a description/);

  const created = await admin.post('/admin/competitions').type('form').send({ _csrf, ...fields, description: 'Kyorugi only.\n\nInfo: https://gms.test/info' });
  assert.equal(created.status, 302);
  const id = Number(created.headers.location.match(/competitions\/(\d+)\/files/)[1]);
  const files = `/admin/competitions/${id}/files`;

  // Publishing without a logo is refused and leads to the upload page.
  _csrf = await csrfFrom(admin, files);
  const refused = await admin.post(`/admin/competitions/${id}/status`).type('form').send({ _csrf, status: 'open' });
  assert.equal(refused.headers.location, files);
  assert.equal(db.prepare('SELECT status FROM competitions WHERE id = ?').get(id).status, 'draft');

  const badLogo = await admin.post(`/admin/competitions/${id}/logo`).field('_csrf', _csrf).attach('logo', PDF, 'logo.pdf');
  assert.equal(badLogo.status, 400);
  assert.equal((await admin.post(`/admin/competitions/${id}/logo`).field('_csrf', _csrf).attach('logo', PNG, 'logo.png')).status, 302);

  await admin.post(`/admin/competitions/${id}/files`).field('_csrf', _csrf).field('title', 'Prospectus').attach('file', PDF, 'prospectus.pdf');
  await admin.post(`/admin/competitions/${id}/files`).field('_csrf', _csrf).attach('file', ZIP, 'Entry form.docx');
  const rejected = await admin.post(`/admin/competitions/${id}/files`).field('_csrf', _csrf).attach('file', Buffer.from('#!/bin/sh\necho hi\n'), 'run.sh');
  assert.equal(rejected.status, 400);
  assert.deepEqual(db.prepare('SELECT title, filename FROM competition_files ORDER BY id').all(), [
    { title: 'Prospectus', filename: 'prospectus.pdf' },
    { title: 'Entry form', filename: 'Entry form.docx' },
  ]);

  // Visitors can't see a draft, its logo or its files.
  const visitor = request(app);
  const fileId = db.prepare("SELECT id FROM competition_files WHERE title = 'Prospectus'").get().id;
  assert.equal((await visitor.get(`/competitions/${id}`)).status, 404);
  assert.equal((await visitor.get(`/competitions/${id}/logo`)).status, 404);
  assert.equal((await visitor.get(`/competitions/${id}/files/${fileId}`)).status, 404);

  await admin.post(`/admin/competitions/${id}/status`).type('form').send({ _csrf, status: 'open' });
  assert.equal(db.prepare('SELECT status FROM competitions WHERE id = ?').get(id).status, 'open');

  const page = await visitor.get(`/competitions/${id}`);
  assert.match(page.text, new RegExp(`<img class="comp-logo lg" src="/competitions/${id}/logo\\?v=`));
  assert.match(page.text, /<p>Kyorugi only\.<\/p>/);
  assert.match(page.text, /<a href="https:\/\/gms.test\/info"/);
  assert.match(page.text, /Prospectus<\/a>[\s\S]*PDF/);
  assert.match((await visitor.get('/')).text, /class="comp-logo md"/);

  const logo = await visitor.get(`/competitions/${id}/logo`);
  assert.equal(logo.headers['content-type'], 'image/png');
  const download = await visitor.get(`/competitions/${id}/files/${fileId}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-type'], 'application/pdf');
  assert.match(download.headers['content-disposition'], /^attachment; filename="prospectus.pdf"/);
  assert.equal((await visitor.get(`/competitions/${id + 1}/files/${fileId}`)).status, 404, 'files belong to their competition');

  await admin.post(`/admin/competitions/${id}/files/${fileId}/delete`).type('form').send({ _csrf });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM competition_files').get().n, 1);
  const actions = db.prepare("SELECT action FROM activity_log WHERE action LIKE 'competition.%' ORDER BY id").all().map((r) => r.action);
  assert.deepEqual(actions, ['competition.created', 'competition.logo', 'competition.file_added', 'competition.file_added', 'competition.status', 'competition.file_removed']);
});

test('a competition shows up to ten photos, added on creation or from Logo and files', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', publicUrl: 'https://gms.test' });
  const admin = request.agent(app);
  const loginCsrf = await csrfFrom(admin, '/login');
  await admin.post('/login').type('form').send({ _csrf: loginCsrf, email: 'admin@test.test', password: PASSWORD });

  const _csrf = await csrfFrom(admin, '/admin/competitions/new');
  const created = await admin.post('/admin/competitions')
    .field('_csrf', _csrf).field('name', 'Photo Cup').field('venue', 'Arena').field('description', 'Open.')
    .field('event_dates', `${YEAR}-05-02`).field('registration_deadline', `${YEAR}-04-01`).field('registration_deadline_time', '17:00').field('age_basis', 'year')
    .attach('logo', PNG, 'logo.png').attach('photos', PNG, 'a.png').attach('photos', PNG, 'b.png');
  assert.equal(created.status, 302);
  const id = db.prepare('SELECT id FROM competitions').get().id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM competition_photos').get().n, 2);

  const add = async (count, file = PNG, name = 'p.png') => {
    const token = await csrfFrom(admin, `/admin/competitions/${id}/files`);
    let req = admin.post(`/admin/competitions/${id}/photos`).field('_csrf', token);
    for (let i = 0; i < count; i += 1) req = req.attach('photos', file, name);
    return req;
  };
  assert.equal((await add(1, Buffer.from('MZ not a picture'), 'x.exe')).status, 400);
  assert.equal((await add(8)).status, 302);
  const full = await add(1);
  assert.equal(full.status, 400);
  assert.match(full.text, /can have 10 photos/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM competition_photos').get().n, 10);

  // A draft's photos are the admin's alone; once published, anyone sees the gallery.
  const photoId = db.prepare('SELECT id FROM competition_photos ORDER BY id').get().id;
  assert.equal((await request(app).get(`/competitions/${id}/photos/${photoId}`)).status, 404);
  db.prepare("UPDATE competitions SET status = 'open' WHERE id = ?").run(id);
  const page = (await request(app).get(`/competitions/${id}`)).text;
  assert.equal((page.match(/class="photo-grid"[\s\S]*?<\/div>/)[0].match(/<img /g) || []).length, 10);
  assert.equal((await request(app).get(`/competitions/${id}/photos/${photoId}`)).status, 200);

  const removeCsrf = await csrfFrom(admin, `/admin/competitions/${id}/files`);
  const remove = await admin.post(`/admin/competitions/${id}/photos/${photoId}/delete`).type('form').send({ _csrf: removeCsrf });
  assert.equal(remove.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM competition_photos').get().n, 9);
});
