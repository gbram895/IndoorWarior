// Built-in fictional worlds.

import { Route } from './route.js';

/**
 * Build a route from a parametric path. Elevation comes either from
 * `elevation(f)` (f = fraction of distance; must be periodic for loops) or by
 * integrating `grade(f)`.
 */
function synthetic({ name, steps, loop, path, elevation, grade, startEle = 0 }) {
  const pts = [];
  const last = loop ? steps - 1 : steps;
  for (let i = 0; i <= last; i++) {
    const [x, z] = path(i / steps);
    pts.push({ x, z, ele: 0 });
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  const closing = loop ? Math.hypot(pts[0].x - pts[last].x, pts[0].z - pts[last].z) : 0;
  const total = cum[cum.length - 1] + closing;
  let ele = startEle;
  pts.forEach((p, i) => {
    if (elevation) {
      p.ele = elevation(cum[i] / total);
    } else {
      if (i > 0) ele += grade(cum[i] / total) * (cum[i] - cum[i - 1]);
      p.ele = ele;
    }
  });
  return new Route({ name, points: pts, loop, kind: 'fictional' });
}

const TAU = Math.PI * 2;

export const BUILTIN_ROUTES = [
  {
    id: 'meadow',
    blurb: 'Gentle warm-up loop through the meadows.',
    build: () =>
      synthetic({
        name: 'Meadow Spin',
        steps: 800,
        loop: true,
        path: (u) => {
          const t = u * TAU;
          return [900 * Math.cos(t) + 120 * Math.sin(2 * t), 600 * Math.sin(t)];
        },
        elevation: (f) => 40 + 6 * Math.sin(TAU * 2 * f) + 3 * Math.sin(TAU * 5 * f + 0.7),
      }),
  },
  {
    id: 'coast',
    blurb: 'Rolling island loop with punchy hills and fast flats.',
    build: () =>
      synthetic({
        name: 'Warrior Coast Loop',
        steps: 2000,
        loop: true,
        path: (u) => {
          const t = u * TAU;
          const r = 1400 + 260 * Math.sin(3 * t) + 120 * Math.cos(5 * t + 0.5);
          return [r * Math.cos(t), r * Math.sin(t)];
        },
        elevation: (f) =>
          15 + 22 * Math.sin(TAU * 2 * f) + 9 * Math.sin(TAU * 5 * f + 1) + 4 * Math.sin(TAU * 11 * f),
      }),
  },
  {
    id: 'volcano',
    blurb: 'Spiral climb to the crater. Gets steeper the higher you go.',
    build: () =>
      synthetic({
        name: 'Volcano Ascent',
        steps: 3000,
        loop: false,
        path: (u) => {
          const t = u * 2.75 * TAU;
          const r = (1600 - 1250 * Math.pow(u, 0.8)) * (1 + 0.04 * Math.sin(9 * t));
          return [r * Math.cos(t), r * Math.sin(t)];
        },
        grade: (f) => 0.035 + 0.045 * f + 0.012 * Math.sin(f * 40),
        startEle: 5,
      }),
  },
];
