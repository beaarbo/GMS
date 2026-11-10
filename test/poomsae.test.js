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

const { divisionMode, bracketEntrants, poomsaeMedalists, entryResult } = require('../src/poomsae');

test('a cut competition scores large divisions first and sends small ones straight to the bracket', () => {
  const cut = { poomsae_format: 'cut', poomsae_cut: 16 };
  assert.equal(divisionMode(cut, 30), 'cut');
  assert.equal(divisionMode(cut, 16), 'bracket');
  assert.equal(divisionMode({ poomsae_format: 'elimination', poomsae_cut: 16 }, 30), 'bracket');
  assert.equal(divisionMode({ poomsae_format: 'score', poomsae_cut: 16 }, 30), 'score');
});

test('the top entries go into the bracket once everyone is scored and nobody ties at the cut line', () => {
  const competition = { poomsae_format: 'cut', poomsae_cut: 2 };
  const ranked = (scores) => rankEntries(scores.map((score, i) => ({ id: i + 1, score })));
  assert.match(bracketEntrants(competition, ranked([8, null, 7])).error, /1 still need a score/);
  assert.match(bracketEntrants(competition, ranked([8.5, 7, 7])).error, /tied on 7.00 at the cut line for the top 2/);
  const draw = bracketEntrants(competition, ranked([7.2, 8.5, 7]));
  assert.deepEqual([draw.ok, draw.seeded, draw.entrants.map((e) => e.id)], [true, true, [2, 1]]);
  assert.equal(bracketEntrants({ poomsae_format: 'elimination', poomsae_cut: 16 }, ranked([null, null])).seeded, false);
});

test('ranked divisions give medals by place, and brackets by the final and semifinals', () => {
  const ranked = rankEntries([{ id: 1, score: 8 }, { id: 2, score: 8 }, { id: 3, score: 7 }, { id: 4, score: 6 }]);
  assert.deepEqual(poomsaeMedalists('score', ranked, null), { gold: [1, 2], silver: [], bronze: [3] });
  const side = (id) => ({ registrationId: id });
  const bouts = [
    { round: 1, totalRounds: 2, position: 0, isBye: false, blue: side(1), red: side(4), winner: side(1) },
    { round: 1, totalRounds: 2, position: 1, isBye: false, blue: side(2), red: side(3), winner: side(3) },
    { round: 2, totalRounds: 2, position: 0, isBye: false, blue: side(1), red: side(3), winner: side(3), number: 3 },
  ];
  const medals = poomsaeMedalists('bracket', [], bouts);
  assert.deepEqual(medals, { gold: [3], silver: [1], bronze: [4, 2] });
  const division = { mode: 'cut', cut: 2, bouts, medalists: medals };
  assert.equal(entryResult({ id: 3, status: 'approved', score: 8, place: 1 }, division), 'Gold');
  assert.equal(entryResult({ id: 9, status: 'approved', score: 5, place: 9 }, division), 'Not in the top 2 (9th · 5.00)');
});

const { schedulePoomsae } = require('../src/poomsae');

test('brackets are timed in draw order on the court free soonest, keeping each entry\'s rest', () => {
  // A bracket of four: two semifinals, then the final. A bracket of two: one bout.
  const four = (key, base) => ({ key, day: null, bouts: [
    { id: base + 1, round: 1, position: 0, isBye: false },
    { id: base + 2, round: 1, position: 1, isBye: false },
    { id: base + 3, round: 2, position: 0, isBye: false },
  ] });
  const two = (key, id) => ({ key, day: null, bouts: [{ id, round: 1, position: 0, isBye: false }] });
  const options = { days: 2, courts: 2, start: 540, minutes: 5, rest: 10 };
  const { places, slots } = schedulePoomsae([four('a', 0), two('b', 10), two('c', 20)], options);
  assert.deepEqual(places.get('a'), { day: 1, court: 1 });
  assert.deepEqual([1, 2, 3].map((id) => slots.get(id)), [{ number: 1, start: 540 }, { number: 2, start: 545 }, { number: 3, start: 560 }], 'the final waits for rest');
  assert.deepEqual(places.get('b'), { day: 2, court: 1 }, 'the day with less poomsae');
  assert.deepEqual(places.get('c'), { day: 2, court: 2 }, 'the court free soonest');

  // Drawing another bracket later never moves the ones already timed.
  const later = schedulePoomsae([four('a', 0), two('b', 10), two('c', 20), four('d', 30)], options);
  [1, 2, 3, 11, 21].forEach((id) => assert.deepEqual(later.slots.get(id), slots.get(id)));

  // A pinned day is kept, and a lone entry gets a day but no court.
  const pinned = schedulePoomsae([{ ...two('e', 40), day: 2 }, { key: 'f', day: null, bouts: [{ id: 50, round: 1, position: 0, isBye: true }] }], options);
  assert.deepEqual([pinned.places.get('e'), pinned.places.get('f')], [{ day: 2, court: 1 }, { day: 1, court: null }]);
});
