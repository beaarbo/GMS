// News posts: reading the admin's form and turning a plain-text body into
// paragraphs with clickable links. No database or web imports.

const MAX_TITLE = 150;
const MAX_BODY = 10000;
const AUDIENCES = { public: 'Everyone', members: 'Coaches and organisers only' };

function readPost(body) {
  const text = (value, max) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max + 1) : '');
  const values = {
    title: text(body.title, MAX_TITLE),
    body: text(body.body, MAX_BODY),
    audience: AUDIENCES[body.audience] ? body.audience : '',
    pinned: body.pinned === '1' ? 1 : 0,
  };
  const errors = [];
  if (!values.title) errors.push('Enter a title.');
  else if (values.title.length > MAX_TITLE) errors.push(`Keep the title to ${MAX_TITLE} characters.`);
  if (!values.body) errors.push('Write the post.');
  else if (values.body.length > MAX_BODY) errors.push(`Keep the post to ${MAX_BODY} characters.`);
  if (!values.audience) errors.push('Choose who can see the post.');
  return { values, errors };
}

// Splits text into paragraphs (blank lines), lines, and pieces of plain text or
// http(s) links. Templates escape every piece, so no HTML from the post is kept.
function formatBody(text) {
  const linkPattern = /\bhttps?:\/\/[^\s<>"]+/gi;
  const pieces = (line) => {
    const result = [];
    let last = 0;
    for (const match of line.matchAll(linkPattern)) {
      // A link at the end of a sentence shouldn't swallow its full stop or bracket.
      const url = match[0].replace(/[.,;:!?)\]]+$/, '');
      if (match.index > last) result.push({ text: line.slice(last, match.index) });
      result.push({ url });
      last = match.index + url.length;
    }
    if (last < line.length) result.push({ text: line.slice(last) });
    return result;
  };
  return String(text || '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => paragraph.split('\n').map(pieces));
}

// A short plain-text preview for lists.
function summary(text, length = 220) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= length) return flat;
  return `${flat.slice(0, flat.lastIndexOf(' ', length) > 0 ? flat.lastIndexOf(' ', length) : length)}…`;
}

module.exports = { AUDIENCES, MAX_TITLE, MAX_BODY, readPost, formatBody, summary };
