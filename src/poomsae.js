// Pure poomsae logic: no database or web dependencies. Divisions are event +
// gender + age group + belt group; there are no weight classes.

const { competitionAge, findAgeGroup, findBeltGroup, beltName } = require('./divisions');
const { divisionMedalists, scheduleCourt } = require('./bracket');

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

// The designated poomsae each age group draws from, after World Taekwondo's
// recognised poomsae (Kids is a local list). Each competition keeps its own
// copy, which the admin can edit on the Divisions page; a group whose name
// isn't here starts with an empty list.
const DESIGNATED_POOMSAE = {
  'Kids (U12)': ['Taegeuk 1', 'Taegeuk 2', 'Taegeuk 3', 'Taegeuk 4', 'Taegeuk 5', 'Taegeuk 6', 'Taegeuk 7', 'Taegeuk 8'],
  'Cadet (U15)': ['Taegeuk 4', 'Taegeuk 5', 'Taegeuk 6', 'Taegeuk 7', 'Taegeuk 8', 'Koryo', 'Keumgang', 'Taebaek'],
  'Junior (U18)': ['Taegeuk 4', 'Taegeuk 5', 'Taegeuk 6', 'Taegeuk 7', 'Taegeuk 8', 'Koryo', 'Keumgang', 'Taebaek', 'Pyongwon', 'Sipjin'],
  'Senior (U30)': ['Taegeuk 6', 'Taegeuk 7', 'Taegeuk 8', 'Koryo', 'Keumgang', 'Taebaek', 'Pyongwon', 'Sipjin', 'Jitae'],
  U40: ['Taegeuk 6', 'Taegeuk 7', 'Taegeuk 8', 'Koryo', 'Keumgang', 'Taebaek', 'Pyongwon', 'Sipjin', 'Jitae', 'Chonkwon'],
  U50: ['Taegeuk 8', 'Koryo', 'Keumgang', 'Taebaek', 'Pyongwon', 'Sipjin', 'Jitae', 'Chonkwon', 'Hansu'],
  U60: ['Koryo', 'Keumgang', 'Taebaek', 'Pyongwon', 'Sipjin', 'Jitae', 'Chonkwon', 'Hansu'],
  U65: ['Koryo', 'Keumgang', 'Taebaek', 'Pyongwon', 'Sipjin', 'Jitae', 'Chonkwon', 'Hansu'],
  'Over 65': ['Koryo', 'Keumgang', 'Taebaek', 'Pyongwon', 'Sipjin', 'Jitae', 'Chonkwon', 'Hansu'],
};
const MAX_DESIGNATED = 30;
const POOMSAE_PER_DRAW = 2;

const defaultDesignated = (name) => [...(DESIGNATED_POOMSAE[name] || [])];

// A typed list (one per line, or separated by commas) to clean names: trimmed,
// each at most 40 characters, no repeats (ignoring case), at most 30.
function parseDesignated(text) {
  const seen = new Set();
  return String(text || '')
    .split(/[\n,]/)
    .map((name) => name.trim().replace(/\s+/g, ' ').slice(0, 40))
    .filter((name) => name && !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase()))
    .slice(0, MAX_DESIGNATED);
}

// Two different poomsae from the list at random, kept in the list's order so the
// easier one comes first. randomInt(n) gives 0..n-1 (crypto.randomInt in use).
function pickPoomsae(list, randomInt) {
  if (list.length < POOMSAE_PER_DRAW) return null;
  const pool = list.map((name, i) => ({ name, i }));
  const picked = [];
  while (picked.length < POOMSAE_PER_DRAW) picked.push(...pool.splice(randomInt(pool.length), 1));
  return picked.sort((a, b) => a.i - b.i).map((p) => p.name);
}

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

// How poomsae divisions are decided. 'cut': a score round first when a
// division has more entries than poomsae_cut, then the top ones go into a
// bracket; smaller divisions go straight to the bracket.
const POOMSAE_FORMATS = {
  score: 'Ranked by score',
  elimination: 'Single elimination',
  cut: 'Score round, then single elimination',
};
const MAX_CUT = 64;

// What a division runs, from the format and its number of approved entries.
// 'score': ranked only. 'bracket': straight to the bracket. 'cut': a score round, then the bracket.
function divisionMode(competition, approvedCount) {
  if (competition.poomsae_format === 'elimination') return 'bracket';
  if (competition.poomsae_format === 'cut') return approvedCount > competition.poomsae_cut ? 'cut' : 'bracket';
  return 'score';
}

// Who goes into a division's bracket. `ranked` are its approved entries from
// rankEntries. A cut needs every entry scored and no tie across the cut line.
// Returns { ok, error?, entrants, seeded }: seeded entrants keep their rank as seed.
function bracketEntrants(competition, ranked) {
  const mode = divisionMode(competition, ranked.length);
  if (mode === 'score') return { ok: false, error: 'This competition ranks poomsae by score only.' };
  if (ranked.length === 0) return { ok: false, error: 'There are no approved entries in this division.' };
  if (mode === 'bracket') return { ok: true, entrants: ranked, seeded: false };
  const cut = competition.poomsae_cut;
  const unscored = ranked.filter((e) => e.score === null).length;
  if (unscored > 0) return { ok: false, error: `Score every entry first: ${unscored} still need a score.` };
  if (ranked[cut - 1].score === ranked[cut].score) {
    return { ok: false, error: `Entries tied on ${formatScore(ranked[cut].score)} at the cut line for the top ${cut}. Break the tie by correcting a score.` };
  }
  return { ok: true, entrants: ranked.slice(0, cut), seeded: true };
}

// Medal winners' entry ids. Ranked divisions give places 1, 2 and 3 (ties
// share). Bracket divisions follow kyorugi: final for gold and silver, and both
// losing semifinalists get bronze; an entry alone in a bracket gets none.
function poomsaeMedalists(mode, ranked, bouts) {
  if (mode === 'score') {
    const at = (place) => ranked.filter((e) => e.place === place).map((e) => e.id);
    return { gold: at(1), silver: at(2), bronze: at(3) };
  }
  if (!bouts) return { gold: [], silver: [], bronze: [] };
  const m = divisionMedalists({ bouts });
  const ids = (list) => list.filter(Boolean).map((s) => s.registrationId);
  return { gold: ids([m.gold]), silver: ids([m.silver]), bronze: ids(m.bronze) };
}

// Club medal table across divisions, ranked gold, then silver, then bronze.
function poomsaeMedalTable(divisions) {
  const clubs = new Map();
  divisions.forEach((d) => {
    const byId = new Map(d.entries.map((e) => [e.id, e]));
    ['gold', 'silver', 'bronze'].forEach((medal) => d.medalists[medal].forEach((id) => {
      const entry = byId.get(id);
      if (!clubs.has(entry.club_id)) clubs.set(entry.club_id, { clubId: entry.club_id, club: entry.club_name, gold: 0, silver: 0, bronze: 0 });
      clubs.get(entry.club_id)[medal] += 1;
    }));
  });
  return [...clubs.values()].sort((a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || a.club.localeCompare(b.club));
}

// How an entry stands, in a few words, for its coach.
function entryResult(entry, division) {
  if (entry.status !== 'approved') return '';
  const medal = ['gold', 'silver', 'bronze'].find((m) => division.medalists[m].includes(entry.id));
  if (medal) return `${medal[0].toUpperCase()}${medal.slice(1)}`;
  const scoreText = entry.score === null ? '' : `${placeText(entry.place)} · ${formatScore(entry.score)}`;
  if (division.mode === 'score') return scoreText;
  if (division.bouts) {
    const inBracket = division.bouts.some((b) => [b.blue, b.red].some((s) => s && s.registrationId === entry.id));
    if (!inBracket) return `Not in the top ${division.cut}${scoreText ? ` (${scoreText})` : ''}`;
    const lost = division.bouts.find((b) => b.winner && b.winner.registrationId !== entry.id && [b.blue, b.red].some((s) => s && s.registrationId === entry.id));
    if (lost) return `Out in Bout ${lost.number}`;
    const lone = division.bouts.length === 1 && division.bouts[0].isBye;
    return lone ? 'No opponent' : 'In the bracket';
  }
  return division.mode === 'cut' ? (scoreText ? `Score round: ${scoreText}` : 'Score round') : 'Waiting for the draw';
}

// Gives each bracket or performance list a day and court and times it. `units`
// are in the order they were made, each { key, day (pinned, or null), and
// either bouts (a bracket) or list (performer ids in order, one slot each) }.
// Each goes after what is already on the court that's free soonest on its day,
// so a later one never moves times already given out. Unpinned units take the
// day with the least poomsae so far. Bout numbering runs on per court and day,
// as in kyorugi; performers aren't numbered. Returns { places: key → { day,
// court }, slots: id → { number, start } } with start in minutes after midnight.
function schedulePoomsae(units, { days, courts, start, minutes, rest }) {
  const courtsAt = new Map();
  const dayLoad = Array(days + 1).fill(0);
  const places = new Map();
  const slots = new Map();
  units.forEach((d) => {
    const fights = d.list ? d.list.length : d.bouts.filter((b) => !b.isBye).length;
    let day = Number.isInteger(d.day) && d.day >= 1 && d.day <= days ? d.day : null;
    if (!day) {
      day = 1;
      for (let i = 2; i <= days; i += 1) if (dayLoad[i] < dayLoad[day]) day = i;
    }
    if (fights === 0) {
      places.set(d.key, { day, court: null });
      return;
    }
    const at = (court) => courtsAt.get(`${day}:${court}`) || { clock: start, count: 0 };
    let court = 1;
    for (let c = 2; c <= courts; c += 1) if (at(c).clock < at(court).clock) court = c;
    const free = at(court);
    if (d.list) {
      d.list.forEach((id, i) => slots.set(id, { number: null, start: free.clock + i * minutes }));
      courtsAt.set(`${day}:${court}`, { clock: free.clock + d.list.length * minutes, count: free.count });
      dayLoad[day] += fights * minutes;
      places.set(d.key, { day, court });
      return;
    }
    const times = scheduleCourt([d.bouts], { start: free.clock, minutes, rest });
    let end = free.clock;
    times.forEach((slot, id) => {
      slots.set(id, { number: free.count + slot.number, start: slot.start });
      end = Math.max(end, slot.start + minutes);
    });
    courtsAt.set(`${day}:${court}`, { clock: end, count: free.count + times.size });
    dayLoad[day] += fights * minutes;
    places.set(d.key, { day, court });
  });
  return { places, slots };
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

// How many judges score each performance. One means the official enters the final score.
const JUDGE_COUNTS = [1, 3, 5, 7];

// The final score from the judges' marks: with five or more judges the highest
// and lowest marks are dropped, as World Taekwondo does, then the rest are
// averaged to three decimals.
function judgesScore(marks) {
  const sorted = [...marks].sort((a, b) => a - b);
  const counted = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
  return Math.round((counted.reduce((sum, m) => sum + m, 0) / counted.length) * 1000) / 1000;
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
  DESIGNATED_POOMSAE,
  POOMSAE_PER_DRAW,
  defaultDesignated,
  parseDesignated,
  pickPoomsae,
  validatePoomsaeAgeGroups,
  POOMSAE_FORMATS,
  MAX_CUT,
  divisionMode,
  bracketEntrants,
  poomsaeMedalists,
  poomsaeMedalTable,
  schedulePoomsae,
  entryResult,
  hasKyorugi,
  hasPoomsae,
  placeEntry,
  poomsaeDivisionTitle,
  JUDGE_COUNTS,
  judgesScore,
  parseScore,
  formatScore,
  placeText,
  rankEntries,
};
