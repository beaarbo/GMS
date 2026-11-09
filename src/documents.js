// Athlete belt documents. No database or web imports.

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

const DOCUMENT_LABELS = {
  grading_card: 'grading card',
  black_belt_certificate: 'black belt certificate',
};

const BLACK_BELT_RANK = 3;

function documentTypeFor(beltRank) {
  return Number(beltRank) === BLACK_BELT_RANK ? 'black_belt_certificate' : 'grading_card';
}

function documentLabel(type) {
  return DOCUMENT_LABELS[type] || 'document';
}

// Works from the file's actual bytes, because a name or browser-supplied type can
// claim anything. Returns null for anything that isn't an allowed format.
function detectFileType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const startsWith = (bytes) => bytes.every((byte, i) => buffer[i] === byte);
  if (startsWith([0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', extension: 'jpg' };
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png', extension: 'png' };
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  if (buffer.toString('latin1', 0, 5) === '%PDF-') return { contentType: 'application/pdf', extension: 'pdf' };
  return null;
}

// Sends a stored file, marked private so browsers and proxies don't keep copies.
function sendDocument(res, document) {
  const { extension } = detectFileType(document.data);
  res.setHeader('Content-Type', document.content_type);
  res.setHeader('Content-Disposition', `inline; filename="athlete-${document.fighter_id}-${document.doc_type}.${extension}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(document.data);
}

const MAX_ICON_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Files attached in one go on the new-competition form. More can follow later.
const MAX_NEW_COMPETITION_FILES = 10;

const OFFICE_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// Competition attachments: PDF and pictures by their bytes, plus Word and Excel
// files, which are zip archives, so their name's extension decides which.
function detectAttachmentType(buffer, filename) {
  const known = detectFileType(buffer);
  if (known) return known;
  const extension = String(filename || '').toLowerCase().split('.').pop();
  if (buffer && buffer[0] === 0x50 && buffer[1] === 0x4b && OFFICE_TYPES[extension]) {
    return { contentType: OFFICE_TYPES[extension], extension };
  }
  return null;
}

// Keeps a downloaded file's name readable without letting it break the header.
function safeFilename(filename, extension) {
  const base = String(filename || 'file').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N} _().-]+/gu, '').trim().slice(0, 80) || 'file';
  return `${base}.${extension}`;
}

// Sends an attachment as a download, so a browser never runs it as a page.
function sendAttachment(res, file) {
  const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Type', file.content_type);
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(file.data);
}

// Club icons are pictures only: no PDF, and no SVG, which can carry scripts.
function detectIconType(buffer) {
  const type = detectFileType(buffer);
  return type && type.contentType.startsWith('image/') ? type : null;
}

// Short letters shown when a club has no icon, for example "TT" for Tigers Taekwondo.
function clubInitials(name) {
  const words = String(name || '').split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  return words.slice(0, 2).map((w) => [...w][0].toUpperCase()).join('') || '?';
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  MAX_ICON_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_NEW_COMPETITION_FILES,
  detectIconType,
  detectAttachmentType,
  safeFilename,
  sendAttachment,
  clubInitials,
  documentTypeFor,
  documentLabel,
  detectFileType,
  sendDocument,
};
