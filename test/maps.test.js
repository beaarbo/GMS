const test = require('node:test');
const assert = require('node:assert');
const { readMapLocation, mapEmbedUrl } = require('../src/maps');

test('map locations: typed text as is, and the place out of a full Google Maps link', () => {
  assert.deepEqual(readMapLocation('  OCBC Arena, Singapore '), { ok: true, query: 'OCBC Arena, Singapore' });
  assert.deepEqual(readMapLocation(''), { ok: true, query: '' });
  assert.equal(readMapLocation('https://www.google.com/maps/place/OCBC+Arena/@1.30,103.87,17z').query, 'OCBC Arena');
  assert.equal(readMapLocation('https://www.google.com/maps/search/?api=1&query=Kallang%20Wave').query, 'Kallang Wave');
  assert.equal(readMapLocation('https://www.google.com.sg/maps?q=Jurong+East').query, 'Jurong East');
  assert.equal(readMapLocation('https://www.google.com/maps/@1.3521,103.8198,12z').query, '1.3521,103.8198');
  assert.equal(readMapLocation('https://maps.app.goo.gl/abc123').ok, false, 'short links need fetching');
  assert.equal(readMapLocation('https://evil.example/maps?q=x').ok, false, 'only Google Maps links');
  assert.equal(mapEmbedUrl('A & B'), 'https://www.google.com/maps?q=A%20%26%20B&output=embed');
});
