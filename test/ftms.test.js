import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CrankCadence,
  encodeSimulation,
  parseControlResponse,
  parseCyclingPower,
  parseHeartRate,
  parseIndoorBikeData,
} from '../src/ftms.js';

const view = (bytes) => new DataView(new Uint8Array(bytes).buffer);

test('parses FTMS indoor bike data with speed, cadence and power', () => {
  // flags 0x0044: speed present (bit0 clear), cadence (bit2), power (bit6)
  const v = view([0x44, 0x00, 0xc4, 0x09, 0xb4, 0x00, 0xfa, 0x00]);
  assert.deepEqual(parseIndoorBikeData(v), { speedKmh: 25, cadence: 90, power: 250, heartRate: null });
});

test('skips optional FTMS fields to find power and heart rate', () => {
  // flags: avg speed (bit1), cadence (bit2), total distance (bit4), power (bit6), HR (bit9)
  const flags = 0x0002 | 0x0004 | 0x0010 | 0x0040 | 0x0200;
  const v = view([flags & 0xff, flags >> 8, 0x10, 0x27, 0x10, 0x27, 0xa0, 0x00, 0x10, 0x00, 0x00, 0x2c, 0x01, 0x8c]);
  const d = parseIndoorBikeData(v);
  assert.equal(d.speedKmh, 100);
  assert.equal(d.cadence, 80);
  assert.equal(d.power, 300);
  assert.equal(d.heartRate, 140);
});

test('"More Data" flag means no instantaneous speed', () => {
  const v = view([0x41, 0x00, 0x64, 0x00]);
  assert.deepEqual(parseIndoorBikeData(v), { speedKmh: null, cadence: null, power: 100, heartRate: null });
});

test('encodes simulation parameters: 5% grade', () => {
  const bytes = encodeSimulation({ grade: 0.05, crr: 0.004, cw: 0.51 });
  assert.deepEqual([...bytes], [0x11, 0x00, 0x00, 0xf4, 0x01, 40, 51]);
});

test('encodes negative grade as signed int16', () => {
  const bytes = encodeSimulation({ grade: -0.035 });
  const dv = new DataView(bytes.buffer);
  assert.equal(dv.getInt16(3, true), -350);
});

test('parses control point responses', () => {
  assert.deepEqual(parseControlResponse(view([0x80, 0x00, 0x01])), { op: 0, code: 1, ok: true, result: 'success' });
  assert.equal(parseControlResponse(view([0x80, 0x11, 0x05])).result, 'control not permitted');
  assert.equal(parseControlResponse(view([0x11, 0x00, 0x01])), null);
});

test('parses cycling power with crank data and derives cadence', () => {
  // flags: crank revolution data present (bit5)
  const p1 = parseCyclingPower(view([0x20, 0x00, 0xc8, 0x00, 0x0a, 0x00, 0x00, 0x04]));
  assert.deepEqual(p1, { power: 200, crankRevs: 10, crankTime: 1024 });
  const c = new CrankCadence();
  c.update(p1.crankRevs, p1.crankTime, 0);
  // 3 revs in 2 s = 90 rpm
  assert.equal(c.update(13, 1024 + 2048, 2000), 90);
  // counter wrap-around
  const w = new CrankCadence();
  w.update(65535, 65000, 0);
  assert.equal(w.update(1, (65000 + 1024) & 0xffff, 1000), 120);
});

test('parses 8- and 16-bit heart rate', () => {
  assert.equal(parseHeartRate(view([0x00, 150])), 150);
  assert.equal(parseHeartRate(view([0x01, 0x2c, 0x01])), 300);
});
