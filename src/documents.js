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

module.exports = {
  MAX_DOCUMENT_BYTES,
  documentTypeFor,
  documentLabel,
  detectFileType,
  sendDocument,
};
