// A coach's own competitors as a printable list: who competes, in which
// division, on which day and court, their next bout or place in the
// performance order, its time, the drawn poomsae and how they stand. The rows
// come from clubCompetitors, so only published stages appear.
const PDFDocument = require('pdfkit');

const INK = '#16202e';
const MUTED = '#5b6474';
const RULE = '#d5d9e0';
const MARGIN = 36;
const COLUMNS = [
  ['Competitor', 'name', 120],
  ['Event', 'event', 55],
  ['Division', 'division', 170],
  ['Day', 'dayLabel', 75],
  ['Court', 'court', 75],
  ['Next', 'next', 80],
  ['Time', 'time', 40],
  ['Poomsae', 'poomsae', 90],
  ['Status', 'status', 65],
];
const PAD = 4;
const SIZE = 8.5;

const cellText = (row, key) => {
  const value = key === 'poomsae' ? (row.poomsae ? row.poomsae.join(', ') : '') : row[key];
  return value === null || value === undefined || value === '' ? '-' : String(value);
};

function drawHeaderRow(doc, y) {
  let x = MARGIN;
  doc.font('Helvetica-Bold').fontSize(SIZE).fillColor(INK);
  COLUMNS.forEach(([label, , width]) => {
    doc.text(label, x + PAD, y + PAD, { width: width - PAD * 2, lineBreak: false });
    x += width;
  });
  const bottom = y + doc.currentLineHeight() + PAD * 2;
  doc.moveTo(MARGIN, bottom).lineTo(MARGIN + COLUMNS.reduce((n, c) => n + c[2], 0), bottom).lineWidth(1).strokeColor(INK).stroke();
  return bottom;
}

function writeClubCompetitorsPdf(stream, { competition, clubName, rows, dateLabel, printedAt }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, info: { Title: `${clubName} - ${competition.name}` } });
  doc.pipe(stream);
  const pageBottom = doc.page.height - MARGIN - 18;

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(`${clubName}: our competitors`, MARGIN, MARGIN);
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text(`${competition.name} · ${competition.venue}, ${dateLabel}`, { lineGap: 2 })
    .text(`Printed ${printedAt}. Times and next bouts change as results come in: check the live bout list on the day.`);
  let y = doc.y + 12;

  if (rows.length === 0) {
    doc.font('Helvetica').fontSize(11).fillColor(INK).text('None of your competitors are on the published bout list yet.', MARGIN, y);
    doc.end();
    return;
  }

  y = drawHeaderRow(doc, y);
  doc.font('Helvetica').fontSize(SIZE);
  rows.forEach((row) => {
    const height = Math.max(...COLUMNS.map(([, key, width]) => doc.heightOfString(cellText(row, key), { width: width - PAD * 2 }))) + PAD * 2;
    if (y + height > pageBottom) {
      doc.addPage();
      y = drawHeaderRow(doc, MARGIN);
      doc.font('Helvetica').fontSize(SIZE);
    }
    let x = MARGIN;
    COLUMNS.forEach(([, key, width]) => {
      doc.fillColor(INK).font(key === 'name' ? 'Helvetica-Bold' : 'Helvetica').fontSize(SIZE)
        .text(cellText(row, key), x + PAD, y + PAD, { width: width - PAD * 2 });
      x += width;
    });
    y += height;
    doc.moveTo(MARGIN, y).lineTo(x, y).lineWidth(0.5).strokeColor(RULE).stroke();
  });
  doc.end();
}

module.exports = { writeClubCompetitorsPdf };
