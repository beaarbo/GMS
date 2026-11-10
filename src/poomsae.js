// Pure poomsae logic: no database or web dependencies. Divisions are event +
// gender + age group + belt group; there are no weight classes.

const { competitionAge, findAgeGroup, findBeltGroup, beltName } = require('./divisions');

const EVENT_TYPES = { kyorugi: 'Kyorugi', poomsae: 'Poomsae', both: 'Kyorugi and poomsae' };

const POOMSAE_EVENTS = {
  individual: { label: 'Individual', size: 1 },
  pair: { label: 'Pair', size: 2 },
  team: { label: 'Team', size: 3 },
};

// Pairs and teams of boys and girls together are "Mixed".
const POOMSAE_GENDERS = { M: 'Male', F: 'Female', X: 'Mixed' };

const MAX_SCORE = 10;

// Poomsae has its own age groups, by age and then belt, with no weight. The
// adult brackets follow World Taekwondo poomsae: Under 30, Under 40 and so on.
// Admins can edit them per competition in Division setup.
const DEFAULT_POOMSAE_AGE_GROUPS = [
  { name: 'Kids (U12)', min_age: 6, max_age: 11 },
  { name: 'Cadet (U15)', min_age: 12, max_age: 14 },
  { name: 'Junior (U18)', min_age: 15, max_age: 17 },
  { name: 'Senior (U30)', min_age: 18, max_age: 30 },
  { name: 'U40', min_age: 31, max_age: 40 },
  { name: 'U50', min_age: 41, max_age: 50 },
  { name: 'U60', min_age: 51, max_age: 60 },
  { name: 'U65', min_age: 61, max_age: 65 },
  { name: 'Over 65', min_age: 66, max_age: 99 },
];

// Every group needs a name and a valid range, and no age may fit two groups.
function validatePoomsaeAgeGroups(groups) {
  const errors = [];
  if (groups.length === 0) errors.push('Add at least one poomsae age group.');
  groups.forEach((g) => {
    if (!g.name) errors.push('Every poomsae age group needs a name.');
    if (!Number.isInteger(g.min_age) || !Number.isInteger(g.max_age) || g.min_age < 0 || g.min_age > g.max_age) {
      errors.push(`Poomsae ${g.name || 'age group'}: enter a valid age range.`);
    }
  });
  const sorted = [...groups].sort((a, b) => a.min_age - b.min_age);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].min_age <= sorted[i - 1].max_age) errors.push(`Poomsae age groups ${sorted[i - 1].name} and ${sorted[i].name} overlap.`);
  }
  return errors;
}

const hasKyorugi = (competition) => competition.events !== 'poomsae';
const hasPoomsae = (competition) => competition.events === 'poomsae' || competition.events === 'both';

// Places an entry of one to three athletes. A pair or team goes by its oldest
// member's age and highest belt, so nobody competes below their level.
function placeEntry({ event, members, competition, ageGroups, beltGroups }) {
  const spec = POOMSAE_EVENTS[event];
  if (!spec) return { ok: false, error: 'Choose individual, pair or team.' };
  if (members.length !== spec.size || new Set(members.map((m) => m.id)).size !== spec.size) {
    return { ok: false, error: spec.size === 1 ? 'Choose an athlete.' : `Choose ${spec.size} different athletes.` };
  }
  const ages = members.map((m) => competitionAge(m.date_of_birth, competition.event_date, competition.age_basis));
  const age = Math.max(...ages);
  const ageGroup = findAgeGroup(ageGroups, age);
  if (!ageGroup) return { ok: false, error: `No age group for age ${age}.` };
  const rank = Math.max(...members.map((m) => m.belt_rank));
  const beltGroup = findBeltGroup(beltGroups, rank);
  if (!beltGroup) return { ok: false, error: `No belt group for ${beltName(rank)} belt.` };
  const genders = new Set(members.map((m) => m.gender));
  const gender = genders.size === 1 ? members[0].gender : 'X';
  return { ok: true, ages, ageGroup, beltGroup, gender };
}

// "Pair · Mixed · Junior · Black Belt"
function poomsaeDivisionTitle(entry) {
  return [POOMSAE_EVENTS[entry.event].label, POOMSAE_GENDERS[entry.gender], entry.age_group, entry.belt_group].join(' · ');
}

// A judges' average such as "7.85". Blank clears the score. Up to three decimals.
function parseScore(text) {
  const value = String(text ?? '').trim().replace(',', '.');
  if (value === '') return { ok: true, score: null };
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(value) || Number(value) > MAX_SCORE) {
    return { ok: false, error: `Enter a score from 0 to ${MAX_SCORE}, such as 7.85.` };
  }
  return { ok: true, score: Number(value) };
}

// 7.85 → "7.85", 8 → "8.00", 7.855 → "7.855".
function formatScore(score) {
  const long = score.toFixed(3);
  return long.endsWith('0') ? score.toFixed(2) : long;
}

// 1 → "1st", 3 → "3rd", 11 → "11th".
function placeText(place) {
  const teen = place % 100 >= 11 && place % 100 <= 13;
  return `${place}${(!teen && ['st', 'nd', 'rd'][(place % 10) - 1]) || 'th'}`;
}

// Highest score first. Equal scores share a place, and the next place is skipped
// (8.1, 8.1, 7.9 → 1, 1, 3). Entries without a score come last, unplaced.
// shortcut: no tie-break on presentation score, add one if the rules need it.
function rankEntries(entries) {
  const scored = entries.filter((e) => e.score !== null).sort((a, b) => b.score - a.score);
  let place = 0;
  return [
    ...scored.map((e, i) => {
      if (i === 0 || e.score !== scored[i - 1].score) place = i + 1;
      return { ...e, place };
    }),
    ...entries.filter((e) => e.score === null).map((e) => ({ ...e, place: null })),
  ];
}

module.exports = {
  EVENT_TYPES,
  POOMSAE_EVENTS,
  POOMSAE_GENDERS,
  MAX_SCORE,
  DEFAULT_POOMSAE_AGE_GROUPS,
  validatePoomsaeAgeGroups,
  hasKyorugi,
  hasPoomsae,
  placeEntry,
  poomsaeDivisionTitle,
  parseScore,
  formatScore,
  placeText,
  rankEntries,
};
