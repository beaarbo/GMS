// Athlete cards for competition day: ten to an A4 page, to cut out and hand to
// clubs. Each card's QR code opens the athlete's page for officials (weigh-in,
// bouts, poomsae). The code holds only a link with ids, no personal data.
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { GENDERS } = require('./divisions');
const { poomsaeDivisionTitle } = require('./poomsae');
const { REGISTRATION_SELECT } = require('./services');

// Everyone with an approved, not withdrawn kyorugi registration or an approved
// poomsae entry, by club then name. clubId limits it to one club.
function cardAthletes(db, competition, { clubId = null } = {}) {
  const athletes = new Map();
  const add = (fighter, line) => {
    if (!athletes.has(fighter.fighter_id)) {
      athletes.set(fighter.fighter_id, { fighterId: fighter.fighter_id, firstName: fighter.first_name, lastName: fighter.last_name, club: fighter.club_name, lines: [] });
    }
    athletes.get(fighter.fighter_id).lines.push(line);
  };
  db.prepare(`${REGISTRATION_SELECT} WHERE r.competition_id = ? AND r.status = 'approved' AND r.withdrawn_at IS NULL ${clubId ? 'AND r.club_id = ?' : ''}`)
    .all(...[competition.id, clubId].filter(Boolean))
    .forEach((r) => add(r, `Kyorugi: ${r.age_group} · ${GENDERS[r.gender]} · ${r.belt_group} · ${r.weight_class}`));
  db.prepare(
    `SELECT m.fighter_id, f.first_name, f.last_name, c.name AS club_name, e.event, e.gender, a.name AS age_group, b.name AS belt_group
     FROM poomsae_entries e
     JOIN poomsae_members m ON m.entry_id = e.id
     JOIN fighters f ON f.id = m.fighter_id
     JOIN clubs c ON c.id = e.club_id
     JOIN poomsae_age_groups a ON a.id = e.age_group_id
     JOIN belt_groups b ON b.id = e.belt_group_id
     WHERE e.competition_id = ? AND e.status = 'approved' ${clubId ? 'AND e.club_id = ?' : ''}
     ORDER BY e.id`
  )
    .all(...[competition.id, clubId].filter(Boolean))
    .forEach((p) => add(p, `Poomsae: ${poomsaeDivisionTitle(p)}`));
  return [...athletes.values()].sort((a, b) => a.club.localeCompare(b.club) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
}

// The officials' page a card's code opens.
function cardUrl(publicUrl, competitionId, fighterId) {
  return `${publicUrl}/admin/competitions/${competitionId}/athletes/${fighterId}`;
}

// Draws a QR code as filled squares, so it stays sharp when printed.
function drawQr(doc, text, x, y, size) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const quiet = 2;
  const cell = size / (modules.size + quiet * 2);
  doc.save().fillColor('#000000');
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (modules.get(row, col)) doc.rect(x + (col + quiet) * cell, y + (row + quiet) * cell, cell, cell);
    }
  }
  doc.fill().restore();
}

const PAGE = { margin: 28, columns: 2, rows: 5 };

function drawCard(doc, athlete, { x, y, width, height, competition, publicUrl }) {
  const pad = 10;
  const qrSize = 84;
  doc.save().dash(3, { space: 3 }).lineWidth(0.5).strokeColor('#9aa1ab').rect(x, y, width, height).stroke().restore();
  // The coloured stripe of the site's mark, red over blue.
  doc.save().rect(x, y, width / 2, 4).fill('#c62828').rect(x + width / 2, y, width / 2, 4).fill('#1565c0').restore();

  const textWidth = width - qrSize - pad * 3;
  doc.fillColor('#555555').font('Helvetica').fontSize(7.5)
    .text(competition.name, x + pad, y + pad + 2, { width: textWidth, height: 10, ellipsis: true, lineBreak: false });
  doc.fillColor('#111111').font('Helvetica-Bold').fontSize(14)
    .text(`${athlete.lastName} ${athlete.firstName}`, x + pad, y + pad + 16, { width: textWidth, height: 34, ellipsis: true });
  doc.fillColor('#333333').font('Helvetica').fontSize(9)
    .text(athlete.club, x + pad, doc.y + 2, { width: textWidth, height: 12, ellipsis: true, lineBreak: false });
  let lineY = doc.y + 8;
  doc.fontSize(7.5).fillColor('#222222');
  athlete.lines.slice(0, 4).forEach((line) => {
    doc.text(line, x + pad, lineY, { width: textWidth, height: 18, ellipsis: true });
    lineY = doc.y + 2;
  });

  drawQr(doc, cardUrl(publicUrl, competition.id, athlete.fighterId), x + width - qrSize - pad, y + pad + 6, qrSize);
  doc.fillColor('#555555').font('Helvetica').fontSize(6.5)
    .text('Officials: scan at the weigh-in and court', x + width - qrSize - pad - 4, y + pad + qrSize + 8, { width: qrSize + 8, align: 'center' });
}

function writeAthleteCards(stream, { competition, athletes, publicUrl }) {
  const doc = new PDFDocument({ size: 'A4', autoFirstPage: false, margin: 0, info: { Title: `Athlete cards - ${competition.name}` } });
  doc.pipe(stream);
  const cardWidth = (595.28 - PAGE.margin * 2) / PAGE.columns;
  const cardHeight = (841.89 - PAGE.margin * 2) / PAGE.rows;
  const perPage = PAGE.columns * PAGE.rows;
  if (athletes.length === 0) {
    doc.addPage();
    doc.font('Helvetica').fontSize(12).text('No approved athletes yet.', PAGE.margin, PAGE.margin);
  }
  athletes.forEach((athlete, i) => {
    if (i % perPage === 0) doc.addPage();
    const slot = i % perPage;
    drawCard(doc, athlete, {
      x: PAGE.margin + (slot % PAGE.columns) * cardWidth,
      y: PAGE.margin + Math.floor(slot / PAGE.columns) * cardHeight,
      width: cardWidth,
      height: cardHeight,
      competition,
      publicUrl,
    });
  });
  doc.end();
}

module.exports = { cardAthletes, cardUrl, writeAthleteCards };
