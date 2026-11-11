// Excel downloads for organisers: every entry, the weigh-in list and the
// results. Each builder returns sheets for write-excel-file; toXlsx makes the file.
const writeExcelFile = require('write-excel-file/node').default;
const { GENDERS, beltName } = require('./divisions');
const { POOMSAE_EVENTS, POOMSAE_GENDERS, formatScore } = require('./poomsae');
const { REGISTRATION_SELECT, listWeighIns, listPoomsaeEntries, competitionResults } = require('./services');

const WEIGH_LABELS = { passed: 'Made weight', moved: 'Moved class', no_show: 'No-show', disqualified: 'Disqualified' };

function weighLabel(row) {
  if (!row.weigh_status) return 'Waiting';
  if (row.weigh_status === 'passed' && row.entered_weight_class) return `Moved from ${row.entered_weight_class}`;
  return WEIGH_LABELS[row.weigh_status] || row.weigh_status;
}

const statusLabel = (row) => (row.withdrawn_at ? 'Withdrawn' : `${row.status[0].toUpperCase()}${row.status.slice(1)}`);

// A header row in bold, then the rows. Blank cells stay empty.
function sheet(name, titles, rows, widths) {
  return {
    sheet: name,
    data: [titles.map((value) => ({ value, fontWeight: 'bold' })), ...rows.map((row) => row.map((value) => (value === null || value === undefined || value === '' ? null : { value, type: typeof value === 'number' ? Number : String })))],
    columns: widths.map((width) => ({ width })),
    stickyRowsCount: 1,
  };
}

// Every kyorugi registration and poomsae entry, with dates of birth for
// insurers and federations. Admin-only: it holds minors' personal data.
function entriesSheets(db, competition) {
  const sheets = [];
  const registrations = db
    .prepare(`${REGISTRATION_SELECT} WHERE r.competition_id = ? ORDER BY c.name, f.last_name, f.first_name`)
    .all(competition.id);
  if (registrations.length > 0 || competition.events !== 'poomsae') {
    sheets.push(sheet('Kyorugi', ['Club', 'Last name', 'First name', 'Gender', 'Date of birth', 'Age', 'Belt', 'Age group', 'Belt group', 'Weight class', 'Status', 'Weigh-in'],
      registrations.map((r) => [r.club_name, r.last_name, r.first_name, GENDERS[r.gender], r.date_of_birth, r.age_at_event, beltName(r.belt_rank), r.age_group, r.belt_group, r.weight_class, statusLabel(r), r.status === 'approved' ? weighLabel(r) : '']),
      [22, 16, 16, 9, 13, 6, 8, 16, 12, 12, 11, 18]));
  }
  const entries = listPoomsaeEntries(db, competition.id);
  if (entries.length > 0 || competition.events !== 'kyorugi') {
    sheets.push(sheet('Poomsae', ['Club', 'Event', 'Division gender', 'Age group', 'Belt group', 'Athletes', 'Dates of birth', 'Status', 'Score'],
      entries.map((e) => {
        const dates = db.prepare('SELECT f.date_of_birth FROM poomsae_members m JOIN fighters f ON f.id = m.fighter_id WHERE m.entry_id = ? ORDER BY f.last_name, f.first_name').all(e.id);
        return [e.club_name, POOMSAE_EVENTS[e.event].label, POOMSAE_GENDERS[e.gender], e.age_group, e.belt_group, e.names, dates.map((d) => d.date_of_birth).join(', '), statusLabel(e), e.score === null ? '' : formatScore(e.score)];
      }),
      [22, 11, 14, 16, 12, 34, 26, 11, 8]));
  }
  return sheets;
}

// The approved kyorugi athletes in division order, with their weigh-in result
// so far. Never a weight: the site doesn't keep one.
function weighInSheets(db, competition) {
  return [sheet('Weigh-in', ['Age group', 'Gender', 'Belt group', 'Weight class', 'Last name', 'First name', 'Club', 'Result'],
    listWeighIns(db, competition.id).map((r) => [r.age_group, GENDERS[r.gender], r.belt_group, r.weight_class, r.last_name, r.first_name, r.club_name, weighLabel(r)]),
    [16, 9, 12, 12, 16, 16, 22, 22])];
}

// Medallists for every decided division, and the club medal table.
function resultsSheets(db, competition) {
  const { divisions, table } = competitionResults(db, competition);
  const medals = [['gold', 1, 'Gold'], ['silver', 2, 'Silver'], ['bronze', 3, 'Bronze']];
  return [
    sheet('Medallists', ['Event', 'Division', 'Place', 'Medal', 'Athlete', 'Club'],
      divisions.flatMap((d) => medals.flatMap(([key, place, label]) => d[key].map((m) => [d.event, d.title, place, label, m.name, m.club]))),
      [10, 52, 7, 8, 30, 22]),
    sheet('Medal table', ['Club', 'Gold', 'Silver', 'Bronze', 'Total'],
      table.map((t) => [t.club, t.gold, t.silver, t.bronze, t.gold + t.silver + t.bronze]),
      [26, 7, 7, 7, 7]),
  ];
}

function toXlsx(sheets) {
  return writeExcelFile(sheets).toBuffer();
}

// Sends a workbook as a download, kept out of shared caches.
async function sendXlsx(res, filename, sheets) {
  const buffer = await toXlsx(sheets);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(buffer);
}

module.exports = { entriesSheets, weighInSheets, resultsSheets, toXlsx, sendXlsx, weighLabel };
