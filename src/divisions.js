// Pure kyorugi division logic: no database or web dependencies.

const BELTS = [
  { rank: 1, name: 'Blue' },
  { rank: 2, name: 'Red' },
  { rank: 3, name: 'Black' },
];

const GENDERS = { M: 'Male', F: 'Female' };

// Default template applied to each new competition. Admins can edit it per
// competition, except belt groups, which are fixed. Cadet, junior and senior
// limits follow World Taekwondo classes; the Kids limits are placeholders.
const DEFAULT_AGE_GROUPS = [
  { name: 'Kids', min_age: 6, max_age: 11, male: '-22,-26,-30,-34,-38,-42,+42', female: '-22,-26,-30,-34,-38,-42,+42' },
  { name: 'Cadet', min_age: 12, max_age: 14, male: '-33,-37,-41,-45,-49,-53,-57,-61,-65,+65', female: '-29,-33,-37,-41,-44,-47,-51,-55,-59,+59' },
  { name: 'Junior', min_age: 15, max_age: 17, male: '-45,-48,-51,-55,-59,-63,-68,-73,-78,+78', female: '-42,-44,-46,-49,-52,-55,-59,-63,-68,+68' },
  { name: 'Senior', min_age: 18, max_age: 99, male: '-54,-58,-63,-68,-74,-80,-87,+87', female: '-46,-49,-53,-57,-62,-67,-73,+73' },
];

const DEFAULT_BELT_GROUPS = [
  { name: 'Blue Belt', min_rank: 1, max_rank: 1 },
  { name: 'Red Belt', min_rank: 2, max_rank: 2 },
  { name: 'Black Belt', min_rank: 3, max_rank: 3 },
];

function beltName(rank) {
  const belt = BELTS.find((b) => b.rank === Number(rank));
  return belt ? belt.name : 'Unknown';
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function utcDate(value) {
  return new Date(`${value}T00:00:00Z`);
}

// "Sat 13 Feb", for labelling one day of a competition.
function formatDay(value) {
  const date = utcDate(value);
  const part = (options) => date.toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
  return `${part({ weekday: 'short' })} ${date.getUTCDate()} ${part({ month: 'short' })}`;
}

// Summarises sorted dates, for example "6-7 & 13-14 Feb 2027" for two weekends.
function formatEventDates(dates) {
  const months = [];
  dates.forEach((value) => {
    const date = utcDate(value);
    const key = value.slice(0, 7);
    let month = months[months.length - 1];
    if (!month || month.key !== key) {
      month = { key, year: date.getUTCFullYear(), name: date.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }), runs: [] };
      months.push(month);
    }
    const run = month.runs[month.runs.length - 1];
    const day = date.getUTCDate();
    if (run && run.last === day - 1) run.last = day;
    else month.runs.push({ first: day, last: day });
  });

  const joinParts = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`);
  return joinParts(
    months.map((month, i) => {
      const days = joinParts(month.runs.map((r) => (r.first === r.last ? `${r.first}` : `${r.first}-${r.last}`)));
      const showYear = i === months.length - 1 || months[i + 1].year !== month.year;
      return `${days} ${month.name}${showYear ? ` ${month.year}` : ''}`;
    })
  );
}

// basis 'year': competition year minus birth year (the World Taekwondo method).
// basis 'date': exact age in completed years on the first day of the event.
function competitionAge(dateOfBirth, eventDate, basis = 'year') {
  const birthYear = Number(dateOfBirth.slice(0, 4));
  const eventYear = Number(eventDate.slice(0, 4));
  const age = eventYear - birthYear;
  if (basis === 'year') return age;
  return eventDate.slice(5) < dateOfBirth.slice(5) ? age - 1 : age;
}

// Turns "-45, -48, +48" into ordered classes. "-45" means up to and including
// 45 kg; "+48" is the open class above the last limit.
function parseWeightLimits(text) {
  const tokens = String(text || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const classes = [];
  const errors = [];
  let lastMax = 0;

  tokens.forEach((token, index) => {
    const match = token.match(/^([-+])\s*(\d+(?:\.\d+)?)$/);
    if (!match) {
      errors.push(`"${token}" is not a valid limit. Use a format like -45 or +78.`);
      return;
    }
    const value = Number(match[2]);
    if (match[1] === '+') {
      if (index !== tokens.length - 1) errors.push(`The open class "${token}" must come last.`);
      if (value !== lastMax) errors.push(`The open class "${token}" must match the last limit (${lastMax} kg).`);
      classes.push({ label: `+${value} kg`, max_kg: null });
    } else {
      if (value <= lastMax) errors.push(`Limits must increase: "${token}" comes after ${lastMax} kg.`);
      lastMax = value;
      classes.push({ label: `-${value} kg`, max_kg: value });
    }
  });

  return { classes, errors };
}

function formatWeightLimits(classes) {
  return classes.map((c) => c.label.replace(' kg', '')).join(',');
}

function findAgeGroup(groups, age) {
  return groups.find((g) => age >= g.min_age && age <= g.max_age) || null;
}

function findBeltGroup(groups, rank) {
  return groups.find((g) => rank >= g.min_rank && rank <= g.max_rank) || null;
}

function findWeightClass(classes, weightKg) {
  const limited = classes.filter((c) => c.max_kg !== null).sort((a, b) => a.max_kg - b.max_kg);
  return limited.find((c) => weightKg <= c.max_kg) || classes.find((c) => c.max_kg === null) || null;
}

// Works out a fighter's age and belt groups and which weight classes they can
// choose from, or explains why they can't enter.
function divisionOptions({ fighter, competition, ageGroups, beltGroups, weightClasses }) {
  const age = competitionAge(fighter.date_of_birth, competition.event_date, competition.age_basis);

  const ageGroup = findAgeGroup(ageGroups, age);
  if (!ageGroup) return { ok: false, error: `No age group for age ${age}.` };

  const beltGroup = findBeltGroup(beltGroups, fighter.belt_rank);
  if (!beltGroup) return { ok: false, error: `No belt group for ${beltName(fighter.belt_rank)} belt.` };

  const classes = weightClasses.filter((c) => c.age_group_id === ageGroup.id && c.gender === fighter.gender);
  if (classes.length === 0) {
    return { ok: false, error: `No weight classes for ${GENDERS[fighter.gender]} ${ageGroup.name}.` };
  }
  return { ok: true, age, ageGroup, beltGroup, classes };
}

// Places a fighter into gender + age + belt + the chosen weight class. A class
// from another age group, gender or competition is refused.
function assignDivision({ weightClassId, ...details }) {
  const options = divisionOptions(details);
  if (!options.ok) return options;
  const weightClass = options.classes.find((c) => c.id === Number(weightClassId));
  if (!weightClass) return { ok: false, error: 'Select a weight class.' };
  return { ...options, weightClass };
}

function overlappingRanges(items, minKey, maxKey) {
  const sorted = [...items].sort((a, b) => a[minKey] - b[minKey]);
  const overlaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i][minKey] <= sorted[i - 1][maxKey]) overlaps.push([sorted[i - 1], sorted[i]]);
  }
  return overlaps;
}

// Validates a competition's division setup. A fighter must never fit two groups.
function validateSetup({ ageGroups, beltGroups }) {
  const errors = [];

  if (ageGroups.length === 0) errors.push('Add at least one age group.');
  if (beltGroups.length === 0) errors.push('Add at least one belt group.');

  ageGroups.forEach((g) => {
    const label = g.name || 'Unnamed age group';
    if (!g.name) errors.push('Every age group needs a name.');
    if (!Number.isInteger(g.min_age) || !Number.isInteger(g.max_age) || g.min_age < 0 || g.min_age > g.max_age) {
      errors.push(`${label}: enter a valid age range.`);
    }
    ['male', 'female'].forEach((key) => {
      const parsed = parseWeightLimits(g[key]);
      parsed.errors.forEach((e) => errors.push(`${label} (${key}): ${e}`));
      if (parsed.classes.length === 0) errors.push(`${label} (${key}): enter at least one weight limit.`);
    });
  });

  beltGroups.forEach((g) => {
    if (!g.name) errors.push('Every belt group needs a name.');
    if (!(g.min_rank <= g.max_rank)) errors.push(`${g.name || 'Belt group'}: the first belt must not rank above the last.`);
  });

  overlappingRanges(ageGroups, 'min_age', 'max_age').forEach(([a, b]) => {
    errors.push(`Age groups ${a.name} and ${b.name} overlap.`);
  });
  overlappingRanges(beltGroups, 'min_rank', 'max_rank').forEach(([a, b]) => {
    errors.push(`Belt groups ${a.name} and ${b.name} overlap.`);
  });

  return errors;
}

module.exports = {
  BELTS,
  GENDERS,
  DEFAULT_AGE_GROUPS,
  DEFAULT_BELT_GROUPS,
  beltName,
  isValidDate,
  formatDay,
  formatEventDates,
  competitionAge,
  parseWeightLimits,
  formatWeightLimits,
  findAgeGroup,
  findBeltGroup,
  findWeightClass,
  divisionOptions,
  assignDivision,
  validateSetup,
};
