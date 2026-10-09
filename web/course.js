// IndoorWarior Island: the built-in course, ridden like a GPX route but with
// its own scenery (a start arch, team tents, a village, flags on the summit).
// A 12.6 km loop: flat start through the village, rolling forest, a 2.4 km
// climb with switchbacks at about 6% (a 10% kick near the top), a summit,
// a long descent and a flat run home.
//
// The road is a smooth curve through hand-placed points, sampled every 5 m.
// It is placed in the North Sea off the Belgian coast, so a ride uploaded to
// Strava shows its map over open water rather than on someone's real roads.
(function () {
  const LAT0 = 51.62, LON0 = 2.42;
  // Control points in metres: x east, y north. The loop closes on itself.
  const P = [
    [0, 0], [700, -40], [1500, 120], [2250, 520], [2800, 1300], [2650, 2150],
    [2950, 2550], [2500, 2850], [2950, 3200], [2450, 3550], [2000, 3820],
    [1250, 3950], [600, 3520], [120, 2820], [-380, 2020], [-520, 1050], [-330, 330],
  ];
  // Height (m) at a share of the lap: flat, rolling, climb, summit, descent, flat.
  const PROFILE = [
    [0, 4], [0.07, 6], [0.12, 2], [0.17, 9], [0.2, 4], [0.26, 22], [0.3, 40], [0.36, 80],
    [0.41, 118], [0.435, 150], [0.455, 172], [0.5, 174], [0.56, 150], [0.64, 95], [0.72, 45],
    [0.79, 14], [0.86, 8], [0.92, 12], [1, 4],
  ];
  // Centripetal Catmull-Rom through the closed loop of points.
  function curve(step) {
    const n = P.length, out = [];
    const at = i => P[(i + n) % n];
    for (let i = 0; i < n; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), m = Math.max(2, Math.ceil(seg / 2));
      for (let k = 0; k < m; k++) {
        const t = k / m, t2 = t * t, t3 = t2 * t;
        const f = c => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
        out.push([f(0), f(1)]);
      }
    }
    out.push(out[0].slice());
    // Even spacing along the curve.
    const d = [0];
    for (let i = 1; i < out.length; i++) d.push(d[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
    const total = d[d.length - 1], pts = [];
    for (let s = 0, j = 0; s <= total; s += step) {
      while (j < out.length - 2 && d[j + 1] < s) j++;
      const f = (s - d[j]) / (d[j + 1] - d[j] || 1);
      pts.push({ x: out[j][0] + (out[j + 1][0] - out[j][0]) * f, y: out[j][1] + (out[j + 1][1] - out[j][1]) * f, s });
    }
    return { pts, total };
  }
  function height(share) {
    let i = 0;
    while (i < PROFILE.length - 2 && PROFILE[i + 1][0] < share) i++;
    const [a, ha] = PROFILE[i], [b, hb] = PROFILE[i + 1], t = Math.min(1, Math.max(0, (share - a) / (b - a)));
    return ha + (hb - ha) * (1 - Math.cos(t * Math.PI)) / 2; // eased between points
  }
  function build() {
    const { pts, total } = curve(5), k = Math.cos((LAT0 * Math.PI) / 180);
    const points = pts.map(p => ({ lat: LAT0 + p.y / 110540, lon: LON0 + p.x / (111320 * k), ele: height(p.s / total) }));
    return {
      name: 'IndoorWarior Island',
      points,
      // Scenery along the lap, by distance in metres (scaled to the real length).
      scenery: total && {
        arch: [25],
        tents: [[-60, 'left'], [-140, 'right']],     // negative: before the line, at the end of the lap
        villages: [[260, 1250], [total * 0.93, total - 200]],
        flags: [[total * 0.43, total * 0.5]],
        clearings: [[total * 0.455, total * 0.5]],    // open summit, no trees
      },
    };
  }
  window.IW_COURSES = { island: build };
})();
