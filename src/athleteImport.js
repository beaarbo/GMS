// Bulk athlete import from an .xlsx or .csv sheet (Excel, or Google Sheets
// downloaded as either). The first sheet needs a header row naming the columns
// below, in any order. Parsing never touches the database: callers pass in the
// club's existing athletes so duplicates can be skipped.
const { readSheet } = require('read-excel-file/node');
const writeExcelFile = require('write-excel-file/node').default;
const { BELTS, GENDERS, isValidDate } = require('./divisions');

const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_IMPORT_ROWS = 300;
const MAX_NAME_LENGTH = 80;

const COLUMNS = [
  { key: 'first_name', title: 'First name', aliases: ['firstname', 'givenname', 'first'] },
  { key: 'last_name', title: 'Last name', aliases: ['lastname', 'surname', 'familyname', 'last'] },
  { key: 'gender', title: 'Gender', aliases: ['gender', 'sex'] },
  { key: 'date_of_birth', title: 'Date of birth', aliases: ['dateofbirth', 'dob', 'birthdate', 'birthday'] },
  { key: 'belt', title: 'Belt', aliases: ['belt', 'beltcolour', 'beltcolor', 'beltrank', 'rank'] },
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

class ImportError extends Error {}

function headerKey(value) {
  const text = String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const column = COLUMNS.find((c) => c.aliases.includes(text));
  return column ? column.key : null;
}

// RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks.
// Semicolons are accepted too, since some spreadsheet locales export with them.
function parseCsv(text) {
  const source = text.replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0];
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Reads the uploaded file into rows of cell values. Throws ImportError with a
// message for the coach when the file isn't a sheet we can read.
async function readRows(buffer) {
  if (!buffer || buffer.length === 0) throw new ImportError('That file is empty.');
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    throw new ImportError('That is an old .xls file. Open it in Excel and save it as .xlsx, or export it as .csv.');
  }
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try {
      return await readSheet(buffer);
    } catch {
      throw new ImportError('That spreadsheet could not be read. Save it as .xlsx or .csv and try again.');
    }
  }
  if (buffer.includes(0)) throw new ImportError('That file type is not accepted. Upload an .xlsx or .csv file.');
  return parseCsv(buffer.toString('utf8'));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function isoDate(year, month, day) {
  const value = `${year}-${pad(month)}-${pad(day)}`;
  return isValidDate(value) ? value : null;
}

// Accepts a date cell, an Excel serial number, YYYY-MM-DD, DD/MM/YYYY (also
// with - or .) and "4 Mar 2012". Slash dates are read day first.
function parseDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    if (value < 1 || value > 100000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000).toISOString().slice(0, 10);
  }
  const text = String(value ?? '').trim();
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (match) return isoDate(match[1], match[2], match[3]);
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) return isoDate(match[3], match[2], match[1]);
  match = text.match(/^(\d{1,2})[\s-]+([a-z]{3})[a-z]*\.?[\s-]+(\d{4})$/i);
  if (match) {
    const month = MONTHS.indexOf(match[2].toLowerCase()) + 1;
    return month > 0 ? isoDate(match[3], month, match[1]) : null;
  }
  return null;
}

function parseGender(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['m', 'male', 'boy'].includes(text)) return 'M';
  if (['f', 'female', 'girl'].includes(text)) return 'F';
  return null;
}

function parseBelt(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s*belt$/, '');
  const belt = BELTS.find((b) => b.name.toLowerCase() === text || String(b.rank) === text);
  return belt ? belt.rank : null;
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  return String(value).trim();
}

function duplicateKey(athlete) {
  const name = (s) => s.toLowerCase().replace(/\s+/g, ' ');
  return `${name(athlete.first_name)}|${name(athlete.last_name)}|${athlete.date_of_birth}`;
}

// Checks one athlete's values, the same rules as the add-athlete form.
function athleteErrors(athlete, todayIso) {
  const errors = [];
  if (!athlete.first_name) errors.push('First name is missing.');
  else if (athlete.first_name.length > MAX_NAME_LENGTH) errors.push(`First name is over ${MAX_NAME_LENGTH} characters.`);
  if (!athlete.last_name) errors.push('Last name is missing.');
  else if (athlete.last_name.length > MAX_NAME_LENGTH) errors.push(`Last name is over ${MAX_NAME_LENGTH} characters.`);
  if (!GENDERS[athlete.gender]) errors.push('Gender must be M or F.');
  if (!isValidDate(athlete.date_of_birth) || athlete.date_of_birth >= todayIso) errors.push('Date of birth is not a valid past date.');
  if (!BELTS.some((b) => b.rank === athlete.belt_rank)) errors.push(`Belt must be ${BELTS.map((b) => b.name).join(', ')}.`);
  return errors;
}

// Turns sheet rows into a preview: every data row with its parsed values and
// either errors, a duplicate note, or nothing (ready to import).
function previewImport(rows, { existing = [], todayIso }) {
  const headerIndex = rows.slice(0, 10).findIndex((row) => row.filter((cell) => headerKey(cell)).length >= 3);
  if (headerIndex === -1) {
    throw new ImportError(`No header row found. The first row needs the columns: ${COLUMNS.map((c) => c.title).join(', ')}.`);
  }
  const positions = {};
  rows[headerIndex].forEach((cell, index) => {
    const key = headerKey(cell);
    if (key && positions[key] === undefined) positions[key] = index;
  });
  const missing = COLUMNS.filter((c) => positions[c.key] === undefined).map((c) => c.title);
  if (missing.length > 0) throw new ImportError(`The sheet is missing these columns: ${missing.join(', ')}.`);

  const seen = new Set(existing.map(duplicateKey));
  const entries = [];
  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const raw = Object.fromEntries(COLUMNS.map((c) => [c.key, row[positions[c.key]]]));
    if (Object.values(raw).every((value) => cellText(value) === '')) return;
    const athlete = {
      first_name: cellText(raw.first_name).replace(/\s+/g, ' '),
      last_name: cellText(raw.last_name).replace(/\s+/g, ' '),
      gender: parseGender(raw.gender),
      date_of_birth: parseDate(raw.date_of_birth),
      belt_rank: parseBelt(raw.belt),
    };
    const entry = {
      row: headerIndex + offset + 2,
      athlete,
      shown: { gender: cellText(raw.gender), date_of_birth: cellText(raw.date_of_birth), belt: cellText(raw.belt) },
      errors: athleteErrors(athlete, todayIso),
      duplicate: false,
    };
    if (entry.errors.length === 0) {
      const key = duplicateKey(athlete);
      entry.duplicate = seen.has(key);
      seen.add(key);
    }
    entries.push(entry);
  });
  if (entries.length === 0) throw new ImportError('The sheet has a header row but no athletes under it.');
  if (entries.length > MAX_IMPORT_ROWS) {
    throw new ImportError(`The sheet has ${entries.length} athletes. Import at most ${MAX_IMPORT_ROWS} at a time.`);
  }
  return {
    entries,
    ready: entries.filter((e) => e.errors.length === 0 && !e.duplicate).map((e) => e.athlete),
  };
}

const INSTRUCTIONS = [
  ['How to fill in the Athletes sheet'],
  [''],
  ['One athlete per row, under the header row. Keep the header row as it is.'],
  ['First name, Last name', 'As they should appear on the bout list.'],
  ['Gender', 'M or F.'],
  ['Date of birth', 'A date, or text as YYYY-MM-DD, for example 2012-03-24. DD/MM/YYYY also works.'],
  ['Belt', BELTS.map((b) => b.name).join(', ')],
  [''],
  ['Weight is chosen for each competition when you register the athlete, so it is not in this sheet.'],
  ['After importing, upload each athlete’s grading card or black belt certificate from the club dashboard.'],
  ['Using Google Sheets? Upload this file to Google Drive, open it with Google Sheets, then use File > Download > .xlsx or .csv.'],
];

async function templateXlsx() {
  const header = COLUMNS.map((c) => ({ value: c.title, fontWeight: 'bold' }));
  // A blank text-formatted date column keeps typed dates as YYYY-MM-DD in every locale.
  const blankRows = Array.from({ length: 50 }, () => COLUMNS.map((c) => (c.key === 'date_of_birth' ? { value: null, type: String, format: '@' } : null)));
  return writeExcelFile([
    {
      sheet: 'Athletes',
      data: [header, ...blankRows],
      columns: [{ width: 18 }, { width: 18 }, { width: 10 }, { width: 16 }, { width: 10 }],
      stickyRowsCount: 1,
    },
    {
      sheet: 'Instructions',
      data: INSTRUCTIONS.map((row, i) => row.map((value) => ({ value, fontWeight: i === 0 ? 'bold' : undefined }))),
      columns: [{ width: 22 }, { width: 90 }],
    },
  ]).toBuffer();
}

function templateCsv() {
  return `${COLUMNS.map((c) => c.title).join(',')}\r\n`;
}

module.exports = {
  COLUMNS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  ImportError,
  parseCsv,
  parseDate,
  readRows,
  previewImport,
  athleteErrors,
  templateXlsx,
  templateCsv,
};
