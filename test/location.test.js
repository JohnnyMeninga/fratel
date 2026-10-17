import test from 'node:test';
import assert from 'node:assert/strict';
import { validCoordinates, distanceKm, mapPoints, requestBrowserLocation } from '../public/location.js';

test('Haversine agrees with London to New York reference within 2 km', () => {
  const distance = distanceKm({ latitude: 51.5074, longitude: -0.1278 }, { latitude: 40.7128, longitude: -74.006 });
  assert.ok(Math.abs(distance - 5570.2) < 2);
});

test('identical, zero, antipodal, and antimeridian coordinates remain finite', () => {
  assert.equal(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
  assert.ok(Math.abs(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 }) - 20015.1144) < 0.01);
  assert.ok(distanceKm({ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 }) < 23);
});

test('coordinates reject incomplete, nonnumeric, and out-of-range inputs', () => {
  for (const value of [null, {}, { latitude: null, longitude: 0 }, { latitude: '0', longitude: 0 },
    { latitude: NaN, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }]) {
    assert.equal(validCoordinates(value), false);
    assert.equal(distanceKm(value, { latitude: 0, longitude: 0 }), null);
  }
});

test('map points cross the antimeridian by the shortest path without mutating locations', () => {
  const gps = { latitude: 0, longitude: -179 };
  assert.deepEqual(mapPoints({ latitude: 0, longitude: 179 }, gps), [[0, 179], [0, 181]]);
  assert.equal(gps.longitude, -179);
  assert.deepEqual(mapPoints(null, gps), [[0, -179]]);
  assert.deepEqual(mapPoints(null, null), []);
});

test('geolocation requests high accuracy with no cached result', async () => {
  const result = await requestBrowserLocation({ secureContext: true, geolocation: {
    getCurrentPosition(success, failure, options) {
      assert.deepEqual(options, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
      success({ coords: { latitude: 0, longitude: 0, accuracy: 12 }, timestamp: 1234 });
    },
  } });
  assert.deepEqual(result, { latitude: 0, longitude: 0, accuracy: 12, timestamp: 1234 });
});

for (const [code, expected] of [[1, 'GPS_DENIED'], [2, 'GPS_UNAVAILABLE'], [3, 'GPS_TIMEOUT'], [99, 'GPS_UNAVAILABLE']]) {
  test(`geolocation error ${code} produces ${expected}`, async () => {
    await assert.rejects(requestBrowserLocation({ secureContext: true, geolocation: {
      getCurrentPosition(success, failure) { failure({ code }); },
    } }), { code: expected });
  });
}

test('unsupported browsers and insecure contexts fail with explicit messages', async () => {
  await assert.rejects(requestBrowserLocation({ secureContext: false }), { code: 'INSECURE_CONTEXT' });
  await assert.rejects(requestBrowserLocation({ secureContext: true, geolocation: null }), { code: 'UNSUPPORTED' });
});

test('invalid browser coordinates and synchronous security exceptions are handled', async () => {
  await assert.rejects(requestBrowserLocation({ secureContext: true, geolocation: {
    getCurrentPosition(success) { success({ coords: { latitude: null, longitude: 0, accuracy: 1 } }); },
  } }), { code: 'INVALID_GPS' });
  await assert.rejects(requestBrowserLocation({ secureContext: true, geolocation: {
    getCurrentPosition() { throw new Error('Security exception'); },
  } }), { code: 'GPS_UNAVAILABLE' });
});