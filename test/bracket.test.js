const test = require('node:test');
const assert = require('node:assert');
const { buildBracket, seedTemplate, assignCourts, formatTime, layoutBracket, computeMedals, clubAthleteSummary } = require('../src/bracket');

function seededRng(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function entriesFor(clubSizes) {
  const entries = [];
  clubSizes.forEach((size, club) => {
    for (let i = 0; i < size; i += 1) entries.push({ id: `${club}-${i}`, clubId: club });
  });
  return entries;
}

function firstRoundOrder(rounds) {
  return rounds[0].flatMap((bout) => [bout.blue, bout.red]);
}

// Every combination of club sizes up to 16 fighters, across many random draws.
function allClubSizes(maxTotal, maxClub = maxTotal) {
  const results = [];
  const walk = (left, limit, sizes) => {
    if (sizes.length > 0) results.push(sizes);
    for (let size = Math.min(left, limit); size >= 1; size -= 1) walk(left - size, size, [...sizes, size]);
  };
  walk(maxTotal, maxClub, []);
  return results;
}

test('a bracket has every fighter once, the right byes, and n-1 real bouts', () => {
  for (let n = 2; n <= 33; n += 1) {
    const entries = entriesFor(Array(n).fill(1));
    const rounds = buildBracket(entries, seededRng(n));
    const size = 2 ** Math.ceil(Math.log2(n));
    const slots = firstRoundOrder(rounds);

    assert.equal(slots.length, size, `slots for ${n}`);
    assert.equal(slots.filter(Boolean).length, n, `fighters for ${n}`);
    assert.equal(new Set(slots.filter(Boolean).map((e) => e.id)).size, n, `unique fighters for ${n}`);
    assert.equal(rounds[0].filter((b) => b.isBye).length, size - n, `byes for ${n}`);
    assert.equal(rounds.flat().filter((b) => !b.isBye).length, n - 1, `bouts for ${n}`);
    assert.equal(rounds[rounds.length - 1].length, 1, `one final for ${n}`);
  }
});

test('no bout is ever left without a fighter or a feeding bout on a side', () => {
  for (let n = 2; n <= 33; n += 1) {
    const rounds = buildBracket(entriesFor(Array(n).fill(1)), seededRng(n * 7));
    assert.ok(rounds[0].every((b) => b.blue || b.red), `empty first-round bout for ${n}`);
  }
});

test('two fighters from one club always land in opposite halves', () => {
  allClubSizes(16, 2).forEach((sizes) => {
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total < 2) return;
    for (let seed = 1; seed <= 25; seed += 1) {
      const slots = firstRoundOrder(buildBracket(entriesFor(sizes), seededRng(seed)));
      const half = slots.length / 2;
      slots.slice(0, half).filter(Boolean).forEach((a) => {
        const sameHalf = slots.slice(0, half).filter((b) => b && b !== a && b.clubId === a.clubId);
        assert.equal(sameHalf.length, 0, `clubs ${sizes} seed ${seed}`);
      });
    }
  });
});

test('larger clubs are shared evenly between the halves', () => {
  allClubSizes(16).forEach((sizes) => {
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total < 2) return;
    const slots = firstRoundOrder(buildBracket(entriesFor(sizes), seededRng(total)));
    const half = slots.length / 2;
    sizes.forEach((size, club) => {
      const top = slots.slice(0, half).filter((e) => e && e.clubId === club).length;
      assert.ok(Math.abs(top - (size - top)) <= 1, `club of ${size} split ${top}/${size - top} in ${sizes}`);
    });
  });
});

test('a lone fighter gets one row and no bout', () => {
  const rounds = buildBracket(entriesFor([1]));
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].length, 1);
  assert.equal(rounds[0][0].isBye, true);
});

test('fighters with byes advance straight into the next round', () => {
  const rounds = buildBracket(entriesFor([1, 1, 1]), seededRng(3));
  assert.equal(rounds.length, 2);
  const bye = rounds[0].findIndex((b) => b.isBye);
  const fighter = rounds[0][bye].blue || rounds[0][bye].red;
  const final = rounds[1][0];
  assert.equal(bye === 0 ? final.blue : final.red, fighter);
});

test('seed positions match standard brackets, with byes beside the top seeds', () => {
  assert.deepEqual(seedTemplate(4), [1, 4, 3, 2]);
  assert.deepEqual(seedTemplate(8), [1, 8, 5, 4, 3, 6, 7, 2]);
  const seeds = (n) => firstRoundOrder(buildBracket(entriesFor(Array(n).fill(1)), seededRng(n))).map((e) => (e ? e.seed : null));
  assert.deepEqual(seeds(3), [1, null, 3, 2]);
  assert.deepEqual(seeds(5), [1, null, 5, 4, 3, null, null, 2]);
  assert.deepEqual(seeds(6), [1, null, 5, 4, 3, 6, null, 2]);
});

test('courts balance within a day and days fill in order', () => {
  assert.deepEqual(assignCourts([3, 3, 1], { courts: 2, days: 1 }), [
    { day: 1, court: 1 }, { day: 1, court: 2 }, { day: 1, court: 1 },
  ]);
  const twoDays = assignCourts([5, 5, 5, 5], { courts: 1, days: 2 }).map((p) => p.day);
  assert.deepEqual(twoDays, [1, 1, 2, 2]);
  assert.deepEqual(assignCourts([0], { courts: 2, days: 1 }), [{ day: 1, court: null }]);
});

test('formatTime pads hours and minutes', () => {
  assert.equal(formatTime(9 * 60 + 5), '09:05');
  assert.equal(formatTime(13 * 60 + 40), '13:40');
});

function boutsFor(rounds) {
  let number = 0;
  return rounds.flatMap((bouts, r) => bouts.map((bout, position) => {
    if (!bout.isBye) number += 1;
    return { ...bout, round: r + 1, position, number: bout.isBye ? null : number, time: '10:00' };
  }));
}

test('the bracket layout draws every fighter once and one label per bout', () => {
  for (let n = 2; n <= 33; n += 1) {
    const layout = layoutBracket(boutsFor(buildBracket(entriesFor(Array(n).fill(1)), seededRng(n))), { slotHeight: 30 });
    assert.equal(layout.fighters.length, n, `fighters for ${n}`);
    assert.equal(new Set(layout.fighters.map((f) => f.id)).size, n, `unique fighters for ${n}`);
    assert.equal(layout.labels.length, n - 1, `labels for ${n}`);
    layout.lines.forEach((line) => {
      assert.ok([line.x1, line.x2, line.y1, line.y2].every(Number.isFinite), `finite line for ${n}`);
    });
  }
});

test('a lone fighter is laid out with a no-opponent note and no bout label', () => {
  const layout = layoutBracket(boutsFor(buildBracket(entriesFor([1]))), { slotHeight: 30 });
  assert.equal(layout.fighters.length, 1);
  assert.equal(layout.labels.length, 0);
  assert.equal(layout.note.text, 'No opponent');
});

function division(bouts) {
  return { title: 'D', dayLabel: '1', court: 1, bouts };
}

const athlete = (id, clubId) => ({ registrationId: id, name: `F${id}`, club: `C${clubId}`, clubId });

test('three fighters give one bronze, and a lone fighter earns no medal', () => {
  const [a, b, c] = [athlete(1, 1), athlete(2, 2), athlete(3, 3)];
  const three = division([
    { round: 1, totalRounds: 2, position: 0, isBye: true, blue: a, red: null, winner: null },
    { round: 1, totalRounds: 2, position: 1, isBye: false, blue: b, red: c, winner: b, number: 1 },
    { round: 2, totalRounds: 2, position: 0, isBye: false, blue: a, red: b, winner: a, number: 2 },
  ]);
  const lone = division([{ round: 1, totalRounds: 1, position: 0, isBye: true, blue: athlete(4, 1), red: null, winner: null }]);
  const { table } = computeMedals([three, lone]);
  assert.deepEqual(table.map((r) => [r.club, r.gold, r.silver, r.bronze]), [
    ['C1', 1, 0, 0],
    ['C2', 0, 1, 0],
    ['C3', 0, 0, 1],
  ]);
  assert.deepEqual(computeMedals([lone]).table, []);
  assert.deepEqual(clubAthleteSummary([lone], 1).map((r) => r.status), ['No opponent']);
});

test('no medals are awarded before the bouts that decide them', () => {
  const [a, b] = [athlete(1, 1), athlete(2, 2)];
  const open = division([{ round: 1, totalRounds: 1, position: 0, isBye: false, blue: a, red: b, winner: null, number: 1, time: '09:00' }]);
  assert.deepEqual(computeMedals([open]).table, []);
  const [row] = clubAthleteSummary([open], 1);
  assert.equal(row.status, 'Still competing');
  assert.equal(row.nextNumber, 1);
});

test('athletes knocked out early show the bout they lost', () => {
  const [a, b, c, d] = [athlete(1, 1), athlete(2, 2), athlete(3, 3), athlete(4, 4), athlete(5, 5)];
  const e = athlete(5, 5);
  const f = athlete(6, 6);
  const g = athlete(7, 7);
  const h = athlete(8, 8);
  const bouts = [
    { round: 1, totalRounds: 3, position: 0, isBye: false, blue: a, red: b, winner: a, number: 1 },
    { round: 1, totalRounds: 3, position: 1, isBye: false, blue: c, red: d, winner: null, number: 2 },
    { round: 1, totalRounds: 3, position: 2, isBye: false, blue: e, red: f, winner: null, number: 3 },
    { round: 1, totalRounds: 3, position: 3, isBye: false, blue: g, red: h, winner: null, number: 4 },
    { round: 2, totalRounds: 3, position: 0, isBye: false, blue: a, red: null, winner: null, number: 5 },
    { round: 2, totalRounds: 3, position: 1, isBye: false, blue: null, red: null, winner: null, number: 6 },
    { round: 3, totalRounds: 3, position: 0, isBye: false, blue: null, red: null, winner: null, number: 7 },
  ];
  assert.equal(clubAthleteSummary([division(bouts)], 2)[0].status, 'Out in Bout 1');
  assert.equal(clubAthleteSummary([division(bouts)], 1)[0].nextNumber, 5);
});