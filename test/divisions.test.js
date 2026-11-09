const test = require('node:test');
const assert = require('node:assert');
const {
  BELTS,
  competitionAge,
  formatEventDates,
  formatDay,
  parseWeightLimits,
  findWeightClass,
  findBeltGroup,
  assignDivision,
  divisionOptions,
  validateSetup,
  isValidDate,
  DEFAULT_AGE_GROUPS,
  DEFAULT_BELT_GROUPS,
  checkWeight,
} = require('../src/divisions');

test('a weigh-in reading is checked against the entered class', () => {
  const classes = [
    { id: 1, label: '-45 kg', max_kg: 45 },
    { id: 2, label: '-48 kg', max_kg: 48 },
    { id: 3, label: '+48 kg', max_kg: null },
  ];
  assert.deepEqual(checkWeight(classes, 2, '48'), { ok: true, fits: classes[1], made: true }, 'the limit itself makes weight');
  assert.equal(checkWeight(classes, 2, '45.0').made, false, 'lighter than the class still fails it');
  assert.equal(checkWeight(classes, 2, '45.0').fits.id, 1);
  assert.equal(checkWeight(classes, 2, '48.04').fits.id, 2, 'readings round to 0.1 kg');
  assert.equal(checkWeight(classes, 2, '48.1').fits.id, 3);
  assert.equal(checkWeight(classes, 2, 'heavy').ok, false);
  assert.equal(checkWeight(classes, 2, '300').ok, false);
});

test('competitionAge by birth year ignores the birthday', () => {
  assert.equal(competitionAge('2010-12-31', '2026-01-15', 'year'), 16);
});

test('competitionAge by date counts completed years', () => {
  assert.equal(competitionAge('2010-12-31', '2026-01-15', 'date'), 15);
  assert.equal(competitionAge('2010-01-15', '2026-01-15', 'date'), 16);
});

test('weight limits are inclusive and heavier fighters fall into the open class', () => {
  const { classes, errors } = parseWeightLimits('-45,-48,+48');
  assert.deepEqual(errors, []);
  assert.equal(findWeightClass(classes, 45).label, '-45 kg');
  assert.equal(findWeightClass(classes, 45.1).label, '-48 kg');
  assert.equal(findWeightClass(classes, 48).label, '-48 kg');
  assert.equal(findWeightClass(classes, 48.1).label, '+48 kg');
});

test('without an open class, a heavier fighter has no class', () => {
  const { classes } = parseWeightLimits('-45,-48');
  assert.equal(findWeightClass(classes, 50), null);
});

test('invalid weight limits are reported', () => {
  assert.ok(parseWeightLimits('45').errors.length > 0, 'missing sign');
  assert.ok(parseWeightLimits('-48,-45').errors.length > 0, 'not increasing');
  assert.ok(parseWeightLimits('-45,+50').errors.length > 0, 'open class mismatch');
  assert.ok(parseWeightLimits('-45,+45,-50').errors.length > 0, 'open class not last');
});

test('the default template is valid with exactly Blue, Red and Black belt groups', () => {
  assert.deepEqual(validateSetup({ ageGroups: DEFAULT_AGE_GROUPS, beltGroups: DEFAULT_BELT_GROUPS }), []);
  assert.deepEqual(BELTS.map((b) => findBeltGroup(DEFAULT_BELT_GROUPS, b.rank).name), ['Blue Belt', 'Red Belt', 'Black Belt']);
});

test('overlapping age and belt groups are rejected', () => {
  const errors = validateSetup({
    ageGroups: [
      { name: 'A', min_age: 10, max_age: 14, male: '-40,+40', female: '-40,+40' },
      { name: 'B', min_age: 14, max_age: 17, male: '-40,+40', female: '-40,+40' },
    ],
    beltGroups: [
      { name: 'X', min_rank: 1, max_rank: 5 },
      { name: 'Y', min_rank: 5, max_rank: 9 },
    ],
  });
  assert.ok(errors.some((e) => e.includes('A and B overlap')));
  assert.ok(errors.some((e) => e.includes('X and Y overlap')));
});

test('assignDivision only accepts a weight class for the fighter\'s age and gender', () => {
  const setup = {
    ageGroups: [{ id: 1, name: 'Junior', min_age: 15, max_age: 17 }],
    beltGroups: [{ id: 1, name: 'Black', min_rank: 9, max_rank: 9 }],
    weightClasses: [
      { id: 1, age_group_id: 1, gender: 'M', label: '-55 kg', max_kg: 55 },
      { id: 2, age_group_id: 1, gender: 'F', label: '-49 kg', max_kg: 49 },
      { id: 3, age_group_id: 1, gender: 'F', label: '+49 kg', max_kg: null },
      { id: 4, age_group_id: 2, gender: 'F', label: '-30 kg', max_kg: 30 },
    ],
  };
  const competition = { event_date: '2026-06-01', age_basis: 'year' };
  const place = (fighter, weightClassId) => assignDivision({ fighter, weightClassId, competition, ...setup });
  const girl = { gender: 'F', date_of_birth: '2010-01-01', belt_rank: 9 };

  assert.equal(place(girl, 3).weightClass.label, '+49 kg');
  assert.equal(place(girl, '2').weightClass.label, '-49 kg');
  assert.match(place(girl, 1).error, /Select a weight class/, 'another gender');
  assert.match(place(girl, 4).error, /Select a weight class/, 'another age group');
  assert.match(place(girl, '').error, /Select a weight class/);

  assert.match(place({ ...girl, date_of_birth: '2000-01-01' }, 3).error, /No age group/);
  assert.match(place({ ...girl, belt_rank: 1 }, 3).error, /No belt group/);
  assert.deepEqual(
    divisionOptions({ fighter: girl, competition, ...setup }).classes.map((c) => c.label),
    ['-49 kg', '+49 kg']
  );
});

test('isValidDate rejects impossible dates', () => {
  assert.equal(isValidDate('2026-02-28'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('28/02/2026'), false);
});

test('event dates read naturally', () => {
  assert.equal(formatEventDates(['2027-02-06']), '6 Feb 2027');
  assert.equal(formatEventDates(['2027-02-06', '2027-02-07']), '6-7 Feb 2027');
  assert.equal(formatEventDates(['2027-02-06', '2027-02-07', '2027-02-13', '2027-02-14']), '6-7 & 13-14 Feb 2027');
  assert.equal(formatEventDates(['2027-01-30', '2027-01-31', '2027-02-06', '2027-02-07']), '30-31 Jan & 6-7 Feb 2027');
  assert.equal(formatEventDates(['2026-12-31', '2027-01-01']), '31 Dec 2026 & 1 Jan 2027');
  assert.equal(formatEventDates(['2027-02-01', '2027-02-03', '2027-02-05']), '1, 3 & 5 Feb 2027');
});

test('a single day is labelled with its weekday', () => {
  assert.equal(formatDay('2027-02-13'), 'Sat 13 Feb');
});
