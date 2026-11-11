// A competition's map location: an address, place name or "lat,lng" that Google
// Maps can search for. Shown with Google's keyless embed, so no API key is needed.

// Reads what the admin typed or pasted. A full Google Maps link gives up its place
// (?q=, /place/Name/ or @lat,lng). Short share links (maps.app.goo.gl) can't be
// read without fetching them, so the admin is asked for the address instead.
// Returns { ok, query } or { ok: false, error }.
function readMapLocation(input) {
  const text = String(input ?? '').trim().slice(0, 300);
  if (!/^https?:\/\//i.test(text)) return { ok: true, query: text };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'That map link could not be read. Type the address or place name instead.' };
  }
  if (!/(^|\.)google\.[a-z.]+$/i.test(url.hostname) || !url.pathname.startsWith('/maps')) {
    return { ok: false, error: 'Paste a full Google Maps link, or type the address or place name. Short links (maps.app.goo.gl) don\'t work here.' };
  }
  const q = url.searchParams.get('q') || url.searchParams.get('query');
  if (q) return { ok: true, query: q.trim() };
  const place = url.pathname.match(/\/place\/([^/]+)/);
  if (place) return { ok: true, query: decodeURIComponent(place[1].replace(/\+/g, ' ')).trim() };
  const at = url.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) return { ok: true, query: `${at[1]},${at[2]}` };
  return { ok: false, error: 'That Google Maps link has no place in it. Type the address or place name instead.' };
}

const mapEmbedUrl = (query) => `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
const mapOpenUrl = (query) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

module.exports = { readMapLocation, mapEmbedUrl, mapOpenUrl };
