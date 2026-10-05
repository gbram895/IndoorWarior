import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Route, parseGpx } from '../src/route.js';
import { BUILTIN_ROUTES } from '../src/routes.js';
import { createHeightField } from '../src/terrain.js';
import { buildTcx } from '../src/tcx.js';

function straightClimb(grade, length = 2000) {
  const pts = [];
  for (let d = 0; d <= length; d += 50) pts.push({ x: d, z: 0, ele: d * grade });
  return new Route({ name: 'ramp', points: pts });
}

test('resamples and measures a constant gradient', () => {
  const r = straightClimb(0.06);
  assert.ok(Math.abs(r.length - 2000) < 1e-6);
  const mid = r.sample(1000);
  assert.ok(Math.abs(mid.grade - 0.06) < 1e-3, `grade ${mid.grade}`);
  assert.ok(Math.abs(mid.y - 60) < 0.5);
  assert.ok(Math.abs(r.ascent - 120) < 3);
  assert.equal(mid.dirX, 1);
});

test('non-loop routes clamp, loops wrap', () => {
  const r = straightClimb(0.02);
  assert.equal(r.sample(5000).distance, r.length);
  const loop = BUILTIN_ROUTES.find((b) => b.id === 'coast').build();
  assert.ok(loop.loop);
  const a = loop.sample(100);
  const b = loop.sample(100 + loop.length);
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6);
});

test('built-in worlds have sensible size and gradients', () => {
  for (const def of BUILTIN_ROUTES) {
    const r = def.build();
    const maxGrade = Math.max(...r.grades);
    assert.ok(r.length > 2000, `${r.name} length ${r.length}`);
    assert.ok(maxGrade < 0.15, `${r.name} max grade ${maxGrade}`);
  }
  const volcano = BUILTIN_ROUTES.find((b) => b.id === 'volcano').build();
  assert.ok(volcano.ascent > 500, `volcano ascent ${volcano.ascent}`);
});

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="test"><trk><name>Alpe Test</name><trkseg>
<trkpt lat="45.0000" lon="6.0000"><ele>700</ele></trkpt>
<trkpt lat="45.0090" lon="6.0000"><ele>760</ele></trkpt>
<trkpt lat='45.0180' lon='6.0000'><ele>820</ele></trkpt>
<trkpt lat="45.0270" lon="6.0000"/>
</trkseg></trk></gpx>`;

test('parses GPX track points, filling missing elevation', () => {
  const { name, points } = parseGpx(GPX);
  assert.equal(name, 'Alpe Test');
  assert.equal(points.length, 4);
  assert.equal(points[3].ele, 820);
});

test('GPX routes become real-world routes with lat/lon', () => {
  const r = Route.fromGpx(GPX);
  assert.equal(r.kind, 'real');
  assert.ok(Math.abs(r.length - 3002) < 10, `length ${r.length}`);
  const start = r.sample(0);
  assert.ok(Math.abs(start.lat - 45) < 1e-6 && Math.abs(start.lon - 6) < 1e-6);
  const end = r.sample(r.length);
  assert.ok(Math.abs(end.lat - 45.027) < 1e-5);
  // Heading north means -z in world space.
  assert.ok(r.sample(500).dirZ < -0.99);
  assert.ok(r.sample(500).grade > 0.05);
});

test('terrain sits just below the road and rises away from it', () => {
  const r = BUILTIN_ROUTES.find((b) => b.id === 'coast').build();
  const field = createHeightField(r);
  for (let d = 0; d < r.length; d += 997) {
    const s = r.sample(d);
    const { h, d: dist } = field.at(s.x, s.z);
    assert.ok(dist < 6, `distance to road ${dist}`);
    assert.ok(h < s.y && h > s.y - 1.5, `terrain ${h} vs road ${s.y}`);
  }
  const far = field.at(0, 0);
  assert.ok(Number.isFinite(far.h) && far.d > 500);
});

test('TCX export contains trackpoints with power', () => {
  const start = Date.UTC(2026, 9, 5, 7, 0, 0);
  const xml = buildTcx({
    startTime: start,
    name: 'Test & Co',
    samples: [
      { time: start + 1000, distance: 8, speed: 8, power: 210, cadence: 90, hr: null, ele: 10 },
      { time: start + 2000, distance: 16, speed: 8, power: 220, cadence: 91, hr: 140, ele: 10.1, lat: 45, lon: 6 },
    ],
  });
  assert.match(xml, /<Id>2026-10-05T07:00:00.000Z<\/Id>/);
  assert.equal((xml.match(/<Trackpoint>/g) || []).length, 2);
  assert.match(xml, /<ns3:Watts>220<\/ns3:Watts>/);
  assert.match(xml, /<LatitudeDegrees>45.0000000<\/LatitudeDegrees>/);
  assert.match(xml, /<HeartRateBpm><Value>140<\/Value><\/HeartRateBpm>/);
  assert.ok(!xml.includes('Test & Co'));
});
