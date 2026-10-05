import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RIDER, steadyStateSpeed, stepSpeed } from '../src/physics.js';

test('200 W on the flat settles around 33-36 km/h', () => {
  const kmh = steadyStateSpeed(200, 0) * 3.6;
  assert.ok(kmh > 32 && kmh < 37, `got ${kmh}`);
});

test('climbing is much slower than the flat', () => {
  const flat = steadyStateSpeed(250, 0);
  const climb = steadyStateSpeed(250, 0.08);
  assert.ok(climb < flat / 2.5, `flat ${flat}, climb ${climb}`);
  // 250 W at 84 kg on 8% is roughly 11-13 km/h.
  assert.ok(climb * 3.6 > 10 && climb * 3.6 < 14, `got ${climb * 3.6}`);
});

test('integrating stepSpeed converges to steady state', () => {
  let v = 0;
  for (let i = 0; i < 3000; i++) v = stepSpeed(v, 200, 0.02, 0.05);
  assert.ok(Math.abs(v - steadyStateSpeed(200, 0.02)) < 0.05);
});

test('freewheeling downhill accelerates, uphill comes to a stop without rolling back', () => {
  assert.ok(stepSpeed(5, 0, -0.06, 1) > 5);
  let v = 3;
  for (let i = 0; i < 100; i++) v = stepSpeed(v, 0, 0.1, 0.1);
  assert.equal(v, 0);
});

test('heavier riders climb slower at the same power', () => {
  const light = steadyStateSpeed(250, 0.07, { ...DEFAULT_RIDER, riderKg: 60 });
  const heavy = steadyStateSpeed(250, 0.07, { ...DEFAULT_RIDER, riderKg: 95 });
  assert.ok(light > heavy);
});
