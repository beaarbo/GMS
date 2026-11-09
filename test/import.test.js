const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const writeExcelFile = require('write-excel-file/node').default;
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureAdmin, createClub, applyToClub, approveApplication } = require('../src/services');
const { parseCsv, parseDate, readRows, previewImport, templateXlsx, ImportError } = require('../src/athleteImport');

const PASSWORD = 'test-password-123';
const TODAY = '2026-11-09';

test('dates are read from cells, serials and day-first text', () => {
  assert.equal(parseDate(new Date(Date.UTC(2012, 2, 24))), '2012-03-24');
  assert.equal(parseDate(40992), '2012-03-24');
  assert.equal(parseDate('2012-03-24'), '2012-03-24');
  assert.equal(parseDate('24/03/2012'), '2012-03-24');
  assert.equal(parseDate('4/3/2012'), '2012-03-04');
  assert.equal(parseDate('24 Mar 2012'), '2012-03-24');
  assert.equal(parseDate('31/02/2012'), null);
  assert.equal(parseDate('soon'), null);
});

test('CSV handles quotes, embedded commas, semicolons and a BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"Dela Cruz, Jr","say ""hi"""\n'), [['a', 'b'], ['Dela Cruz, Jr', 'say "hi"']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

test('preview finds the header, skips invalid rows and duplicates', () => {
  const rows = [
    ['Club roster 2026'],
    ['Surname', 'First Name', 'Sex', 'DOB', 'Belt'],
    ['Reyes', 'Ana', 'F', '2012-03-24', 'Black'],
    ['', '', '', '', ''],
    ['Cruz', 'Ben', 'male', '24/03/2011', 'blue belt'],
    ['cruz', 'ben', 'M', '2011-03-24', 'Blue'],
    ['Lim', 'Kai', 'M', '2010-01-01', 'Red'],
    ['', 'Zed', 'X', 'never', 'Green'],
  ];
  const { entries, ready } = previewImport(rows, {
    todayIso: TODAY,
    existing: [{ first_name: 'Kai', last_name: 'Lim', date_of_birth: '2010-01-01' }],
  });
  assert.deepEqual(entries.map((e) => e.row), [3, 5, 6, 7, 8]);
  assert.deepEqual(ready.map((a) => a.first_name), ['Ana', 'Ben']);
  assert.equal(entries[2].duplicate, true);
  assert.equal(entries[3].duplicate, true);
  assert.equal(entries[4].errors.length, 4);
  assert.deepEqual(ready[1], { first_name: 'Ben', last_name: 'Cruz', gender: 'M', date_of_birth: '2011-03-24', belt_rank: 1 });
});

test('preview explains a missing column or an unusable file', async () => {
  assert.throws(() => previewImport([['First name', 'Last name', 'Gender', 'Belt']], { todayIso: TODAY }), /missing these columns: Date of birth/);
  assert.throws(() => previewImport([['Name', 'Age']], { todayIso: TODAY }), /No header row/);
  await assert.rejects(readRows(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2])), (e) => e instanceof ImportError && /\.xls/.test(e.message));
  await assert.rejects(readRows(Buffer.from('PK\u0003\u0004 not really a zip')), ImportError);
});

test('the template reads back as the expected header row', async () => {
  const rows = await readRows(await templateXlsx());
  assert.deepEqual(rows[0], ['First name', 'Last name', 'Gender', 'Date of birth', 'Belt']);
});

async function csrfFrom(agent, path) {
  const page = await agent.get(path);
  return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
}

async function approvedCoach(app, email, clubName) {
  const { db } = app.locals;
  const clubId = createClub(db, { name: clubName, city: 'City' });
  const agent = request.agent(app);
  const _csrf = await csrfFrom(agent, '/register');
  await agent.post('/register').type('form').send({ _csrf, full_name: 'Coach', phone: '555', email, password: PASSWORD });
  const { id } = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  applyToClub(db, id, clubId);
  approveApplication(db, db.prepare("SELECT id FROM club_applications WHERE user_id = ?").get(id).id);
  return { agent, clubId };
}

async function upload(agent, file, name) {
  const _csrf = await csrfFrom(agent, '/club/fighters/import');
  return agent.post('/club/fighters/import').field('_csrf', _csrf).attach('sheet', file, name);
}

const htmlDecode = (s) => s.replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('a coach imports athletes from a spreadsheet after a preview', async () => {
  const db = openDb(':memory:');
  await ensureAdmin(db, 'admin@test.test', PASSWORD);
  const app = createApp({ db, sessionSecret: 'test-secret', publicUrl: 'https://gms.test' });
  const { agent, clubId } = await approvedCoach(app, 'coach@test.test', 'Tigers');
  const other = await approvedCoach(app, 'other@test.test', 'Dragons');

  const template = await agent.get('/club/fighters/import/template.xlsx');
  assert.equal(template.status, 200);
  assert.match(template.headers['content-disposition'], /athlete-import-template\.xlsx/);

  const sheet = await writeExcelFile([
    ['First name', 'Last name', 'Gender', 'Date of birth', 'Belt'],
    ['Ana', 'Reyes', 'F', { value: new Date(Date.UTC(2012, 2, 24)), type: Date, format: 'dd/mm/yyyy' }, 'Black'],
    ['Ben', 'Cruz', 'M', '24/03/2011', 'Blue'],
    ['Zed', '', 'X', '', 'Green'],
  ]).toBuffer();
  const preview = await upload(agent, sheet, 'roster.xlsx');
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Import 2 athletes/);
  assert.match(preview.text, /Last name is missing/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fighters').get().n, 0, 'preview saves nothing');

  const rows = htmlDecode(preview.text.match(/name="rows" value="([^"]*)"/)[1]);
  const _csrf = await csrfFrom(agent, '/club/fighters/import');
  const done = await agent.post('/club/fighters/import/confirm').type('form').send({ _csrf, rows });
  assert.equal(done.status, 302);
  const saved = db.prepare('SELECT club_id, first_name, date_of_birth, belt_rank FROM fighters ORDER BY first_name').all();
  assert.deepEqual(saved, [
    { club_id: clubId, first_name: 'Ana', date_of_birth: '2012-03-24', belt_rank: 3 },
    { club_id: clubId, first_name: 'Ben', date_of_birth: '2011-03-24', belt_rank: 1 },
  ]);
  const log = db.prepare("SELECT summary FROM activity_log WHERE action = 'athlete.imported'").get();
  assert.match(log.summary, /Imported 2 athletes into Tigers/);
  assert.doesNotMatch(log.summary, /2012|2011/, 'no dates of birth in the activity log');

  // Submitting the same rows again adds nobody.
  await agent.post('/club/fighters/import/confirm').type('form').send({ _csrf, rows });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fighters').get().n, 2);

  // Tampered rows are checked again, and another club's import lands in its own club.
  const tampered = JSON.stringify([{ first_name: 'Hack', last_name: 'Er', gender: 'Q', date_of_birth: '2012-01-01', belt_rank: 9 }]);
  const otherCsrf = await csrfFrom(other.agent, '/club/fighters/import');
  await other.agent.post('/club/fighters/import/confirm').type('form').send({ _csrf: otherCsrf, rows: tampered });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fighters WHERE first_name = 'Hack'").get().n, 0);

  const csv = Buffer.from('Last name,First name,Gender,Date of birth,Belt\r\nReyes,Ana,F,2012-03-24,Black\r\n');
  const otherPreview = await upload(other.agent, csv, 'roster.csv');
  assert.match(otherPreview.text, /Import 1 athlete</, 'a different club can have an athlete with the same name');

  const bad = await upload(agent, Buffer.from('Name,Age\nAna,12\n'), 'roster.csv');
  assert.equal(bad.status, 400);
  assert.match(bad.text, /No header row found/);
});
