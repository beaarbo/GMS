// Two-step login codes (TOTP, RFC 6238): the six digits an authenticator app
// shows, which change every 30 seconds. No database or web imports.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buffer) {
  let bits = '';
  buffer.forEach((byte) => { bits += byte.toString(2).padStart(8, '0'); });
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  [...clean].forEach((char) => { bits += ALPHABET.indexOf(char).toString(2).padStart(5, '0'); });
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// A new 160-bit secret, as the base32 text authenticator apps take.
function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const number = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(number).padStart(6, '0');
}

function currentCode(secret, now = Date.now()) {
  return codeAt(secret, Math.floor(now / 1000 / STEP_SECONDS));
}

// Accepts the code for now or 30 seconds either side, for a phone clock that's slightly off.
function verifyCode(secret, code, now = Date.now()) {
  const given = String(code || '').replace(/\s/g, '');
  if (!secret || !/^\d{6}$/.test(given)) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  return [-1, 0, 1].some((drift) => crypto.timingSafeEqual(Buffer.from(codeAt(secret, counter + drift)), Buffer.from(given)));
}

// The link an authenticator app reads, for apps that accept a pasted link.
function otpauthUrl(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// "ABCD EFGH ..." is easier to type into a phone.
function groupSecret(secret) {
  return secret.match(/.{1,4}/g).join(' ');
}

// Ten one-time recovery codes, for a lost phone. Only their hashes are kept.
function newRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toLowerCase().replace(/[^0-9a-f]/g, '')).digest('hex');
}

module.exports = { newSecret, currentCode, verifyCode, otpauthUrl, groupSecret, newRecoveryCodes, hashRecoveryCode, base32Encode, base32Decode };
