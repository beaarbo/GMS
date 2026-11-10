const test = require('node:test');
const assert = require('node:assert');
const { placeEntry, rankEntries, parseScore, formatScore, placeText } = require('../src/poomsae');

const competition = { event_date: '2030-06-01', age_basis: 'year' };
const ageGroups = [
  { id: 1, name: 'Cadet', min_age: 12, max_age: 14 },
  { id: 2, name: 'Junior', min_age: 15, max_age: 17 },
];
const beltGroups = [
  { id: 10, name: 'Blue Belt', min_rank: 1, max_rank: 1 },
  { id: 11, name: 'Red Belt', min_rank: 2, max_rank: 2 },
  { id: 12, name: 'Black Belt', min_rank: 3, max_rank: 3 },
];
const athlete = (id, gender, birthYear, belt) => ({ id, gender, date_of_birth: `${birthYear}-05-05`, belt_rank: belt });

test('a pair is placed by its oldest athlete and highest belt, and boys with girls are mixed', () => {
  const placed = placeEntry({ event: 'pair', members: [athlete(1, 'M', 2017, 1), athlete(2, 'F', 2014, 3)], competition, ageGroups, beltGroups });
  assert.equal(placed.ok, true);
  assert.equal(placed.gender, 'X');
  assert.equal(placed.ageGroup.name, 'Junior');
  assert.equal(placed.beltGroup.name, 'Black Belt');
  assert.deepEqual(placed.ages, [13, 16]);
});

test('entries need the right number of different athletes in an age group', () => {
  const a = athlete(1, 'F', 2016, 2);
  assert.equal(placeEntry({ event: 'individual', members: [a], competition, ageGroups, beltGroups }).gender, 'F');
  assert.equal(placeEntry({ event: 'team', members: [a, a, athlete(2, 'F', 2016, 2)], competition, ageGroups, beltGroups }).ok, false);
  assert.equal(placeEntry({ event: 'pair', members: [a], competition, ageGroups, beltGroups }).ok, false);
  assert.match(placeEntry({ event: 'individual', members: [athlete(3, 'M', 2025, 1)], competition, ageGroups, beltGroups }).error, /No age group for age 5/);
  assert.equal(placeEntry({ event: 'relay', members: [a], competition, ageGroups, beltGroups }).ok, false);
});

test('equal scores share a place and unscored entries stay unplaced', () => {
  const ranked = rankEntries([
    { id: 1, score: 7.9 }, { id: 2, score: null }, { id: 3, score: 8.1 }, { id: 4, score: 8.1 }, { id: 5, score: 7.2 },
  ]);
  assert.deepEqual(ranked.map((e) => [e.id, e.place]), [[3, 1], [4, 1], [1, 3], [5, 4], [2, null]]);
});

test('scores are 0 to 10 with up to three decimals, and blank clears', () => {
  assert.deepEqual(parseScore('7.85'), { ok: true, score: 7.85 });
  assert.deepEqual(parseScore(' 8,2 '), { ok: true, score: 8.2 });
  assert.deepEqual(parseScore(''), { ok: true, score: null });
  ['10.01', '11', '-1', 'abc', '7.8555', '1e1'].forEach((bad) => assert.equal(parseScore(bad).ok, false, bad));
  assert.equal(formatScore(7.85), '7.85');
  assert.equal(formatScore(8), '8.00');
  assert.equal(formatScore(7.855), '7.855');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(placeText), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
});
