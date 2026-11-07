const PDFDocument = require('pdfkit');
const { layoutBracket, LEFT_X } = require('./bracket');

const INK = '#16202e';
const PAGE_MIDDLE_Y = 348;
const MIN_TOP_Y = 128;
const COMPACT_SLOT = 16;

function oneLine(doc, text, x, y, width, options = {}) {
  doc.text(text, x, y, { width, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true, ...options });
}

// Taller gaps for small brackets, tighter once they need the whole page.
function slotHeightFor(size) {
  return size <= 8 ? 328 / size : 656 / size;
}

function drawHeader(doc, { competition, dateLabel }, division) {
  const titleX = 90;
  const titleWidth = 415;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14);
  doc.text(competition.name.toUpperCase(), titleX, 20, { width: titleWidth, align: 'center' });
  doc.font('Helvetica').fontSize(11);
  doc.text(`${competition.venue}, ${dateLabel}`, titleX, doc.y + 2, { width: titleWidth, align: 'center' });
  doc.fontSize(10);
  doc.text(division.title, titleX, doc.y + 3, { width: titleWidth, align: 'center' });

  const meta = [
    `Day: ${division.dayLabel}`,
    `Court: ${division.court || '-'}`,
    `Participants: ${division.participants}`,
    `Matches: ${division.matches}`,
  ];
  doc.font('Helvetica').fontSize(9);
  meta.forEach((line, i) => {
    doc.text(line, 455, 50 + i * 12, { width: 130, align: 'right', lineBreak: false });
  });
}

function drawBracket(doc, division) {
  const totalRounds = Math.max(...division.bouts.map((b) => b.round));
  const size = 2 ** totalRounds;
  const slotHeight = division.matches === 0 ? 40 : slotHeightFor(size);
  const top = Math.max(MIN_TOP_Y, PAGE_MIDDLE_Y - (size * slotHeight) / 2);
  const layout = layoutBracket(division.bouts, { slotHeight, top });
  const compact = slotHeight < COMPACT_SLOT;

  doc.lineWidth(0.8).strokeColor('#000000');
  layout.lines.forEach((line) => doc.moveTo(line.x1, line.y1).lineTo(line.x2, line.y2).stroke());

  doc.fillColor(INK);
  layout.fighters.forEach((fighter) => {
    const width = fighter.endX - LEFT_X - 4;
    if (fighter.seed) {
      doc.font('Helvetica').fontSize(6.5);
      doc.text(String(fighter.seed), 2, fighter.y - 8, { width: 12, align: 'right', lineBreak: false });
    }
    if (compact) {
      doc.font('Helvetica').fontSize(6.5);
      oneLine(doc, `${fighter.name} - ${fighter.club}`, LEFT_X, fighter.y - 8, width);
      return;
    }
    doc.font('Helvetica').fontSize(10);
    oneLine(doc, fighter.name, LEFT_X, fighter.y - 11, width);
    doc.fontSize(6);
    oneLine(doc, fighter.club, LEFT_X, fighter.y + 2, width);
  });

  layout.labels.forEach((label) => {
    doc.font('Helvetica').fontSize(10);
    doc.text(String(label.number), label.x - 26, label.y - 4, { width: 22, align: 'right', lineBreak: false });
    doc.fontSize(6.5);
    doc.text(label.time, label.x - 56, label.y - 2, { width: 28, align: 'right', lineBreak: false });
  });

  layout.winners.forEach((winner) => {
    doc.font('Helvetica-Bold').fontSize(8);
    oneLine(doc, winner.name, winner.x + 3, winner.y - 10, winner.endX - winner.x - 5);
  });

  if (layout.note) {
    doc.font('Helvetica-Oblique').fontSize(9);
    doc.text(layout.note.text, layout.note.x - 120, layout.note.y - 12, { width: 120, align: 'right', lineBreak: false });
  }
}

// Pipes an A4 bout list into `stream`, with one page per division.
function writeBoutListPdf(stream, { competition, divisions, dateLabel }) {
  const doc = new PDFDocument({
    size: 'A4',
    autoFirstPage: false,
    margins: { top: 10, bottom: 5, left: 5, right: 5 },
    info: { Title: `Bout list - ${competition.name}` },
  });
  doc.pipe(stream);

  divisions.forEach((division) => {
    doc.addPage();
    drawHeader(doc, { competition, dateLabel }, division);
    drawBracket(doc, division);
  });
  doc.end();
}

module.exports = { writeBoutListPdf };
