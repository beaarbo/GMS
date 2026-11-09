// Pure single-elimination draw, scheduling and bracket geometry: no database or
// web dependencies. Entries are objects with a clubId. `rng` returns [0, 1).

function shuffle(items, rng) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Splits entries into two halves of the given sizes, sharing each club between
// them as evenly as possible. Largest clubs go first, so a club of two always has
// room on both sides and its fighters can only meet in the final.
function splitByClub(entries, capacity, rng) {
  const clubs = new Map();
  shuffle(entries, rng).forEach((entry) => {
    clubs.set(entry.clubId, [...(clubs.get(entry.clubId) || []), entry]);
  });
  const ordered = shuffle([...clubs.values()], rng).sort((a, b) => b.length - a.length);
  const halves = [[], []];

  ordered.forEach((club) => {
    const inHalf = [0, 0];
    club.forEach((entry) => {
      const left = [capacity[0] - halves[0].length, capacity[1] - halves[1].length];
      let side;
      if (left[0] === 0) side = 1;
      else if (left[1] === 0) side = 0;
      else if (inHalf[0] !== inHalf[1]) side = inHalf[0] < inHalf[1] ? 0 : 1;
      else if (left[0] !== left[1]) side = left[0] > left[1] ? 0 : 1;
      else side = rng() < 0.5 ? 0 : 1;
      halves[side].push(entry);
      inHalf[side] += 1;
    });
  });
  return halves;
}

// Standard seed positions, top to bottom, for example 8 gives 1,8,5,4,3,6,7,2.
// Seeds above the fighter count are byes, so byes land beside the top seeds.
function seedTemplate(size) {
  let seeds = [1];
  for (let n = 2; n <= size; n *= 2) {
    seeds = seeds.flatMap((seed, i) => (i % 2 === 0 ? [seed, n + 1 - seed] : [n + 1 - seed, seed]));
  }
  return seeds;
}

function drawSlots(entries, template, total, rng) {
  if (template.length === 1) {
    return [template[0] <= total ? { ...entries[0], seed: template[0] } : null];
  }
  const middle = template.length / 2;
  const top = template.slice(0, middle);
  const bottom = template.slice(middle);
  const realCount = (seeds) => seeds.filter((seed) => seed <= total).length;
  const [upper, lower] = splitByClub(entries, [realCount(top), realCount(bottom)], rng);
  return [...drawSlots(upper, top, total, rng), ...drawSlots(lower, bottom, total, rng)];
}

function nextPowerOfTwo(n) {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

// Returns rounds, each an array of { blue, red, isBye }. A null blue or red in a
// real bout means "winner of the feeding bout". The lone-entry case returns one
// bye row, which callers show as "no opponent".
function buildBracket(entries, rng = Math.random) {
  if (entries.length === 0) return [];
  if (entries.length === 1) return [[{ blue: { ...entries[0], seed: 1 }, red: null, isBye: true }]];
  return roundsFromSlots(drawSlots(entries, seedTemplate(nextPowerOfTwo(entries.length)), entries.length, rng));
}

// First-round slots in seed order, with no club separation and no randomness:
// used when an admin's change means a division has to be laid out again.
function seededSlots(entries) {
  if (entries.length <= 1) return entries.map((e) => ({ ...e, seed: 1 }));
  return seedTemplate(nextPowerOfTwo(entries.length)).map((seed) => (seed <= entries.length ? { ...entries[seed - 1], seed } : null));
}

// A first-round pair with nobody in it can't be shown or played.
function slotsAreValid(slots) {
  if (slots.length === 1) return Boolean(slots[0]);
  if (slots.length < 2 || (slots.length & (slots.length - 1)) !== 0) return false;
  for (let i = 0; i < slots.length; i += 2) if (!slots[i] && !slots[i + 1]) return false;
  return true;
}

// Builds every round from the first-round slots: pairs in order, nulls are byes.
function roundsFromSlots(slots) {
  if (slots.length === 1) return [[{ blue: slots[0], red: null, isBye: true }]];
  const rounds = [];

  let current = [];
  for (let i = 0; i < slots.length; i += 2) {
    const [blue, red] = [slots[i], slots[i + 1]];
    current.push({ blue, red, isBye: !blue || !red });
  }
  rounds.push(current);

  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const advancing = (bout) => (bout.isBye ? bout.blue || bout.red : null);
      next.push({ blue: advancing(current[i]), red: advancing(current[i + 1]), isBye: false });
    }
    rounds.push(next);
    current = next;
  }
  return rounds;
}

// Gives each division a day and court. `fixedDays[i]` pins division i to a day;
// the others fill days in order, around the pinned ones, so they stay in
// sequence. Within a day each division goes to the least busy court. Divisions
// with no fights need no court.
function assignCourts(fightCounts, { courts, days, fixedDays = [] }) {
  const pinned = fightCounts.map((_, i) => {
    const day = Number(fixedDays[i]);
    return Number.isInteger(day) && day >= 1 && day <= days ? day : null;
  });
  const total = fightCounts.reduce((sum, n) => sum + n, 0);
  const target = total / days;
  const dayLoad = Array(days + 1).fill(0);
  fightCounts.forEach((fights, i) => {
    if (pinned[i]) dayLoad[pinned[i]] += fights;
  });

  let current = 1;
  const dayOf = fightCounts.map((fights, i) => {
    if (pinned[i]) return pinned[i];
    // Move on once this day is full enough that adding most of the division would overfill it.
    while (current < days && dayLoad[current] > 0 && dayLoad[current] + fights / 2 > target) current += 1;
    dayLoad[current] += fights;
    return current;
  });

  const load = new Map();
  return fightCounts.map((fights, i) => {
    const day = dayOf[i];
    if (fights === 0) return { day, court: null };
    let court = 1;
    for (let c = 2; c <= courts; c += 1) {
      if ((load.get(`${day}:${c}`) || 0) < (load.get(`${day}:${court}`) || 0)) court = c;
    }
    load.set(`${day}:${court}`, (load.get(`${day}:${court}`) || 0) + fights);
    return { day, court };
  });
}

// Orders and times the bouts of one court on one day. `divisions` are in running
// order, each a list of { id, round, position, isBye }. A bout can't start until
// both fighters have rested `rest` minutes since their previous bout ended. Until
// then the court runs the next bout that is ready, usually from a later division,
// so it doesn't sit idle. Returns a Map of bout id to { number, start } in minutes.
function scheduleCourt(divisions, { start, minutes, rest = 0 }) {
  const queue = [];
  divisions.forEach((bouts) => {
    const byPlace = new Map(bouts.map((b) => [`${b.round}:${b.position}`, b]));
    bouts
      .filter((b) => !b.isBye)
      .sort((a, b) => a.round - b.round || a.position - b.position)
      .forEach((bout) => {
        const feeders = bout.round === 1
          ? []
          : [byPlace.get(`${bout.round - 1}:${bout.position * 2}`), byPlace.get(`${bout.round - 1}:${bout.position * 2 + 1}`)]
              .filter((f) => f && !f.isBye)
              .map((f) => f.id);
        queue.push({ id: bout.id, feeders });
      });
  });

  const ends = new Map();
  const result = new Map();
  let clock = start;
  while (queue.length > 0) {
    const readyAt = (item) => (item.feeders.every((id) => ends.has(id)) ? Math.max(start, ...item.feeders.map((id) => ends.get(id) + rest)) : Infinity);
    let index = queue.findIndex((item) => readyAt(item) <= clock);
    if (index === -1) {
      const times = queue.map(readyAt);
      clock = Math.min(...times);
      index = times.indexOf(clock);
    }
    const [item] = queue.splice(index, 1);
    result.set(item.id, { number: result.size + 1, start: clock });
    ends.set(item.id, clock + minutes);
    clock += minutes;
  }
  return result;
}

function formatTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const LEFT_X = 16;
const FINAL_X = 505;
const END_X = 590;
const ROUND_STEP = 85;
const MIN_FIRST_X = 165;

// Draws a division in a 595-wide space. `bouts` have { round, position, number,
// time, isBye, blue, red }. Used by both the web page and the PDF.
function layoutBracket(bouts, { slotHeight, top = 0 }) {
  const lines = [];
  const fighters = [];
  const labels = [];
  const winners = [];
  const totalRounds = Math.max(...bouts.map((b) => b.round));
  const size = 2 ** totalRounds;
  const step = totalRounds > 1 ? Math.min(ROUND_STEP, (FINAL_X - MIN_FIRST_X) / (totalRounds - 1)) : ROUND_STEP;
  const columnX = (round) => FINAL_X - step * (totalRounds - round);
  const leafY = (index) => top + index * slotHeight + slotHeight / 2;
  const byPlace = new Map(bouts.map((b) => [`${b.round}:${b.position}`, b]));

  const addFighter = (fighter, y, endX) => {
    fighters.push({ ...fighter, y, endX });
    lines.push({ x1: LEFT_X, y1: y, x2: endX, y2: y });
  };

  const addBout = (bout, round, yA, yB) => {
    const x = columnX(round);
    const y = (yA + yB) / 2;
    lines.push({ x1: x, y1: yA, x2: x, y2: yB });
    labels.push({ x, y, number: bout.number, time: bout.time });
    if (bout.winner) {
      const endX = round === totalRounds ? END_X : columnX(round + 1);
      winners.push({ name: bout.winner.name, clubId: bout.winner.clubId, x, endX, y });
    }
    return { y, fromX: x };
  };

  const build = (round, position) => {
    const bout = byPlace.get(`${round}:${position}`);
    if (round === 1) {
      const yA = leafY(position * 2);
      const yB = leafY(position * 2 + 1);
      if (bout.isBye) return { y: (yA + yB) / 2, advancing: bout.blue || bout.red };
      addFighter(bout.blue, yA, columnX(1));
      addFighter(bout.red, yB, columnX(1));
      return addBout(bout, 1, yA, yB);
    }
    const children = [build(round - 1, position * 2), build(round - 1, position * 2 + 1)];
    children.forEach((child) => {
      if (child.advancing) addFighter(child.advancing, child.y, columnX(round));
      else lines.push({ x1: child.fromX, y1: child.y, x2: columnX(round), y2: child.y });
    });
    return addBout(bout, round, children[0].y, children[1].y);
  };

  if (bouts.length === 1 && bouts[0].isBye) {
    const y = top + slotHeight / 2;
    fighters.push({ ...(bouts[0].blue || bouts[0].red), seed: null, y, endX: END_X });
    lines.push({ x1: LEFT_X, y1: y, x2: END_X, y2: y });
    return { lines, fighters, labels, winners, note: { x: END_X, y, text: 'No opponent' }, height: top + slotHeight };
  }

  const final = build(totalRounds, 0);
  lines.push({ x1: final.fromX, y1: final.y, x2: END_X, y2: final.y });
  return { lines, fighters, labels, winners, note: null, height: top + size * slotHeight };
}

function isLone(division) {
  return division.bouts.length === 1 && division.bouts[0].isBye;
}

function loserOf(bout) {
  if (!bout.winner) return null;
  return bout.blue && bout.blue.registrationId === bout.winner.registrationId ? bout.red : bout.blue;
}

// Gold and silver come from the final. Each losing semifinalist gets bronze, as
// taekwondo awards two. A fighter alone in a division has no bout, so no medal.
function divisionMedalists(division) {
  if (isLone(division)) return { gold: null, silver: null, bronze: [], unopposed: true };
  const final = division.bouts.find((b) => b.round === b.totalRounds);
  const semis = division.bouts.filter((b) => b.round === b.totalRounds - 1 && !b.isBye);
  return {
    gold: final.winner,
    silver: loserOf(final),
    bronze: semis.map(loserOf).filter(Boolean),
    unopposed: false,
  };
}

// Returns each division's medalists plus a club table, ranked gold, silver, bronze.
function computeMedals(divisions) {
  const clubs = new Map();
  const award = (fighter, medal) => {
    if (!fighter) return;
    if (!clubs.has(fighter.clubId)) clubs.set(fighter.clubId, { clubId: fighter.clubId, club: fighter.club, gold: 0, silver: 0, bronze: 0 });
    clubs.get(fighter.clubId)[medal] += 1;
  };
  const results = divisions.map((division) => {
    const medalists = divisionMedalists(division);
    award(medalists.gold, 'gold');
    award(medalists.silver, 'silver');
    medalists.bronze.forEach((fighter) => award(fighter, 'bronze'));
    return { title: division.title, ...medalists };
  });
  const table = [...clubs.values()].sort(
    (a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || a.club.localeCompare(b.club)
  );
  return { table, divisions: results };
}

// One row per athlete of a club: where they are next, or how they finished.
function clubAthleteSummary(divisions, clubId) {
  const rows = [];
  divisions.forEach((division) => {
    const medalists = divisionMedalists(division);
    const entrants = division.bouts
      .filter((b) => b.round === 1)
      .flatMap((b) => [b.blue, b.red])
      .filter((fighter) => fighter && fighter.clubId === clubId);

    entrants.forEach((fighter) => {
      const has = (bout) => [bout.blue, bout.red].some((s) => s && s.registrationId === fighter.registrationId);
      const real = division.bouts.filter((b) => !b.isBye && has(b));
      const next = real.find((b) => !b.winner);
      const same = (medalist) => medalist && medalist.registrationId === fighter.registrationId;
      const lostIn = real.find((b) => b.winner && b.winner.registrationId !== fighter.registrationId);

      let status = 'Waiting for an earlier bout';
      if (medalists.unopposed) status = 'No opponent';
      else if (same(medalists.gold)) status = 'Gold';
      else if (same(medalists.silver)) status = 'Silver';
      else if (medalists.bronze.some(same)) status = 'Bronze';
      else if (lostIn) status = `Out in Bout ${lostIn.number}`;
      else if (next) status = 'Still competing';

      rows.push({
        name: fighter.name,
        title: division.title,
        dayLabel: division.dayLabel,
        court: division.court,
        nextNumber: next ? next.number : null,
        nextTime: next ? next.time : null,
        status,
      });
    });
  });
  return rows;
}

module.exports = {
  buildBracket,
  roundsFromSlots,
  seededSlots,
  slotsAreValid,
  seedTemplate,
  assignCourts,
  scheduleCourt,
  formatTime,
  layoutBracket,
  splitByClub,
  computeMedals,
  clubAthleteSummary,
  LEFT_X,
};
