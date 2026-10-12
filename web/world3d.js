// IndoorWarior 3D view: rides a GPX route in three.js (r149, vendor/three.min.js,
// a classic script so it also works when index.html is opened as a file).
//
// The road follows the route's real shape and elevation. For a GPX route the
// land is the real place (see "The real place" below and places.js); for the
// built-in course, or when that cannot load, it is made up: rolling hills,
// fields and hedges, woods, the verge and a sign every kilometre, all from a
// fixed seed so the same route always looks the same.
// Everything is built once per route, in 600 m pieces so only the ones near the
// rider get drawn; each frame only moves the rider and the camera, so it runs on
// a laptop's built-in graphics.
(function () {
  const T = THREE;
  const ROAD_HALF = 3;            // m, half the road width
  const STEP = 10;                // m between route points (ROUTE_STEP in index.html)
  const FAR = 700;                // m, how far the camera draws (the land ends there)
  const SKY = 0xbcd3e6;
  const HAZE = 0xc8d7e4;          // the sky at the horizon, and the fog
  const KEEP = 1.3;               // m right of the centre line
  const LIFT = 1.6;               // drawn steepness vs real (see geometryOf)
  const CHUNK = 60;               // route points per piece of world (even)

  // ---- Deterministic randomness and smooth noise for the hills.
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
  function hash(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
  function noise(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const hills = (x, z) => noise(x / 420, z / 420) * 38 + noise(x / 130, z / 130) * 9 + noise(x / 35, z / 35) * 1.6 - 14;
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // How much of the made-up hills shows at a distance from the road (0 on the verge).
  const hillWeight = o => smooth(6, 70, Math.abs(o));

  // ---- What the road under each route point is made of, from the map's ways:
  // 0 tarmac, 1 gravel (compacted, fine gravel, a good track), 2 dirt (earth,
  // grass, sand, a rough track or a path). Each point takes the nearest way
  // within 12 m that runs the same way as the route (so a crossing road does
  // not count); stretches under 50 m take the surface either side of them.
  const GRAVEL = /^(gravel|fine_gravel|compacted|unpaved|pebblestone|shells|woodchips)$/;
  const DIRT = /^(dirt|earth|ground|grass|grass_paver|mud|sand|soil|rock)$/;
  const PAVED = /^(asphalt|paved|concrete|concrete:plates|concrete:lanes|chipseal|paving_stones|sett|cobblestone|unhewn_cobblestone|metal|wood|bricks)$/;
  function surfaceKind(t) {
    const sf = (t.surface || '').split(';')[0];
    if (PAVED.test(sf)) return 0;
    if (GRAVEL.test(sf)) return 1;
    if (DIRT.test(sf)) return 2;
    if (t.highway === 'track') return t.tracktype === 'grade1' ? 0 : /grade[45]/.test(t.tracktype || '') ? 2 : 1;
    if (/^(path|bridleway)$/.test(t.highway)) return 2;
    return 0;
  }
  function surfacesOf(res, osm) {
    const n = res.length, out = new Uint8Array(n);
    if (!osm?.roads?.length || n < 2) return out;
    const lat0 = res[0].lat, lon0 = res[0].lon, k = Math.cos((lat0 * Math.PI) / 180);
    const xy = (la, lo) => [(lo - lon0) * 111320 * k, (la - lat0) * 110540];
    // Every way's pieces in 50 m cells.
    const CELL = 50, cells = new Map(), key = (i, j) => i * 100003 + j;
    for (const r of osm.roads) {
      const kind = surfaceKind(r.tags || {}), pts = r.line.map(p => xy(p[0], p[1]));
      for (let q = 0; q + 1 < pts.length; q++) {
        const a = pts[q], b = pts[q + 1], seg = { a, b, kind };
        const i0 = Math.floor((Math.min(a[0], b[0]) - 12) / CELL), i1 = Math.floor((Math.max(a[0], b[0]) + 12) / CELL);
        const j0 = Math.floor((Math.min(a[1], b[1]) - 12) / CELL), j1 = Math.floor((Math.max(a[1], b[1]) + 12) / CELL);
        if ((i1 - i0) * (j1 - j0) > 400) continue; // a way far longer than its points say: skip it
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const c = key(i, j); (cells.get(c) || cells.set(c, []).get(c)).push(seg); }
      }
    }
    const P = res.map(p => xy(p.lat, p.lon)), found = new Int8Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const p = P[i], a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
      const dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, dx = (b[0] - a[0]) / dl, dy = (b[1] - a[1]) / dl;
      let best = 12;
      for (const seg of cells.get(key(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL))) || []) {
        const sx = seg.b[0] - seg.a[0], sy = seg.b[1] - seg.a[1], sl = Math.hypot(sx, sy) || 1;
        if (Math.abs((sx * dx + sy * dy) / sl) < 0.8) continue; // more than ~37° off: a road crossing or beside
        const t = Math.max(0, Math.min(1, ((p[0] - seg.a[0]) * sx + (p[1] - seg.a[1]) * sy) / (sl * sl)));
        const d = Math.hypot(p[0] - seg.a[0] - sx * t, p[1] - seg.a[1] - sy * t);
        if (d < best) { best = d; found[i] = seg.kind; }
      }
    }
    // Points with no way near keep the surface of the nearest point that has one.
    let last = -1;
    for (let i = 0; i < n; i++) if (found[i] >= 0) last = found[i]; else if (last >= 0) found[i] = last;
    for (let i = n - 1, next = 0; i >= 0; i--) if (found[i] >= 0) { next = found[i]; out[i] = next; } else out[i] = next;
    // No flicker: a run shorter than 5 points (50 m) takes the run before it.
    for (let i = 0; i < n;) {
      let j = i; while (j < n && out[j] === out[i]) j++;
      if (j - i < 5 && (i > 0 || j < n)) out.fill(i > 0 ? out[i - 1] : out[j], i, j);
      i = j;
    }
    return out;
  }

  // ---- The route as 3D points: x east, z south, y up, in metres from the start.
  // A free ride's road that grew passes the last geometry as `prev` and how
  // many of its points stay (`keep`): those keep exactly what they had, so the
  // world already built along them does not move, and the new road eases on
  // from them.
  function geometryOf(route, prev, keep = 0) {
    const res = route.res, n = res.length;
    if (!prev) keep = 0;
    keep = Math.min(keep, n, prev ? prev.n : 0);
    const lat0 = res[0].lat, lon0 = res[0].lon, k = Math.cos((lat0 * Math.PI) / 180);
    const raw = res.map((p, i) => i < keep ? prev.xz[i] : [(p.lon - lon0) * 111320 * k, -(p.lat - lat0) * 110540]);
    // GPS wobble makes the road zigzag; average a few points either side.
    // The window stays centred, so the ends don't get pulled inwards (that
    // left a 30 m gap at the line of a loop); a loop averages round the line.
    const xz = raw.map((_, i) => {
      if (i < keep) return prev.xz[i];
      const w = route.loop ? 3 : Math.min(3, i, n - 1 - i);
      let x = 0, z = 0, c = 0;
      for (let j = i - w; j <= i + w; j++) { const q = raw[route.loop ? (((j % (n - 1)) + n - 1) % (n - 1)) : j]; x += q[0]; z += q[1]; c++; } // a loop's last point is its first
      return [x / c, z / c];
    });
    // Heights are drawn 1.6x steeper than they are. From a chase camera a true
    // 8% looks almost flat; this makes it read like the climb it feels like.
    // Only the picture: gradient, speed and the trainer use the real figures.
    const ele0 = prev ? prev.ele0 : res[0].ele;
    const y = res.map((p, i) => i < keep ? prev.y[i] : (p.ele - ele0) * LIFT);
    const dup = sameRoad(xz, y, !!route.loop, route.roam?.turns);
    for (let i = 0; i < keep; i++) { xz[i] = prev.xz[i]; y[i] = prev.y[i]; dup[i] = prev.dup[i]; }
    // Right-hand side of the direction of travel, flat.
    const side = xz.map((_, i) => {
      // A loop's ends share one direction, so the road closes without a crack at the line.
      const a = xz[route.loop && i === 0 ? n - 2 : Math.max(0, i - 1)], b = xz[route.loop && i === n - 1 ? 1 : Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      return [-dz / l, dx / l];
    });
    // The lie of the land: the road's height averaged over 1.2 km. Away from
    // the road the land sits at this level instead of copying the road, so a
    // climb starts in a cutting and ends on a shoulder with the valley below,
    // rather than the whole world tilting with the rider.
    const W = 60, sum = [0];
    for (let i = 0; i < n; i++) sum.push(sum[i] + y[i]);
    const base = y.map((_, i) => { const a = Math.max(0, i - W), b = Math.min(n, i + W + 1); return (sum[b] - sum[a]) / (b - a); });
    // On a climb the road runs along a hillside: the land rises on one side and
    // falls away on the other, more on steeper road. Which side wanders slowly.
    const tilt = y.map((_, i) => {
      const a = Math.max(0, i - 10), b = Math.min(n - 1, i + 10);
      const slope = (y[b] - y[a]) / ((b - a) * STEP || 1);
      return Math.abs(slope) * 0.9 * (noise(i / 150, 0.5) * 2 - 1 >= 0 ? 1 : -1);
    });
    // How sharply the road bends at each point (1 / radius), so the land strip
    // beside it can stop short on the inside of a hairpin instead of folding.
    const bend = xz.map((_, i) => {
      const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
      const h0 = Math.atan2(side[a][0], -side[a][1]), h1 = Math.atan2(side[b][0], -side[b][1]);
      let dh = h1 - h0; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      return dh / (((b - a) || 1) * STEP); // + bends right, - left
    });
    if (keep) { // the kept points as they were; the new ones ease away from them
      freeze(side, prev.side, keep, 0); freeze(bend, prev.bend, keep, 0);
      freeze(base, prev.base, keep, W); freeze(tilt, prev.tilt, keep, 20);
    }
    // Road points in 100 m buckets, to find the road near any spot quickly.
    const hash = new Map();
    xz.forEach(([x, z], i) => { const k = bucket(x, z); hash.get(k)?.push(i) || hash.set(k, [i]); });
    // Back and forth between metres and latitude/longitude (the exact inverse of raw above).
    const ll = (x, z) => [lat0 - z / 110540, lon0 + x / (111320 * k)];
    const xzOf = (lat, lon) => [(lon - lon0) * 111320 * k, -(lat - lat0) * 110540];
    return { n, xz, y, side, base, tilt, bend, hash, dup, loop: !!route.loop, ll, xzOf, ele0, surf: route.surface?.length === n ? route.surface : null };
  }
  // Points before `keep` take their old values; a number goes on from where
  // its old value ended and blends into its new one over `ease` points.
  function freeze(now, old, keep, ease) {
    const jump = typeof old[0] === 'number' && keep < now.length ? old[keep - 1] - now[keep - 1] : 0;
    for (let i = 0; i < keep; i++) now[i] = old[i];
    if (jump && ease) for (let i = keep; i < Math.min(now.length, keep + ease); i++) now[i] += jump * (1 - (i - keep + 1) / ease);
  }

  // Out and back, or any road ridden twice: where the route runs along road
  // it has already used (the same line either way, within 15 m, at about the
  // same height: not the next leg of a hairpin), its points are moved onto
  // that road, height and all, instead of making a second road a few metres
  // off that fights the first. Close in (6 m) they sit exactly on it; out to
  // 15 m they ease across, so joining it is a smooth bend.
  // Returns dup[i] = 1 where point i is on road already drawn, so neither the
  // road nor the scenery beside it is built twice. A road merely crossing
  // another is left alone (it is not running the same way), and so are the
  // last few hundred metres of a loop meeting its own start.
  function sameRoad(xz, y, loop, turns) {
    const n = xz.length, dup = new Uint8Array(n), seen = new Map(), CELL = 20, BEHIND = 30;
    // A free ride turned round at these points: the way back lies exactly on
    // the way there (too close behind for the search below to see it).
    const back = new Int32Array(n).fill(-1);
    for (const p of turns || []) for (let i = p; i <= p + BEHIND && i < n && 2 * p - i >= 0; i++) back[i] = 2 * p - i;
    const key = (cx, cz) => cx * 65536 + cz;
    const dir = i => { const a = xz[Math.max(0, i - 1)], b = xz[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
    for (let i = 0; i < n; i++) {
      const r = i - BEHIND; // only road well behind counts as road already there
      if (r >= 0 && r < n - 1) { const k = key(Math.floor(xz[r][0] / CELL), Math.floor(xz[r][1] / CELL)); seen.get(k)?.push(r) || seen.set(k, [r]); }
      if (back[i] >= 0) { xz[i] = xz[back[i]].slice(); y[i] = y[back[i]]; dup[i] = 1; continue; }
      const [x, z] = xz[i], cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), di = dir(i);
      let best = null;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of seen.get(key(cx + a, cz + b)) || []) {
        if (loop && n - 1 - i + j < BEHIND) continue; // a loop closing on its start
        const ax = xz[j][0], az = xz[j][1], dx = xz[j + 1][0] - ax, dz = xz[j + 1][1] - az, l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)), px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
        if (d >= 15 || (best && d >= best.d)) continue;
        const dj = dir(j), py = y[j] + (y[j + 1] - y[j]) * t;
        if (Math.abs(di[0] * dj[0] + di[1] * dj[1]) < 0.85) continue; // crossing, not running along
        if (Math.abs(y[i] - py) > 6 * LIFT) continue; // the next leg of a hairpin, higher up the mountain
        best = { d, px, pz, py };
      }
      if (!best) continue;
      const w = 1 - smooth(6, 15, best.d);
      xz[i] = [x + (best.px - x) * w, z + (best.pz - z) * w];
      y[i] += (best.py - y[i]) * w;
      if (w > 0.99) dup[i] = 1;
    }
    return dup;
  }

  // How far (x, z) is from the road, anywhere on the route: the stretch it was
  // placed beside, or another part of the route passing close by.
  function roadDist(g, x, z) {
    let best = Infinity;
    for (const j of nearRoad(g, x, z, 30)) {
      if (j >= g.n - 1) continue;
      const ax = g.xz[j][0], az = g.xz[j][1], dx = g.xz[j + 1][0] - ax, dz = g.xz[j + 1][1] - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
    return best;
  }

  // The index of the road point nearest a spot within r, or -1.
  function nearestPoint(g, x, z, r) {
    let best = -1, bd = r * r;
    for (const j of nearRoad(g, x, z, r)) { const dx = g.xz[j][0] - x, dz = g.xz[j][1] - z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = j; } }
    return best;
  }

  const BUCKET = 100;
  const bucket = (x, z) => Math.floor(x / BUCKET) * 65536 + Math.floor(z / BUCKET);
  // Road point indices within about r of (x, z).
  function nearRoad(g, x, z, r) {
    const out = [], bx = Math.floor(x / BUCKET), bz = Math.floor(z / BUCKET), k = Math.ceil(r / BUCKET);
    for (let i = bx - k; i <= bx + k; i++) for (let j = bz - k; j <= bz + k; j++) {
      const list = g.hash.get(i * 65536 + j); if (list) for (const v of list) out.push(v);
    }
    return out;
  }

  // ---- The height of the land at any spot. One function for the whole map,
  // so pieces built from different parts of the route always agree where they
  // meet (land built as strips beside the road folded over itself on bends).
  // Near the road the land meets the road's edge; further out it blends into
  // the lie of the land, hills, a hillside tilt on climbs and big far hills.
  // `cand` is a list of nearby road points to measure from.
  function landAt(g, x, z, cand) {
    let dmin = Infinity, jmin = -1;
    const ds = new Float64Array(cand.length);
    for (let k = 0; k < cand.length; k++) {
      const j = cand[k], ex = x - g.xz[j][0], ez = z - g.xz[j][1], d = Math.sqrt(ex * ex + ez * ez);
      ds[k] = d; if (d < dmin) { dmin = d; jmin = j; }
    }
    if (jmin < 0) return null;
    const dpt = dmin; // to the nearest listed point, before refining onto the segment
    // Exact distance and road height from the nearer of the two segments at the closest point.
    let roadY = g.y[jmin];
    for (const j2 of [jmin - 1, jmin + 1]) {
      if (j2 < 0 || j2 >= g.n) continue;
      const ax = g.xz[jmin][0], az = g.xz[jmin][1], dx = g.xz[j2][0] - ax, dz = g.xz[j2][1] - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)), fx = x - ax - dx * t, fz = z - az - dz * t, d = Math.sqrt(fx * fx + fz * fz);
      if (d < dmin) { dmin = d; roadY = g.y[jmin] + (g.y[j2] - g.y[jmin]) * t; }
    }
    // Smooth across the road points about as near: avoids a cliff where two
    // parts of the route are equally close (inside a hairpin, between laps).
    const width = Math.min(60, Math.max(2, dmin * 0.6));
    let sw = 0, ry = 0, b = 0, tl = 0, off = 0;
    for (let k = 0; k < cand.length; k++) {
      const e = ds[k] - dpt; if (e > width * 3) continue;
      const j = cand[k], w = Math.exp(-((e / width) ** 2));
      const so = (x - g.xz[j][0]) * g.side[j][0] + (z - g.xz[j][1]) * g.side[j][1];
      sw += w; ry += w * g.y[j]; b += w * g.base[j]; tl += w * Math.max(-300, Math.min(300, so)) * g.tilt[j];
      if (g.off) off += w * g.off[j];
    }
    const near = 1 - smooth(4, 25, dmin); // right by the road, its exact height
    roadY = roadY * near + (ry / sw) * (1 - near);
    const real = g.dem ? g.dem(x, z) : NaN;
    if (Number.isFinite(real)) {
      // The real land, shifted near the road by however far the GPX's heights
      // and the height tiles disagree there, so the road sits on it. Under
      // lakes and rivers it dips, so their water lies on top; under the sea
      // it stops just below the water.
      // Under water the GPX's offset is left out too, so a lake beside a road
      // whose heights are off by a few metres still lies under its water.
      const wet = REAL?.cover ? REAL.cover.water(x, z) : 0, shift = (off / sw) * (1 - smooth(80, 300, dmin)), k = smooth(5, 35, dmin);
      const dry = (Math.max(real, -3) - g.ele0) * LIFT + shift, land = dry - wet * (WET_DIP * LIFT + Math.max(0, shift));
      return { y: roadY - 0.12 + k * (land - roadY), d: dmin, road: roadY, h: real, dry: roadY - 0.12 + k * (dry - roadY) };
    }
    const far = smooth(120, 650, dmin);
    const land = b / sw + hills(x, z) + far * (noise(x / 900, z / 900) * 160 - 40) - tl / sw;
    return { y: roadY - 0.12 + hillWeight(dmin) * (land - roadY), d: dmin, road: roadY };
  }
  // The land at a spot within `r` of the road (searching wider if needed).
  function groundAt(g, x, z, r = 260) {
    for (const rr of [r, r * 3, 2000]) { const p = landAt(g, x, z, nearRoad(g, x, z, rr)); if (p) return p; }
    return { y: 0, d: Infinity, road: 0 };
  }

  // ---- The real place (GPX routes). places.js fetches the land's height and
  // the map; this turns them into what the land looks like: woods where the
  // map has woods, lakes and rivers, the houses of the towns ridden through,
  // farmland low down, meadows higher up, bare rock and snow on the tops.
  // REAL is the place being built (null for the made-up world); the land's
  // colour, the woods and the trees read it, like woodsAt.
  let REAL = null;

  // The real land under a route: heights in route metres, and how far the
  // GPX's own heights sit from it along the road (smoothed over 300 m).
  function useTerrain(g, near, prev, keep = 0) {
    g.dem = (x, z) => { const [lat, lon] = g.ll(x, z); return near(lat, lon); };
    const raw = g.xz.map(([x, z], i) => { const h = g.dem(x, z); return Number.isFinite(h) ? g.y[i] - (h - g.ele0) * LIFT : 0; });
    g.off = raw.map((_, i) => {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - 15); j <= Math.min(g.n - 1, i + 15); j++) { s += raw[j]; c++; }
      return s / c;
    });
    if (prev?.off && keep) freeze(g.off, prev.off, keep, 15);
  }

  // Snow lies above snowLine (m) at this time of year; trees grow up to
  // treeLine. Both from the latitude: about 2050 m for trees in the Alps,
  // lower further north. The snow line climbs through the summer.
  function climate(lat) {
    const m = new Date().getMonth(), mm = lat >= 0 ? m : (m + 6) % 12;
    const SNOW = [1100, 1100, 1400, 1900, 2500, 2800, 3000, 3100, 2900, 2600, 1900, 1300];
    const shift = (45 - Math.abs(lat)) * 85;
    return { snowLine: Math.max(300, SNOW[mm] + shift), treeLine: Math.min(3900, Math.max(250, 2050 + shift)) };
  }
  // The part of the world, for the look of the houses, crops and woods.
  const MED = new Set(['ES', 'PT', 'IT', 'GR', 'HR', 'MT', 'CY', 'MC', 'SM', 'VA', 'ME', 'AL', 'TR', 'SI', 'BA']);
  function regionOf(lat, lon, code) {
    return {
      med: MED.has(code) || (code === 'FR' && lat < 44.6) || (!code && lat > 35 && lat < 44),
      alps: code === 'CH' || code === 'AT' || code === 'LI' || (lat > 43.6 && lat < 48.3 && lon > 5 && lon < 16.5),
      // Haute-Provence and the Drôme: the lavender plateaus.
      lavender: lat > 43.4 && lat < 44.7 && lon > 4.7 && lon < 6.9,
    };
  }

  // What the map says covers the land, drawn once onto two grids over the
  // route (about 20 m cells): woods, water and built-up land on one; bare
  // rock, glacier and vineyards on the other. Each is read back smoothly,
  // 0..1, at any spot.
  // A free ride covers the squares of map loaded (bounds), not the route.
  function coverOf(g, osm, bounds) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const corners = bounds ? bounds.flatMap(([s, w, n, e]) => [g.xzOf(s, w), g.xzOf(n, e)]) : g.xz;
    for (const [x, z] of corners) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const pad = bounds ? 200 : 1300;
    x0 -= pad; z0 -= pad; x1 += pad; z1 += pad;
    const cell = Math.max(12, Math.sqrt(((x1 - x0) * (z1 - z0)) / 3e6)), W = Math.ceil((x1 - x0) / cell), H = Math.ceil((z1 - z0) / cell);
    const px = ([lat, lon]) => { const [x, z] = g.xzOf(lat, lon); return [(x - x0) / cell, (z - z0) / cell]; };
    const fill = (cx, shapes, colour) => {
      cx.fillStyle = colour;
      for (const sh of shapes) {
        cx.beginPath();
        for (const ring of sh.outer.concat(sh.inner)) ring.forEach((p, k) => { const [u, v] = px(p); if (k) cx.lineTo(u, v); else cx.moveTo(u, v); });
        cx.fill('evenodd');
      }
    };
    const layer = draw => {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.globalCompositeOperation = 'lighter'; // each colour channel its own layer
      draw(cx);
      return cx.getImageData(0, 0, W, H).data;
    };
    const a = layer(cx => {
      fill(cx, osm.woods, '#f00');
      fill(cx, osm.water, '#0f0');
      fill(cx, osm.towns, '#00f');
      fill(cx, osm.buildings.map(b => ({ outer: [b.ring], inner: [] })), '#00f');
    });
    const b = layer(cx => {
      fill(cx, osm.rock, '#f00');
      fill(cx, osm.glacier, '#0f0');
      fill(cx, osm.fields.filter(f => f.kind === 'vineyard' || f.kind === 'orchard').map(f => f.shape), '#00f');
    });
    // Rivers and streams on a grid of their own: painted as water, but the
    // land does not dip under them (they are narrower than its mesh).
    const c = osm.rivers.length ? layer(cx => {
      cx.strokeStyle = '#f00'; cx.lineCap = cx.lineJoin = 'round';
      for (const r of osm.rivers) {
        cx.lineWidth = riverWidth(r) / cell;
        cx.beginPath(); r.line.forEach((p, k) => { const [u, v] = px(p); if (k) cx.lineTo(u, v); else cx.moveTo(u, v); }); cx.stroke();
      }
    }) : null;
    const read = (data, ch) => (x, z) => {
      const fx = (x - x0) / cell - 0.5, fz = (z - z0) / cell - 0.5, i = Math.floor(fx), j = Math.floor(fz);
      if (i < 0 || j < 0 || i >= W - 1 || j >= H - 1) return 0;
      const u = fx - i, v = fz - j, k = (j * W + i) * 4 + ch, r = W * 4;
      return ((data[k] * (1 - u) + data[k + 4] * u) * (1 - v) + (data[k + r] * (1 - u) + data[k + r + 4] * u) * v) / 255;
    };
    return { forest: read(a, 0), water: read(a, 1), town: read(a, 2), rock: read(b, 0), glacier: read(b, 1), vines: read(b, 2), river: c ? read(c, 0) : () => 0 };
  }
  const riverWidth = r => r.width || (r.kind === 'river' ? 14 : r.kind === 'canal' ? 10 : 3);
  // How far (real m) the land dips under water on the map, and the land's
  // height there as if it did not: the banks the water reaches up to.
  const WET_DIP = 4;
  const dryAt = (g, x, z, r) => { const p = groundAt(g, x, z, r); return p.dry ?? p.y; };

  // The place a route runs through, from what has loaded so far: heights
  // (near, and far for the distant mountains) and the map (osm), any of
  // which may be missing.
  function realOf(route, g, data, cover) {
    const lat = route.res[0].lat, lon = route.res[0].lon, osm = data.osm;
    const R = { dem: g.dem, ele0: g.ele0, cover: osm ? cover || coverOf(g, osm, data.bounds) : null, ...climate(lat) };
    // The satellite photo of the land, where it loaded.
    R.sat = data.sat ? (x, z, out) => { const [la, lo] = g.ll(x, z); return data.sat(la, lo, out); } : null;
    // Sharp aerial photos near the rider, loaded as the land there is painted.
    const A = data.aerial;
    R.hi = A ? (x, z, out) => { const [la, lo] = g.ll(x, z); return A.sample(la, lo, out); } : null;
    R.hiEnsure = A ? (x, z, r) => { const [la, lo] = g.ll(x, z); return A.ensure(la, lo, r); } : null;
    const borders = osm ? crossings(g, osm) : [];
    const code = i => { let c = osm?.countries[osm.start]?.code || ''; for (const b of borders) if (b.i <= i) c = b.to.code; return c; };
    Object.assign(R, regionOf(lat, lon, code(0)), { code, borders });
    R.fieldTop = R.lavender ? 1300 : R.alps ? 1100 : 950;
    // Trees thin out over the last 150 m below the tree line.
    const treeOk = (x, z, h) => 1 - smooth(R.treeLine - 150 + (noise(x / 60, z / 60) - 0.5) * 120, R.treeLine + 30, h);
    R.forest = (x, z) => {
      const h = g.dem(x, z);
      if (!Number.isFinite(h) || h <= 0) return 0;
      const f = R.cover ? R.cover.forest(x, z) : Math.min(1, Math.max(0, (gameWoods(x, z) - WOOD) / 0.04 + 0.5));
      return f * treeOk(x, z, h) * (R.cover ? 1 - Math.min(1, (R.cover.water(x, z) + R.cover.river(x, z)) * 2 + R.cover.town(x, z)) : 1);
    };
    // Spruce and larch from the mountain villages up; broadleaf below. In the
    // south the low woods are dark evergreen oak (broadleaf, darker).
    R.conifer = (x, z) => { const h = g.dem(x, z); return noise(x / 240 + 11, z / 240) * 0.5 + smooth(700, 1350, h) * 0.75 > (R.med ? 0.75 : 0.55); };
    // Where a lone tree or a hedge may stand: open land below the tree line.
    R.open = (x, z) => {
      const h = g.dem(x, z);
      if (!(h > 0) || treeOk(x, z, h) < 0.9) return false;
      const c = R.cover;
      return !c || (c.water(x, z) < 0.1 && c.river(x, z) < 0.2 && c.town(x, z) < 0.2 && c.rock(x, z) < 0.3 && c.glacier(x, z) < 0.1);
    };
    R.hedgy = (x, z) => !R.med && !R.alps && R.open(x, z) && g.dem(x, z) < 700;
    // Lavender takes about a third of the fields on the plateaus.
    R.crops = R.lavender ? LAVENDER : R.med ? DRY : CROPS;
    R.towns = osm ? townsOf(g, osm) : [];
    R.cols = osm ? colsOf(g, osm) : [];
    R.sea = false;
    for (let i = 0; i < g.n && !R.sea; i += 50) for (const o of [-600, 600]) { const x = g.xz[i][0] + g.side[i][0] * o, z = g.xz[i][1] + g.side[i][1] * o; if (g.dem(x, z) <= 0) R.sea = true; }
    return R;
  }
  // Crops in the south: dry pasture, stubble, vines, ploughed red earth, green.
  const DRY = [[0.3, [0.46, 0.47, 0.27], 0], [0.5, [0.7, 0.6, 0.38], 1], [0.68, [0.4, 0.44, 0.24], 1], [0.8, [0.52, 0.36, 0.24], 1], [1, [0.36, 0.45, 0.22], 0]];
  // On the plateaus: lavender in rows (code 2), wheat, dry pasture.
  const LAVENDER = [[0.36, [0.47, 0.4, 0.66], 2], [0.6, [0.72, 0.62, 0.38], 1], [0.82, [0.45, 0.47, 0.27], 0], [1, [0.55, 0.4, 0.27], 1]];

  // The ground's colour on real land, or false where the heights are missing.
  // out[3] says what it is, for the grass blades: 0 grass, 1 bare (rock,
  // snow, water, paving: no blades), 2 lavender.
  const SAT = [0, 0, 0];
  function groundReal(x, z, out, d) {
    const R = REAL, h = R.dem(x, z);
    if (!Number.isFinite(h)) return false;
    const c = R.cover, sl = Math.hypot(R.dem(x + 6, z) - h, R.dem(x, z + 6) - h) / 6; // real rise per metre
    const n1 = noise(x / 45, z / 45), n2 = noise(x / 8, z / 8), alt = h + (n1 - 0.5) * 140; // ragged bands, not contour lines
    let r, gg, b, kind = 0;
    const mix = (t, cr, cg, cb) => { r += (cr - r) * t; gg += (cg - gg) * t; b += (cb - b) * t; };
    if (alt < R.fieldTop && sl < 0.22 && !(c && c.vines(x, z) > 0.5)) { ground0(x, z, out); r = out[0]; gg = out[1]; b = out[2]; kind = out[3]; }
    else { // meadow and pasture
      const t = noise(x / 22, z / 22);
      r = 0.32 + 0.07 * t; gg = 0.44 + 0.06 * t; b = 0.21;
      if (R.med) mix(0.4, 0.5, 0.48, 0.28);
      if (c && c.vines(x, z) > 0.5) { const row = Math.sin((x * 0.6 + z * 0.8) * 2.4) > 0.2; r = row ? 0.3 : 0.5; gg = row ? 0.42 : 0.42; b = row ? 0.2 : 0.3; }
    }
    // Above the tree line: short alpine grass, yellower, then stones.
    const alpine = smooth(R.treeLine - 250, R.treeLine + 200, alt);
    if (alpine > 0) { mix(alpine * 0.85, 0.44 + 0.06 * n2, 0.41 + 0.04 * n2, 0.27); if (alpine > 0.5) kind = kind === 2 ? 0 : kind; }
    // Bare rock and scree: on steep ground, high up, or where the map says so.
    const rock = Math.max(smooth(0.65, 1.05, sl), smooth(R.treeLine + 350, R.treeLine + 800, alt) * (0.55 + 0.45 * n2), c ? c.rock(x, z) : 0);
    if (rock > 0) { const l = 0.85 + 0.3 * n2; mix(rock, 0.46 * l, 0.44 * l, 0.41 * l); if (rock > 0.5) kind = 1; }
    // Woods.
    const f = smooth(0.4, 0.62, R.forest(x, z));
    if (f > 0) {
      const t = noise(x / 4.5, z / 4.5), s = noise(x / 18 + 3, z / 18), dark = R.conifer(x, z);
      mix(f, (dark ? 0.08 : 0.12) + 0.07 * t + 0.03 * s, (dark ? 0.17 : 0.22) + 0.1 * t + 0.04 * s, (dark ? 0.11 : 0.1) + 0.04 * t);
    }
    if (c) {
      const town = c.town(x, z);
      if (town > 0.3) { // paving, roofs' shadows and gardens
        const t = noise(x / 6, z / 6), garden = t > 0.58;
        mix(smooth(0.3, 0.7, town), garden ? 0.3 : 0.5 + 0.06 * n2, garden ? 0.42 : 0.48 + 0.05 * n2, garden ? 0.22 : 0.45);
        if (!garden && town > 0.5) kind = 1;
      }
      const ice = c.glacier(x, z);
      if (ice > 0) { mix(ice, 0.82, 0.88, 0.93); if (ice > 0.5) kind = 1; }
    }
    // The satellite photo, where there is one: the real fields, woods, rock
    // and villages as they look from above. Close to the road it gives way
    // to the paint, which has the detail a 10 m photo lacks (crop rows,
    // field margins), and the lavender keeps its rows.
    // A sharp aerial photo (under a metre a pixel) has that detail itself, so
    // it covers nearly everything, and only the verge keeps some paint.
    if (kind !== 2 && R.hi && R.hi(x, z, SAT)) {
      const w = 0.78 + 0.18 * smooth(6, 40, d), l = 1.04;
      mix(w, SAT[0] * l, SAT[1] * l, SAT[2] * l);
    } else if (R.sat && kind !== 2 && R.sat(x, z, SAT)) {
      const w = 0.5 + 0.4 * smooth(12, 140, d), l = 1.12;
      mix(w, SAT[0] * l, SAT[1] * l, SAT[2] * l);
    }
    // Snow, lying thinner on steep ground.
    const snow = smooth(R.snowLine, R.snowLine + 280, h + (n1 - 0.5) * 220) * (1 - smooth(0.75, 1.2, sl) * 0.7);
    if (snow > 0) { mix(snow, 0.88 + 0.06 * n2, 0.9 + 0.06 * n2, 0.94 + 0.04 * n2); if (snow > 0.5) kind = 1; }
    if (d < 5.5 && kind !== 1) { const t = noise(x / 3, z / 3); mix(0.85, 0.42 + 0.08 * t + alpine * 0.05, 0.5 + 0.06 * t - alpine * 0.03, 0.28); kind = 0; }
    // Water: lakes and rivers, and the sea.
    const wet = Math.max(c ? Math.max(c.water(x, z), c.river(x, z)) : 0, h <= 0.5 ? 1 : 0);
    if (wet > 0.35) { mix(smooth(0.35, 0.6, wet), 0.15, 0.25, 0.29); kind = 1; }
    const grain = n2 * 0.06 + noise(x / 1.3, z / 1.3) * 0.05 - 0.05;
    out[0] = r + grain; out[1] = gg + grain; out[2] = b + grain * 0.7; out[3] = kind;
    return true;
  }

  // Where the route crosses a country border, in order: the point and the
  // country it enters. A route running along a border in and out within
  // 300 m does not count.
  function crossings(g, osm) {
    const hits = [];
    for (const bd of osm.borders) {
      const pts = bd.line.map(p => g.xzOf(p[0], p[1]));
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1], mx = (ax + bx) / 2, mz = (az + bz) / 2, half = Math.hypot(bx - ax, bz - az) / 2;
        for (const j of nearRoad(g, mx, mz, half + 30)) {
          if (j >= g.n - 1) continue;
          const [cx, cz] = g.xz[j], [dx, dz] = g.xz[j + 1];
          const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
          if (!den) continue;
          const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) hits.push({ i: j, between: bd.between });
        }
      }
    }
    hits.sort((p, q) => p.i - q.i);
    let cur = osm.start ?? hits[0]?.between[0];
    const out = [];
    for (const h of hits) {
      if (out.length && h.i - out[out.length - 1].i < 3) continue; // the same crossing found twice
      const next = h.between.find(c => c !== cur);
      if (next == null || !osm.countries[next]) continue;
      const prev = out[out.length - 1];
      if (prev && h.i - prev.i < 30 && next === prev.from) { out.pop(); cur = next; continue; } // in and straight out again
      out.push({ i: h.i, from: cur, to: { id: next, ...osm.countries[next] } });
      cur = next;
    }
    return out;
  }

  // Towns ridden through: where the route comes within reach of a place's
  // centre, with a sign on the way in and on the way out.
  const REACH = { city: 1800, town: 1000, village: 520, hamlet: 230 };
  function townsOf(g, osm) {
    const out = [];
    for (const p of osm.places) {
      const R = REACH[p.kind]; if (!R) continue;
      const [x, z] = g.xzOf(p.lat, p.lon), near = [];
      for (const j of nearRoad(g, x, z, R)) if (Math.hypot(g.xz[j][0] - x, g.xz[j][1] - z) < R) near.push(j);
      near.sort((a, b) => a - b);
      let a = -1, b = -1;
      const flush = () => { if (a >= 0 && b - a >= 2) out.push({ name: p.name, kind: p.kind, a, b }); };
      for (const j of near) { if (a < 0 || j - b > 100) { flush(); a = j; } b = j; } // a dip out of reach for under a kilometre is still the same visit
      flush();
    }
    return out.sort((p, q) => p.a - q.a);
  }
  // Named cols (passes and saddles) on the route: where the climb to each
  // starts (the lowest point before it, back to the last real dip) and its top.
  function colsOf(g, osm) {
    const out = [];
    for (const p of osm.passes) {
      const [x, z] = g.xzOf(p.lat, p.lon);
      let top = -1, best = 220;
      for (const j of nearRoad(g, x, z, 220)) { const d = Math.hypot(g.xz[j][0] - x, g.xz[j][1] - z); if (d < best) { best = d; top = j; } }
      if (top < 0) continue;
      for (let j = Math.max(0, top - 15); j <= Math.min(g.n - 1, top + 15); j++) if (g.y[j] > g.y[top]) top = j; // onto the very top
      if (out.some(c => c.name === p.name && Math.abs(c.top - top) < 100)) continue;
      let low = top;
      for (let j = top; j >= 0 && top - j < 4000; j--) { if (g.y[j] < g.y[low]) low = j; if (g.y[j] > g.y[low] + 40 * LIFT) break; }
      out.push({ name: p.name, ele: Math.round(p.ele || g.ele0 + g.y[top] / LIFT), top, start: (g.y[top] - g.y[low]) / LIFT > 80 ? low : Math.max(0, top - 100) });
    }
    return out.sort((p, q) => p.top - q.top);
  }

  // Houses: each building on the map near the road as a box with a roof,
  // in the style of the region. A gable roof along the building's length;
  // big buildings get a low one. Walls carry windows (a tiling picture).
  const HOUSE = {
    north: { walls: [[0.56, 0.3, 0.22], [0.62, 0.36, 0.27], [0.8, 0.76, 0.68], [0.52, 0.32, 0.24], [0.86, 0.84, 0.8]], roofs: [[0.22, 0.22, 0.24], [0.48, 0.22, 0.16], [0.3, 0.3, 0.33]], pitch: 0.9, eave: 0.35, shutter: null },
    alpine: { walls: [[0.88, 0.86, 0.82], [0.66, 0.62, 0.56], [0.52, 0.38, 0.25], [0.8, 0.76, 0.68]], roofs: [[0.32, 0.32, 0.34], [0.44, 0.42, 0.4], [0.36, 0.26, 0.19]], pitch: 0.45, eave: 1.1, shutter: '#5a3b22' },
    med: { walls: [[0.87, 0.75, 0.56], [0.91, 0.85, 0.72], [0.82, 0.62, 0.44], [0.93, 0.91, 0.86], [0.85, 0.7, 0.6]], roofs: [[0.68, 0.36, 0.23], [0.62, 0.31, 0.2], [0.72, 0.44, 0.29]], pitch: 0.32, eave: 0.45, shutter: '#3f6b4a' },
  };
  const windowTex = {};
  function windows(style) {
    if (windowTex[style]) return windowTex[style];
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128;
    const cx = cv.getContext('2d'), sh = HOUSE[style].shutter;
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, 128, 128);
    // One window in the middle of each 3 m by 2.9 m bay: frame, glass, sill.
    cx.fillStyle = '#e8e8e8'; cx.fillRect(40, 30, 48, 62);
    cx.fillStyle = '#2b3138'; cx.fillRect(44, 34, 40, 54);
    cx.fillStyle = '#4c5866'; cx.fillRect(44, 34, 40, 20);
    cx.fillStyle = '#e8e8e8'; cx.fillRect(62, 34, 4, 54); cx.fillRect(38, 92, 52, 5);
    if (sh) { cx.fillStyle = sh; cx.fillRect(26, 32, 13, 58); cx.fillRect(89, 32, 13, 58); }
    const t = new T.CanvasTexture(cv);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    return (windowTex[style] = t);
  }
  // The houses follow the country they stand in (the route may cross a border).
  function houseStyle(R, h, i, lat) {
    const c = R.code(i);
    if ((h > 950 && R.alps) || c === 'CH' || c === 'AT') return 'alpine';
    return MED.has(c) || (c === 'FR' && lat < 44.6) || (!c && R.med) ? 'med' : 'north';
  }
  // `range` (a free ride): only the buildings whose nearest road point is
  // from range[0] up to range[1], so each piece of road builds its own.
  function houses(g, R, osm, range) {
    if (!osm) return [];
    const cells = new Map();
    for (const bd of osm.buildings) {
      // Each building's own dice, from where it stands, so it comes out the
      // same however often (and in whatever company) it is built.
      const rand = rng(Math.round(bd.ring[0][0] * 1e5) * 92821 + Math.round(bd.ring[0][1] * 1e5));
      if (range) { // quick test on one corner before the whole outline
        const [x, z] = g.xzOf(bd.ring[0][0], bd.ring[0][1]), n = nearestPoint(g, x, z, 280);
        if (n < range[0] - 2 || n >= range[1] + 2) continue;
      }
      const ring = bd.ring.map(p => g.xzOf(p[0], p[1]));
      if (ring.length < 4) continue;
      // The building's long axis and size, from its corners.
      let cx = 0, cz = 0;
      for (const [x, z] of ring) { cx += x; cz += z; }
      cx /= ring.length; cz /= ring.length;
      if (range) { const n = nearestPoint(g, cx, cz, 280); if (n < range[0] || n >= range[1] || g.dup[n]) continue; } // road ridden before has its houses
      let sxx = 0, szz = 0, sxz = 0;
      for (const [x, z] of ring) { sxx += (x - cx) ** 2; szz += (z - cz) ** 2; sxz += (x - cx) * (z - cz); }
      const a = 0.5 * Math.atan2(2 * sxz, sxx - szz), ux = Math.cos(a), uz = Math.sin(a);
      let l0 = Infinity, l1 = -Infinity, w0 = Infinity, w1 = -Infinity;
      for (const [x, z] of ring) { const l = (x - cx) * ux + (z - cz) * uz, w = -(x - cx) * uz + (z - cz) * ux; l0 = Math.min(l0, l); l1 = Math.max(l1, l); w0 = Math.min(w0, w); w1 = Math.max(w1, w); }
      const L = (l1 - l0) / 2, Wd = (w1 - w0) / 2;
      if (L < 1.5 || Wd < 1.2 || L > 120) continue;
      const mx = cx + ux * (l0 + L) - uz * (w0 + Wd), mz = cz + uz * (l0 + L) + ux * (w0 + Wd);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([p, q]) => [mx + ux * L * p - uz * Wd * q, mz + uz * L * p + ux * Wd * q]);
      // Clear of the road all round, not just at the corners: a long house
      // beside a bend could otherwise stand across the road between them.
      const rim = [[mx, mz]];
      for (let c = 0; c < 4; c++) {
        const [ax, az] = corners[c], [bx, bz] = corners[(c + 1) % 4], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 3));
        for (let t = 0; t < n; t++) rim.push([ax + ((bx - ax) * t) / n, az + ((bz - az) * t) / n]);
      }
      if (rim.some(([x, z]) => roadDist(g, x, z) < ROAD_HALF + 2)) continue; // the map and the GPX disagree by a few metres
      const near = nearRoad(g, mx, mz, 260); if (!near.length) continue;
      let low = Infinity, i0 = near[0];
      for (const [x, z] of corners) low = Math.min(low, groundAt(g, x, z, 260).y);
      const h = R.dem(mx, mz), style = houseStyle(R, h, i0, g.ll(mx, mz)[0]), S = HOUSE[style];
      const small = L * Wd < 9 || /garage|shed|hut|carport|kiosk/.test(bd.kind);
      const levels = bd.levels || (/apartments|hotel|commercial|retail|office/.test(bd.kind) ? 3 + Math.floor(rand() * 3) : /church|cathedral|chapel/.test(bd.kind) ? 3 : small ? 1 : style === 'north' ? 1 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 2));
      const wallH = bd.height ? bd.height * 0.8 : levels * 2.9 + 0.4 + (small ? -0.4 : 0);
      const k = Math.floor(mx / 250) * 65536 + Math.floor(mz / 250);
      let cell = cells.get(k);
      if (!cell) cells.set(k, (cell = {}));
      const part = cell[style] || (cell[style] = { wp: [], wc: [], wu: [], rp: [], rc: [] });
      const wall = S.walls[Math.floor(rand() * S.walls.length)], roof = S.roofs[Math.floor(rand() * S.roofs.length)], tone = 0.9 + rand() * 0.15;
      const base = low - 0.6, top = low + wallH, flat = Wd > 9 || L * Wd > 400;
      const ridge = top + Wd * (flat ? 0.12 : S.pitch), e = S.eave;
      // Walls: four sides; the two short ones come up to the ridge (gables).
      const quad = (p, cU, q) => { // four corners, and how many window bays across and up
        const [A, B, C, D] = p;
        for (const v of [A, B, C, A, C, D]) part.wp.push(v[0], v[1], v[2]);
        for (const uv of [[0, 0], [cU, 0], [cU, q], [0, 0], [cU, q], [0, q]]) part.wu.push(small ? 0.02 : uv[0], small ? 0.02 : uv[1]);
        for (let n = 0; n < 6; n++) part.wc.push(wall[0] * tone, wall[1] * tone, wall[2] * tone);
      };
      const C = corners, up = top - base;
      for (let s2 = 0; s2 < 4; s2++) {
        const P = C[s2], Q = C[(s2 + 1) % 4], len = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
        quad([[P[0], base, P[1]], [Q[0], base, Q[1]], [Q[0], top, Q[1]], [P[0], top, P[1]]], len / 3, up / 2.9);
        if (s2 % 2 === 1) { // a gable end: the triangle up to the ridge
          const mx2 = (P[0] + Q[0]) / 2, mz2 = (P[1] + Q[1]) / 2;
          for (const v of [[P[0], top, P[1]], [Q[0], top, Q[1]], [mx2, ridge, mz2]]) part.wp.push(...v);
          part.wu.push(0.02, 0.02, 0.02, 0.02, 0.02, 0.02);
          for (let n = 0; n < 3; n++) part.wc.push(wall[0] * tone, wall[1] * tone, wall[2] * tone);
        }
      }
      // Roof: two slopes from the eaves to the ridge, overhanging all round.
      const ex = [mx + ux * (L + e), mz + uz * (L + e)], ey = [mx - ux * (L + e), mz - uz * (L + e)], sx = -uz * (Wd + e), sz = ux * (Wd + e), drop = (e / Wd) * (ridge - top);
      for (const sg of [-1, 1]) {
        const A = [ey[0] + sx * sg, top - drop, ey[1] + sz * sg], B = [ex[0] + sx * sg, top - drop, ex[1] + sz * sg], Cc = [ex[0], ridge, ex[1]], D = [ey[0], ridge, ey[1]];
        for (const v of [A, B, Cc, A, Cc, D]) part.rp.push(...v);
        const shade = sg > 0 ? 1 : 0.85;
        for (let n = 0; n < 6; n++) part.rc.push(roof[0] * shade, roof[1] * shade, roof[2] * shade);
      }
    }
    // One mesh of walls and one of roofs per 250 m square and style.
    const out = [];
    for (const cell of cells.values()) for (const [style, p] of Object.entries(cell)) {
      for (const [pos, col, uv, mat] of [[p.wp, p.wc, p.wu, houseMat(style)], [p.rp, p.rc, null, roofMat]]) {
        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
        geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
        if (uv) geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
        geo.computeVertexNormals(); geo.computeBoundingSphere();
        const m = new T.Mesh(geo, mat);
        m.castShadow = m.receiveShadow = true;
        out.push(m);
      }
    }
    return out;
  }
  const houseMats = {};
  const houseMat = style => houseMats[style] || (houseMats[style] = bothSides(new T.MeshLambertMaterial({ vertexColors: true, map: windows(style) })));
  const roofMat = bothSides(new T.MeshLambertMaterial({ vertexColors: true }));

  // ---- The other roads (a free ride): every road on the map near this
  // piece of the route, as a strip of tarmac (or dirt) lying on the land, so
  // you see the junctions coming and where each way goes. Each bit of road
  // belongs to the piece of route nearest it; the bits on the route itself
  // are left out. Heights follow the land mesh under them (its 20 m grid out
  // here, the finer strip by the road), so the strip neither floats nor sinks.
  const SIDE = 380; // m from the route the other roads are drawn out to
  function sideRoads(g, s, e, roam, M) {
    const [cx, cz] = g.xz[Math.min(g.n - 1, (s + e) >> 1)], [lat, lon] = g.ll(cx, cz);
    const ways = roam.roadsNear(lat, lon, CHUNK * STEP * 0.6 + SIDE + 100);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = s; i <= e; i++) { x0 = Math.min(x0, g.xz[i][0]); x1 = Math.max(x1, g.xz[i][0]); z0 = Math.min(z0, g.xz[i][1]); z1 = Math.max(z1, g.xz[i][1]); }
    const pos = [[], []], idx = [[], []], uv = [[], []];
    const meshY = (x, z) => {
      const near = landAt(g, x, z, nearRoad(g, x, z, 120));
      if (near && near.d < NEAR) return near.y;
      // Out on the tiles: the same corners the tile mesh has, mixed as it mixes them.
      const st = TILE / CELLS, x0 = Math.floor(x / st) * st, z0 = Math.floor(z / st) * st, u = (x - x0) / st, v = (z - z0) / st;
      const y = (px, pz) => { const p = groundAt(g, px, pz, 300); return p.y - 3 * (1 - smooth(NEAR - 10, NEAR + 8, p.d)); };
      return u + v < 1 ? y(x0, z0) + (y(x0 + st, z0) - y(x0, z0)) * u + (y(x0, z0 + st) - y(x0, z0)) * v
        : y(x0 + st, z0 + st) + (y(x0, z0 + st) - y(x0 + st, z0 + st)) * (1 - u) + (y(x0 + st, z0) - y(x0 + st, z0 + st)) * (1 - v);
    };
    for (const way of ways) {
      const half = way.kind.half, k = way.kind.dirt ? 1 : 0;
      // Points every 5 m along the way, kept where this piece is the nearest route and off the route itself.
      const pts = way.line.map(p => g.xzOf(p[0], p[1])), run = [];
      const flush = () => {
        if (run.length >= 2) {
          const base = pos[k].length / 3;
          run.forEach((p, q) => {
            const a = run[Math.max(0, q - 1)], b = run[Math.min(run.length - 1, q + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
            const sx = -dz / l * half, sz = dx / l * half;
            pos[k].push(p[0] + sx, p[2] + 0.06, p[1] + sz, p[0] - sx, p[2] + 0.06, p[1] - sz);
            uv[k].push(0, p[3] / 4, half / 2, p[3] / 4);
            if (q) { const i = base + (q - 1) * 2; idx[k].push(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
          });
        }
        run.length = 0;
      };
      let walked = 0;
      for (let q = 0; q + 1 < pts.length; q++) {
        const [ax, az] = pts[q], [bx, bz] = pts[q + 1], len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / 6));
        for (let m = q ? 1 : 0; m <= n; m++) {
          const x = ax + ((bx - ax) * m) / n, z = az + ((bz - az) * m) / n, along = walked + (len * m) / n;
          if (x < x0 - SIDE || x > x1 + SIDE || z < z0 - SIDE || z > z1 + SIDE) { flush(); continue; }
          let j = nearestPoint(g, x, z, 120); if (j < 0) j = nearestPoint(g, x, z, SIDE);
          const mine = j >= s && (j < e || j === g.n - 1) && !g.dup[j]; // the last piece also has what lies past the end; road ridden before has its side roads
          if (!mine || roadDist(g, x, z) < ROAD_HALF + 0.3) { flush(); continue; }
          run.push([x, z, meshY(x, z), along]);
        }
        walked += len;
      }
      flush();
    }
    const group = new T.Group();
    [M.lane, M.dirt].forEach((mat, k) => {
      if (!idx[k].length) return;
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(pos[k], 3));
      geo.setAttribute('uv', new T.Float32BufferAttribute(uv[k], 2));
      geo.setIndex(idx[k]); geo.computeVertexNormals();
      const m = new T.Mesh(geo, mat); m.receiveShadow = true;
      group.add(m);
    });
    return group.children.length ? group : null;
  }

  // Lakes and rivers: flat water on the lakes, a ribbon along each river and
  // stream, both lying a little below the banks.
  const waterMat = new T.MeshPhongMaterial({ color: 0x2a4655, specular: 0x9fb4c4, shininess: 70, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  function waters(g, osm) {
    if (!osm) return [];
    const out = [];
    for (const sh of osm.water) for (const outer of sh.outer) {
      let ring = outer.map(p => g.xzOf(p[0], p[1]));
      if (ring.length > 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring = ring.slice(0, -1);
      if (ring.length < 3) continue;
      // The water's level: the lowest of the banks round its shore.
      let level = Infinity;
      for (let k = 0; k < ring.length; k += Math.max(1, Math.floor(ring.length / 60))) level = Math.min(level, dryAt(g, ring[k][0], ring[k][1], 1500));
      if (!Number.isFinite(level)) continue;
      const holes = sh.inner.map(r => r.map(p => g.xzOf(p[0], p[1]))).filter(h => h.length > 3).map(h => h.map(([x, z]) => new T.Vector2(x, z)));
      const contour = ring.map(([x, z]) => new T.Vector2(x, z)), tris = T.ShapeUtils.triangulateShape(contour, holes);
      const all = contour.concat(...holes), pos = [];
      for (const v of all) pos.push(v.x, level + 0.15, v.y);
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      geo.setIndex(tris.flatMap(t => [t[0], t[2], t[1]]));
      geo.computeVertexNormals();
      if (geo.attributes.normal.getY(0) < 0) { geo.setIndex(tris.flat()); geo.computeVertexNormals(); }
      geo.computeBoundingSphere();
      const m = new T.Mesh(geo, waterMat); m.receiveShadow = true; out.push(m);
    }
    for (const r of osm.rivers) {
      const w = riverWidth(r) / 2, pts = [];
      // Every 8 m along it, near the route only.
      const ll = r.line.map(p => g.xzOf(p[0], p[1]));
      for (let k = 0; k + 1 < ll.length; k++) {
        const [ax, az] = ll[k], [bx, bz] = ll[k + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
        for (let q = 0; q < n; q++) pts.push([ax + ((bx - ax) * q) / n, az + ((bz - az) * q) / n]);
      }
      pts.push(ll[ll.length - 1]);
      let run = [];
      const flush = () => {
        if (run.length > 2) {
          const pos = [], idx = [];
          run.forEach(([x, z, y], k) => {
            const a = run[Math.max(0, k - 1)], b = run[Math.min(run.length - 1, k + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
            pos.push(x - (dz / l) * w, y, z + (dx / l) * w, x + (dz / l) * w, y, z - (dx / l) * w);
            if (k) { const v = (k - 1) * 2; idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); }
          });
          const geo = new T.BufferGeometry();
          geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
          geo.computeVertexNormals();
          if (geo.attributes.normal.getY(0) < 0) { for (let q = 0; q < idx.length; q += 3) [idx[q + 1], idx[q + 2]] = [idx[q + 2], idx[q + 1]]; geo.setIndex(idx); geo.computeVertexNormals(); }
          geo.computeBoundingSphere();
          out.push(new T.Mesh(geo, waterMat));
        }
        run = [];
      };
      for (const [x, z] of pts) {
        let d = Infinity; // to the nearest road point (roadDist only looks 30 m round)
        for (const j of nearRoad(g, x, z, 760)) d = Math.min(d, Math.hypot(g.xz[j][0] - x, g.xz[j][1] - z));
        if (d < 40) d = roadDist(g, x, z);
        if (!(d < 760)) { flush(); continue; }
        // Just over the land (drawn over it, see waterMat); under the road it
        // ducks out of sight (the road crosses on a bridge).
        const y = dryAt(g, x, z, 800) + (d < ROAD_HALF + 3 ? -3 : 0.1);
        run.push([x, z, y]);
      }
      flush();
    }
    return out;
  }

  // Signs: the town's name on the way in and crossed out on the way out, in
  // the country's own colours; the col's name and height at its top; the
  // blue EU sign with the stars where the route crosses into a country.
  const SIGN_COLOURS = { FR: ['#fff', '#c8102e', '#111'], BE: ['#fff', '#c8102e', '#111'], IT: ['#fff', '#111', '#111'], DE: ['#ffcc00', '#111', '#111'], NL: ['#1450a0', '#fff', '#fff'], CH: ['#1f57a5', '#fff', '#fff'], AT: ['#1f57a5', '#fff', '#fff'], LU: ['#fff', '#c8102e', '#111'], ES: ['#fff', '#c8102e', '#111'] };
  function board(draw, w, h) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = Math.round((512 * h) / w);
    draw(cv.getContext('2d'), cv.width, cv.height);
    const tex = new T.CanvasTexture(cv);
    tex.anisotropy = 4;
    return new T.MeshBasicMaterial({ map: tex });
  }
  const fitText = (cx, text, maxW, size, weight = 800) => {
    let s = size;
    do { cx.font = `${weight} ${s}px "Segoe UI", Arial, sans-serif`; s -= 2; } while (cx.measureText(text).width > maxW && s > 10);
  };
  function placeSign(g, i, mat, w, h, postH, side = 1) {
    const grp = new T.Group(), off = ROAD_HALF + 1.6, p = groundY(g, i, side * off);
    const face = new T.Mesh(new T.PlaneGeometry(w, h), mat);
    const back = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshLambertMaterial({ color: 0x9aa0a8 }));
    back.rotation.y = Math.PI; back.position.z = -0.02;
    const pole = new T.MeshLambertMaterial({ color: 0x8d949e });
    for (const sx of w > 1.8 ? [-w / 3, w / 3] : [0]) {
      const post = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, postH + h / 2, 6), pole);
      post.position.set(sx, (postH + h / 2) / 2 - postH - h / 2, -0.05); post.castShadow = true; grp.add(post);
    }
    grp.add(face, back);
    grp.position.set(p.x, p.y + postH + h / 2, p.z);
    // Facing the oncoming rider (on the right), or the other way on the left.
    grp.rotation.y = Math.atan2(-g.side[i][1], g.side[i][0]) + (side > 0 ? 0 : Math.PI);
    face.castShadow = true;
    return grp;
  }
  function realSigns(g, R) {
    const group = new T.Group();
    for (const t of R.towns) {
      if (t.kind === 'suburb') continue;
      const [bg, edge, ink] = SIGN_COLOURS[R.code(t.a)] || SIGN_COLOURS.FR;
      const sign = out => board((cx, W, H) => {
        cx.fillStyle = edge; cx.fillRect(0, 0, W, H);
        cx.fillStyle = bg; cx.fillRect(W * 0.04, H * 0.07, W * 0.92, H * 0.86);
        cx.fillStyle = ink; cx.textAlign = 'center'; cx.textBaseline = 'middle';
        fitText(cx, t.name.toUpperCase(), W * 0.84, H * 0.36);
        cx.fillText(t.name.toUpperCase(), W / 2, H / 2 + 2);
        if (out) { cx.strokeStyle = '#c8102e'; cx.lineWidth = H * 0.1; cx.beginPath(); cx.moveTo(W * 0.08, H * 0.85); cx.lineTo(W * 0.92, H * 0.15); cx.stroke(); }
      }, 1.9, 0.75);
      group.add(placeSign(g, Math.min(g.n - 1, t.a), sign(false), 1.9, 0.75, 1.3));
      if (t.b - t.a > 8) group.add(placeSign(g, Math.min(g.n - 1, t.b), sign(true), 1.9, 0.75, 1.3));
    }
    for (const c of R.cols) {
      const it = R.code(c.top) === 'IT';
      const mat = board((cx, W, H) => {
        cx.fillStyle = it ? '#7a4a24' : '#fff'; cx.fillRect(0, 0, W, H);
        cx.strokeStyle = it ? '#fff' : '#111'; cx.lineWidth = 8; cx.strokeRect(10, 10, W - 20, H - 20);
        cx.fillStyle = it ? '#fff' : '#111'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
        fitText(cx, c.name.toUpperCase(), W * 0.86, H * 0.3);
        cx.fillText(c.name.toUpperCase(), W / 2, H * 0.38);
        fitText(cx, `${it ? 'm' : 'Altitude'} ${c.ele}${it ? '' : ' m'}`, W * 0.7, H * 0.22, 700);
        cx.fillText(`${it ? 'm' : 'Altitude'} ${c.ele}${it ? '' : ' m'}`, W / 2, H * 0.72);
      }, 2.6, 1.3);
      group.add(placeSign(g, c.top, mat, 2.6, 1.3, 1.4));
      group.add(placeSign(g, Math.min(g.n - 1, c.top + 2), mat, 2.6, 1.3, 1.4, -1));
    }
    for (const b of R.borders) {
      const mat = board((cx, W, H) => {
        cx.fillStyle = '#103f91'; cx.fillRect(0, 0, W, H);
        cx.fillStyle = '#ffcc00';
        const r = H * 0.3, ox = W / 2, oy = H * 0.4;
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2, x = ox + Math.cos(a) * r, y = oy + Math.sin(a) * r;
          cx.beginPath();
          for (let q = 0; q < 10; q++) { const rr = q % 2 ? H * 0.018 : H * 0.042, aa = -Math.PI / 2 + (q * Math.PI) / 5; cx.lineTo(x + Math.cos(aa) * rr, y + Math.sin(aa) * rr); }
          cx.fill();
        }
        cx.fillStyle = '#fff'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
        fitText(cx, b.to.name.toUpperCase(), W * 0.5, H * 0.13);
        cx.fillText(b.to.name.toUpperCase(), ox, oy);
        fitText(cx, b.to.code, W * 0.3, H * 0.16);
        cx.fillText(b.to.code, ox, H * 0.85);
      }, 1.6, 1.6);
      group.add(placeSign(g, b.i, mat, 1.6, 1.6, 1.4));
    }
    return group;
  }

  // The line shown over the view for where the rider is: a border just
  // crossed, a col's top, a town, the climb to a col.
  function bannerAt(R, i) {
    for (const b of R.borders) if (i >= b.i && i < b.i + 40) return [`Welcome to ${b.to.en || b.to.name}`, b.to.name !== b.to.en ? b.to.name : ''];
    for (const c of R.cols) if (i >= c.top && i < c.top + 30) return [c.name, `${c.ele} m · top`];
    for (const t of R.towns) if (i >= t.a && i < Math.min(t.b, t.a + 40)) return [t.name, ''];
    for (const c of R.cols) if (i >= c.start && i < c.top) return [c.name, `${c.ele} m · ${((c.top - i) * STEP / 1000).toFixed(1)} km to the top`];
    return null;
  }

  // The distant land: the real heights out to 40 km, as rings round the
  // camera (finer close in), coloured by height and slope and lit by the
  // sun once, when built. Drawn first, past the near world (see frame).
  function farLand(g, R, near, far, cx, cz, sunDir, sat) {
    const A = 540, rings = []; // finer than it was, so far ridges keep their shape
    for (let r = 250; r < 42000; r *= 1.045) rings.push(r);
    const n = rings.length, pos = new Float32Array(A * n * 3), hs = new Float32Array(A * n);
    for (let k = 0; k < n; k++) for (let a = 0; a < A; a++) {
      const t = (a / A) * Math.PI * 2, x = cx + Math.cos(t) * rings[k], z = cz + Math.sin(t) * rings[k];
      const [lat, lon] = g.ll(x, z);
      let h = near(lat, lon);
      if (!Number.isFinite(h)) h = far(lat, lon);
      if (!Number.isFinite(h)) h = 0;
      h = Math.max(h, 0);
      const v = k * A + a;
      hs[v] = h; pos[v * 3] = x; pos[v * 3 + 1] = (h - g.ele0) * LIFT; pos[v * 3 + 2] = z;
    }
    const idx = [];
    for (let k = 1; k < n; k++) for (let a = 0; a < A; a++) {
      const p = (k - 1) * A + a, q = (k - 1) * A + ((a + 1) % A), r = k * A + a, s = k * A + ((a + 1) % A);
      idx.push(p, q, r, q, s, r);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal, col = new Float32Array(A * n * 3);
    for (let v = 0; v < A * n; v++) {
      const h = hs[v], ny = nrm.getY(v), sl = Math.sqrt(Math.max(0, 1 - ny * ny)) / Math.max(0.2, ny) / LIFT, x = pos[v * 3], z = pos[v * 3 + 2];
      const nz = noise(x / 900, z / 900);
      let c, photo = false;
      if (h <= 0.5 || (R.cover && R.cover.water(x, z) > 0.4)) c = [0.2, 0.3, 0.36]; // the sea, and lakes on the map
      else if (sat && sat(...g.ll(x, z), SAT)) { // the satellite photo, with this month's snow over it
        photo = true;
        const alt = h + (nz - 0.5) * 200, patch = noise(x / 350 + 5, z / 350);
        const snow = smooth(R.snowLine, R.snowLine + 350, alt + (patch - 0.5) * 400) * (1 - smooth(0.8, 1.3, sl) * 0.6);
        c = SAT.map(q => q * 1.12 + (0.92 - q * 1.12) * snow);
      }
      else {
        const alt = h + (nz - 0.5) * 200;
        c = alt < R.treeLine - 200 ? [0.17 + 0.06 * nz, 0.26 + 0.05 * nz, 0.15] : [0.36, 0.35, 0.25];
        const rock = Math.max(smooth(0.6, 1.0, sl), smooth(R.treeLine + 400, R.treeLine + 900, alt));
        c = c.map((q, m) => q + ([0.42, 0.4, 0.38][m] - q) * rock);
        const patch = noise(x / 350 + 5, z / 350); // snow lies in gullies and on the shaded side first
        const snow = smooth(R.snowLine, R.snowLine + 350, alt + (patch - 0.5) * 400) * (1 - smooth(0.8, 1.3, sl) * 0.6);
        c = c.map(q => q + (0.92 - q) * snow);
      }
      // A photo already has the real sun's shading in it, so it gets less.
      const sunlit = Math.max(0, nrm.getX(v) * sunDir.x + nrm.getY(v) * sunDir.y + nrm.getZ(v) * sunDir.z), lit = photo ? 0.8 + 0.25 * sunlit : 0.55 + 0.45 * sunlit;
      col[v * 3] = c[0] * lit; col[v * 3 + 1] = c[1] * lit; col[v * 3 + 2] = c[2] * lit * 1.02;
    }
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    return geo;
  }

  // The land's colour at a vertex, until its painted texture is in.
  const rgb = [0, 0, 0];
  function landColour(c, x, z, y, road, d) { ground(x, z, rgb, d); return c.setRGB(rgb[0], rgb[1], rgb[2]); }

  // The land at a side offset from a road point.
  function groundY(g, i, o) {
    const x = g.xz[i][0] + g.side[i][0] * o, z = g.xz[i][1] + g.side[i][1] * o;
    return { x, z, y: groundAt(g, x, z, Math.abs(o) + 60).y };
  }

  // A strip along the route between two side offsets, one quad per route point.
  // Points s..e (inclusive), so neighbouring pieces share their seam point.
  function ribbon(g, s, e, from, to, lift, keep) {
    const pos = [], uv = [], idx = [];
    for (let i = s; i <= e; i++) {
      for (const o of [from, to]) {
        pos.push(g.xz[i][0] + g.side[i][0] * o, g.y[i] + lift, g.xz[i][1] + g.side[i][1] * o);
        uv.push((o - from) / 4, (i * STEP) / 4); // a texture tile every 4 m
      }
      if (i > s && (!keep || keep(i))) { const a = (i - s - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } // counter-clockwise from above
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // A road that has been ridden and driven on: darker, smoother tracks where
  // the wheels run in each lane, dusty edges with cracks along them, black
  // sealed cracks wandering across, and now and then a rectangle of newer,
  // darker tar where it was patched. All worked out in the shader from where
  // the pixel is on the road (the ribbon's uv is metres / 4), so it costs no
  // texture and never repeats.
  function worn(mat) {
    mat.onBeforeCompile = sh => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  {
    float across = vUv.x * 4.0, along = vUv.y * 4.0, W = ${(2 * ROAD_HALF).toFixed(1)};
    float lane = mod(across, W * 0.5);
    float track = smoothstep(0.35, 0.0, abs(lane - 0.85)) + smoothstep(0.35, 0.0, abs(lane - 2.15));
    float edge = min(across, W - across);
    float n1 = wnoise(vec2(along * 0.35, across * 0.8)), n2 = wnoise(vec2(along * 1.7, across * 2.3));
    float tone = 1.0 - 0.07 * track + 0.05 * (n1 - 0.5);
    tone += 0.12 * smoothstep(0.45, 0.0, edge) * (0.5 + n2);
    float crack = smoothstep(0.025, 0.0, abs(wnoise(vec2(along * 0.6, edge * 3.0)) - 0.5)) * smoothstep(0.6, 0.15, edge) * step(0.5, wnoise(vec2(along * 0.08, 9.0)));
    float snake = smoothstep(0.012, 0.0, abs(wnoise(vec2(along * 0.18 + 17.0, across * 0.3)) - 0.5)) * smoothstep(0.78, 0.84, wnoise(vec2(along * 0.03, 3.0)));
    float cell = floor(along / 23.0), h = whash(vec2(cell, 7.0));
    float pa = cell * 23.0 + 23.0 * whash(vec2(cell, 1.0)), pl = 2.0 + 6.0 * whash(vec2(cell, 2.0));
    float pc = W * whash(vec2(cell, 3.0)), pw = 0.8 + 1.6 * whash(vec2(cell, 4.0));
    float fix = step(0.72, h) * step(pa, along) * step(along, pa + pl) * step(abs(across - pc), pw);
    tone *= 1.0 - 0.3 * max(crack, snake);
    tone = mix(tone, 0.78 + 0.06 * n2, fix);
    diffuseColor.rgb *= tone;
  }`).replace('void main() {', `float whash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(whash(i), whash(i + vec2(1.0, 0.0)), f.x), mix(whash(i + vec2(0.0, 1.0)), whash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {`);
    };
    mat.customProgramCacheKey = () => 'worn';
    return mat;
  }

  // The land close to the road, as a strip that follows it at the road's own
  // spacing so the verge meets the tarmac exactly. Rows every second point; s
  // and e are even (or the last point), so pieces meet on the same row. On
  // the inside of a tight bend the strip stops short of where it would cross
  // itself; the land map below fills in.
  const NEAR = 80;
  function nearLand(g, s, e, mat) {
    const OFF = [-80, -55, -35, -20, -11, -6, -3.2, 3.2, 6, 11, 20, 35, 55, 80];
    const rowsAt = [];
    for (let i = s; i < e; i += Math.abs(g.bend[i]) > 0.015 ? 1 : 2) rowsAt.push(i); // every point round a hairpin, or the strip cuts the corner over the road
    rowsAt.push(e);
    const pos = [], col = [], uv = [], idx = [], c = new T.Color();
    for (let r = 0; r < rowsAt.length; r++) {
      const i = rowsAt[r], cand = nearRoad(g, g.xz[i][0], g.xz[i][1], NEAR + 60);
      // Inside of the bend: no further than 80% of its radius.
      let inner = Infinity;
      for (let j = Math.max(0, i - 8); j <= Math.min(g.n - 1, i + 8); j++) inner = Math.min(inner, 0.8 / (Math.abs(g.bend[j]) || 1e-9));
      const insideSign = Math.sign(g.bend[i]) || 1;
      // Another part of the route close by (the next hairpin up or down): the
      // strip stops halfway there and that road's own strip takes over. Laid
      // across it, the strip buried that road under a ramp of grass.
      const stop = { [-1]: Infinity, [1]: Infinity }, there = o => [g.xz[i][0] + g.side[i][0] * o, g.xz[i][1] + g.side[i][1] * o];
      for (const sg of [-1, 1]) {
        let ok = 3.2;
        for (const a of OFF) {
          if (Math.sign(a) !== sg || Math.abs(a) < 6) continue;
          const [x, z] = there(a);
          if (landAt(g, x, z, cand).d > Math.abs(a) - 2) { ok = Math.abs(a); continue; }
          let lo = ok, hi = Math.abs(a); // where the two roads are about as near
          for (let k = 0; k < 5; k++) { const m = (lo + hi) / 2, [mx, mz] = there(sg * m); if (landAt(g, mx, mz, cand).d > m - 2) lo = m; else hi = m; }
          stop[sg] = lo + 1.5; break; // a little overlap rather than a crack between them
        }
      }
      for (let o of OFF) {
        if (Math.sign(o) === insideSign && Math.abs(o) > inner) o = Math.sign(o) * Math.max(3.4, inner);
        if (Math.abs(o) > stop[Math.sign(o)]) o = Math.sign(o) * stop[Math.sign(o)];
        const x = g.xz[i][0] + g.side[i][0] * o, z = g.xz[i][1] + g.side[i][1] * o;
        const p = landAt(g, x, z, cand);
        pos.push(x, p.y, z);
        uv.push((o + NEAR) / (2 * NEAR), 1 - (i - s) / ((e - s) || 1)); // into its painted texture (see paintLand)
        landColour(c, x, z, p.y, p.road, Math.abs(o));
        col.push(c.r, c.g, c.b);
      }
      if (r && !(g.dup[rowsAt[r - 1]] && g.dup[i])) { // land beside road ridden before is already there
        const w = OFF.length, a = (r - 1) * w, b = r * w;
        for (let j = 0; j < w - 1; j++) idx.push(a + j, a + j + 1, b + j, a + j + 1, b + j + 1, b + j);
      }
    }
    const mesh = landMesh(pos, col, uv, idx, mat);
    mesh.userData.paint = { strip: [s, e] };
    return mesh;
  }

  function landMesh(pos, col, uv, idx, mat) {
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new T.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  // The rest of the land: a square grid in 200 m tiles (20 m cells) over
  // everything within 700 m of the route. Close to the road it dips a few
  // metres so it stays hidden under the strip above.
  // From point `from` on (a free ride's new road), each tile also says how
  // near that road comes to its middle.
  const TILE = 200, CELLS = 10;
  function landTiles(g, from = 0) {
    const keys = new Map(), reach = 700 + TILE * 0.71;
    for (let i = from; i < g.n; i += 3) {
      const [x, z] = g.xz[i], tx = Math.floor(x / TILE), tz = Math.floor(z / TILE), k = Math.ceil(reach / TILE);
      for (let a = tx - k; a <= tx + k; a++) for (let b = tz - k; b <= tz + k; b++) {
        const d = Math.hypot((a + 0.5) * TILE - x, (b + 0.5) * TILE - z), key = a * 65536 + b;
        if (d < reach && !(keys.get(key)?.[2] <= d)) keys.set(key, [a, b, d]);
      }
    }
    const c = new T.Color(), step = TILE / CELLS;
    return [...keys.values()].map(([a, b, near]) => ({ x: (a + 0.5) * TILE, z: (b + 0.5) * TILE, key: a * 65536 + b, near, build: mat => {
      const x0 = a * TILE, z0 = b * TILE, cx = x0 + TILE / 2, cz = z0 + TILE / 2;
      // Road points that can be nearest to any spot in this tile.
      const dist = j => { const ex = g.xz[j][0] - cx, ez = g.xz[j][1] - cz; return Math.sqrt(ex * ex + ez * ez); };
      let cand = nearRoad(g, cx, cz, 900), dc = Infinity;
      for (const j of cand) if (j % 4 === 0) dc = Math.min(dc, dist(j));
      // Every 4th point is close enough out here (the grid near the road is
      // hidden under the strip), and keeps a long route quick to build.
      cand = cand.filter(j => j % 4 === 0 && dist(j) < dc + TILE * 1.5 + 120);
      const pos = [], col = [], uv = [], idx = [];
      for (let r = 0; r <= CELLS; r++) for (let q = 0; q <= CELLS; q++) {
        const x = x0 + q * step, z = z0 + r * step, p = landAt(g, x, z, cand);
        const y = p.y - 6 * (1 - smooth(NEAR - 10, NEAR + 8, p.d)); // 20 m cells on a steep hillside can bulge a few metres
        pos.push(x, y, z); uv.push((x - x0) / TILE, 1 - (z - z0) / TILE);
        landColour(c, x, z, p.y, p.road, p.d); col.push(c.r, c.g, c.b);
        if (r && q) { const i0 = (r - 1) * (CELLS + 1) + q - 1, i1 = i0 + CELLS + 1; idx.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1); }
      }
      const mesh = landMesh(pos, col, uv, idx, mat);
      mesh.userData.paint = { tile: [x0, z0] };
      return mesh;
    } }));
  }

  // ---- What covers the land: woods, and farmland cut into fields. One
  // function of position, like the height, so the paint on the ground, the
  // trees and the hedges all agree.
  const FA = 0.42, FCOS = Math.cos(FA), FSIN = Math.sin(FA), FCOL = 120; // fields run at a slant to the map
  // How wooded a spot is: above WOOD it is forest.
  // A course can shift the pattern so its woods fall where it wants them.
  let woodsAt = [0, 0];
  const gameWoods = (x, z) => { x += woodsAt[0]; z += woodsAt[1]; return noise(x / 380 + 7.3, z / 380) * 0.72 + noise(x / 110, z / 110 + 3.1) * 0.28; };
  // On real land, the woods on the map (see realOf), on the same scale.
  const woods = (x, z) => (REAL ? WOOD - 0.03 + 0.06 * REAL.forest(x, z) : gameWoods(x, z));
  const WOOD = 0.56;
  // The field a spot is in: columns FCOL wide, cut into rows whose length
  // varies per column. Returns which field, how far to its nearest edge, and
  // whether that edge has a hedge.
  function field(x, z) {
    const u = x * FCOS + z * FSIN, v = -x * FSIN + z * FCOS;
    const c = Math.floor(u / FCOL), rowH = 55 + hash(c, 1.7) * 90, sh = hash(c, 2.9) * 300;
    const r = Math.floor((v + sh) / rowH);
    const fu = u - c * FCOL, fv = v + sh - r * rowH;
    const eu = Math.min(fu, FCOL - fu), ev = Math.min(fv, rowH - fv);
    // A hedge on about half the edges: the long edge left of the field, the short one below it.
    const hedgeU = hash(fu < FCOL / 2 ? c : c + 1, 5.3) < 0.55, hedgeV = hash(c, r + (fv < rowH / 2 ? 0 : 1) + 0.37) < 0.5;
    return { c, r, crop: hash(c * 3.1, r * 1.3 + 9.1), alongU: hash(c, r + 4.4) < 0.5, u, v, edge: Math.min(eu, ev), hedge: eu < ev ? hedgeU : hedgeV };
  }
  // Crops, by share: pasture, meadow, ripe wheat, young crop in rows, ploughed, maize.
  const CROPS = [[0.36, [0.3, 0.43, 0.2], 0], [0.54, [0.4, 0.48, 0.25], 0], [0.68, [0.64, 0.56, 0.33], 1], [0.86, [0.35, 0.49, 0.2], 1], [0.92, [0.4, 0.34, 0.26], 1], [1, [0.25, 0.37, 0.16], 1]];
  // The colour of the ground at a spot (r, g, b in 0..1, into `out`). `d` is the
  // distance to the road when known, for the verge.
  function ground(x, z, out, d = 99) {
    out[3] = 0;
    if (REAL && groundReal(x, z, out, d)) return out;
    const grain = noise(x / 6, z / 6) * 0.08 + noise(x / 1.3, z / 1.3) * 0.06 - 0.07;
    let r, gg, b;
    const w = woods(x, z);
    if (w > WOOD) {
      // The wood seen from above: dark crowns and gaps.
      const t = noise(x / 4.5, z / 4.5), s = noise(x / 18 + 3, z / 18);
      r = 0.12 + 0.07 * t + 0.03 * s; gg = 0.22 + 0.1 * t + 0.04 * s; b = 0.1 + 0.04 * t;
      const edge = smooth(WOOD, WOOD + 0.02, w); // a soft rim where wood meets field
      if (edge < 1) { const f = []; ground0(x, z, f); r = f[0] + (r - f[0]) * edge; gg = f[1] + (gg - f[1]) * edge; b = f[2] + (b - f[2]) * edge; }
    } else {
      const f = []; ground0(x, z, f); [r, gg, b] = f;
    }
    if (d < 5.5) { const t = noise(x / 3, z / 3); r = 0.42 + 0.08 * t; gg = 0.5 + 0.06 * t; b = 0.28; } // rough verge grass
    out[0] = r + grain; out[1] = gg + grain; out[2] = b + grain * 0.7;
    return out;
  }
  function ground0(x, z, out) {
    const f = field(x, z), crops = REAL?.crops || CROPS;
    let k = 0; while (f.crop > crops[k][0]) k++;
    const [, [r, g, b], rows] = crops[k], tone = hash(f.c + 0.5, f.r) * 0.08 - 0.04;
    let l = 1 + tone;
    out[3] = 0;
    if (rows === 2) { // lavender: round bushes in rows 1.6 m apart, bare earth between
      const along = f.alongU ? f.v : f.u, across = f.alongU ? f.u : f.v, w = Math.sin((along * Math.PI * 2) / 1.6) * 0.5 + 0.5, bush = w * (0.75 + 0.25 * Math.sin(across * 3.9));
      const t = smooth(0.35, 0.6, bush);
      out[0] = 0.5 + (r - 0.5) * t; out[1] = 0.4 + (g - 0.4) * t; out[2] = 0.3 + (b - 0.3) * t; out[3] = t > 0.5 ? 2 : 1;
      if (f.edge < 1.6) { out[0] = 0.45; out[1] = 0.47; out[2] = 0.28; out[3] = 0; }
      return;
    }
    if (rows) l *= 0.9 + 0.1 * Math.sin(((f.alongU ? f.v : f.u) * Math.PI * 2) / 3.2); // crop rows or furrows
    else l *= 0.94 + 0.12 * noise(x / 9, z / 9); // grass in patches
    out[0] = r * l; out[1] = g * l; out[2] = b * l;
    if (f.edge < 1.6) { // a grass margin, darker under a hedge
      const m = f.hedge ? [0.16, 0.27, 0.12] : [0.38, 0.5, 0.25];
      out[0] = m[0]; out[1] = m[1]; out[2] = m[2];
    }
  }

  // ---- Trees, built in code: a spruce (stacked cones) and a broadleaf (a few
  // lumpy balls on a trunk). Each kind is one geometry carrying its own
  // colours, drawn as instances with their own size, turn and tint.
  function part(geo, colour, crown) {
    const g = geo.index ? geo.toNonIndexed() : geo, p = g.attributes.position, n = p.count, col = [];
    const c = new T.Color(colour), hsl = {};
    c.getHSL(hsl);
    for (let i = 0; i < n; i++) {
      const y = p.getY(i), l = crown ? hsl.l * (0.75 + 0.5 * Math.min(1, Math.max(0, (y - crown[1]) / crown[2] + 0.5))) : hsl.l;
      const k = new T.Color().setHSL(hsl.h, hsl.s, l);
      col.push(k.r, k.g, k.b);
    }
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    return g;
  }
  // Push vertices out by a little noise so a ball reads as foliage, and point
  // the normals away from the crown's middle so it shades soft, like a tree.
  function foliage(geo, cx, cy, cz, amount, seed) {
    const p = geo.attributes.position, nrm = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), dx = x - cx, dy = y - cy, dz = z - cz, l = Math.hypot(dx, dy, dz) || 1;
      const k = 1 + amount * (noise(x * 1.7 + seed, z * 1.7 + y) - 0.5);
      p.setXYZ(i, cx + dx * k, cy + dy * k, cz + dz * k);
      nrm.push(dx / l, dy / l, dz / l);
    }
    geo.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
    return geo;
  }
  function merge(parts) {
    const pos = [], nrm = [], col = [], uv = [], withUV = parts.every(g => g.attributes.uv);
    for (const g of parts) {
      if (!g.attributes.normal) g.computeVertexNormals();
      pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); col.push(...g.attributes.color.array);
      if (withUV) uv.push(...g.attributes.uv.array);
      g.dispose();
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    if (withUV) geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    return geo;
  }
  // Two-sided, but lit by the normals as given on both faces: leaf cards and
  // grass blades carry normals pointing out of the crown (or up), and the
  // back of a card must not turn dark because it faces away.
  function bothSides(mat) {
    const prev = mat.onBeforeCompile;
    mat.side = T.DoubleSide;
    mat.onBeforeCompile = (sh, r) => {
      prev?.call(mat, sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', T.ShaderChunk.normal_fragment_begin.replace('normal = normal * faceDirection;', ''));
    };
    return mat;
  }

  // Leaves and needles painted on a canvas with see-through gaps, for the cards
  // that make a crown's ragged outline: a spray of small leaves on twigs, or a
  // whole spruce crown's ragged outline (taller). Pale and greyish, the
  // greens come from the vertex colours and the instance tint.
  function leafTexture(kind) {
    const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const cx = cv.getContext('2d'), rand = rng(kind === 'leaf' ? 31 : 37);
    if (kind === 'leaf') {
      cx.strokeStyle = 'rgb(90,80,60)'; cx.lineWidth = 2;
      for (let k = 0; k < 7; k++) { const a = rand() * 6.3; cx.beginPath(); cx.moveTo(128, 128); cx.lineTo(128 + Math.cos(a) * 100, 128 + Math.sin(a) * 100); cx.stroke(); }
      for (let k = 0; k < 150; k++) {
        const a = rand() * 6.3, r = Math.sqrt(rand()) * 108, x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r, len = 13 + rand() * 12, l = 150 + rand() * 105;
        cx.save(); cx.translate(x, y); cx.rotate(rand() * 6.3);
        cx.fillStyle = `rgb(${l * 0.86 | 0},${l | 0},${l * 0.7 | 0})`;
        cx.beginPath(); cx.moveTo(0, -len / 2); cx.quadraticCurveTo(len * 0.32, 0, 0, len / 2); cx.quadraticCurveTo(-len * 0.32, 0, 0, -len / 2); cx.fill();
        cx.restore();
      }
    } else {
      // A spruce seen from the side: drooping branches either side of the
      // stem, longer further down, in loose tiers, each fringed with needles.
      cv.height = 512;
      for (let y = 6; y < 500; y += 5 + rand() * 4) {
        const tier = 0.72 + 0.28 * ((y / 70) % 1), reach = (12 + (y / 512) * 112) * tier * (0.85 + rand() * 0.3);
        for (const sd of [-1, 1]) {
          const len = reach * (0.8 + rand() * 0.4), droop = len * (0.25 + rand() * 0.2), l = 110 + rand() * 80;
          cx.strokeStyle = `rgb(${l * 0.82 | 0},${l | 0},${l * 0.85 | 0})`; cx.lineWidth = 1.4;
          for (let t = 0; t < 1; t += 0.06) {
            const x = 128 + sd * len * t, yy = y + droop * t * t;
            cx.beginPath(); cx.moveTo(x, yy); cx.lineTo(x + sd * (3 + rand() * 4), yy + 4 + rand() * 7); cx.stroke();
            cx.beginPath(); cx.moveTo(x, yy); cx.lineTo(x + sd * (3 + rand() * 4), yy - 2 - rand() * 4); cx.stroke();
          }
        }
      }
    }
    const tex = new T.CanvasTexture(cv);
    tex.anisotropy = 4; // three keeps it to what the GPU allows
    return tex;
  }
  // Cards scattered over a ball (centre, radius), each turned at random, with
  // normals pointing away from the crown's middle (mid) and colours darker low
  // in the crown and deep inside it.
  function leafCards(count, c, r, size, mid, seed) {
    const rand = rng(seed), out = [], m = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), v = new T.Vector3(), one = new T.Vector3(1, 1, 1);
    for (let k = 0; k < count; k++) {
      const geo = new T.PlaneGeometry(size * (0.8 + rand() * 0.4), size * (0.8 + rand() * 0.4)).toNonIndexed();
      let dx, dy, dz;
      do { dx = rand() * 2 - 1; dy = rand() * 2 - 1; dz = rand() * 2 - 1; } while (dx * dx + dy * dy + dz * dz > 1);
      const depth = 0.7 + rand() * 0.35, l = Math.hypot(dx, dy, dz) || 1;
      v.set(c[0] + (dx / l) * r * depth, c[1] + (dy / l) * r * depth, c[2] + (dz / l) * r * depth);
      q.setFromEuler(e.set(rand() * 6.3, rand() * 6.3, rand() * 6.3));
      geo.applyMatrix4(m.compose(v, q, one));
      const p = geo.attributes.position, nrm = [], col = [];
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i) - mid[0], y = p.getY(i) - mid[1], z = p.getZ(i) - mid[2], n = Math.hypot(x, y, z) || 1;
        nrm.push(x / n, y / n, z / n);
        const shade = (0.35 + 0.65 * depth) * (0.7 + 0.45 * Math.min(1, Math.max(0, y / mid[3] + 0.5)));
        col.push(shade, shade, shade);
      }
      geo.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      out.push(geo);
    }
    return merge(out);
  }
  let treeKit = null;
  // Each kind is a list of [geometry, material]: the solid body, and the
  // see-through leaf or needle cards round it.
  function treeKinds() {
    if (treeKit) return treeKit;
    const mat = new T.MeshLambertMaterial({ vertexColors: true });
    const cardMat = (kind, colour) => {
      const m = bothSides(new T.MeshLambertMaterial({ vertexColors: true, color: colour, map: leafTexture(kind), alphaTest: 0.5, alphaToCoverage: true }));
      // Shadows with the same holes as the leaves.
      m.userData.depth = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, map: m.map, alphaTest: 0.5 });
      return m;
    };
    const leafMat = cardMat('leaf', 0x6f9a48), needleMat = cardMat('needle', 0x3d6340), hedgeMat = cardMat('leaf', 0x5c7f3c);
    const trunk = (r0, r1, h) => { const t = new T.CylinderGeometry(r0, r1, h, 6, 1, true); t.translate(0, h / 2, 0); return part(t, 0x4a3a2a); };
    // Spruce, about 11 m: four cones narrowing upwards, darker underneath each
    // tier, inside crossed cards that give it a ragged outline of branches.
    const spruce = [trunk(0.1, 0.22, 3)], twigs = [];
    for (let k = 0; k < 4; k++) {
      const r = 2.3 - k * 0.48, h = 3.4 - k * 0.3, y = 1.6 + k * 2.05;
      const c = new T.ConeGeometry(r * 0.72, h, 9, 1, true); c.translate(0, y + h / 2, 0);
      spruce.push(part(c, 0x1d3b22, [0, y + h * 0.5, h]));
    }
    // Five upright cards crossing at the stem, each the whole crown's outline.
    for (let k = 0; k < 5; k++) {
      const c = new T.PlaneGeometry(5, 10, 2, 1).toNonIndexed();
      c.rotateY((k * Math.PI) / 5); c.translate(0, 6.3, 0);
      const p = c.attributes.position, nrm = [], col = [];
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), l = Math.hypot(x, 0.6, z);
        nrm.push(x / l, 0.6 / l, z / l);
        const sh = 0.65 + 0.45 * Math.min(1, Math.max(0, (y - 1.3) / 10));
        col.push(sh, sh, sh);
      }
      c.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
      c.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      twigs.push(c);
    }
    // Broadleaf, about 9 m: a trunk, five dark lumpy balls for body and many
    // leaf cards over them; fewer cards and plainer balls far from the road.
    const leafy = detail => {
      const body = [trunk(0.16, 0.28, 4.4)], cards = [];
      for (const [x, y, z, r] of [[0, 5.8, 0, 2.6], [1.4, 5.1, 0.6, 1.9], [-1.3, 5.3, -0.5, 2], [0.3, 7.2, -0.3, 1.9], [-0.4, 5, 1.4, 1.7]]) {
        const s = new T.IcosahedronGeometry(r * 0.68, detail); s.translate(x, y, z);
        body.push(part(foliage(s, 0, 5.8, 0, 0.35, x * 3 + z), 0x2c4f1d, [0, 5.8, 4.5]));
        cards.push(leafCards(detail ? 18 : 5, [x, y, z], r, r * (detail ? 0.9 : 1.4), [0, 5.8, 0, 4.5], Math.round(x * 10 + z * 7 + 50)));
      }
      return [[merge(body), mat], [merge(cards), leafMat]];
    };
    // A hedge: a 5 m length of three bushy blobs, leafy at the surface.
    const hedge = [], hedgeCards = [];
    [-1.7, 0, 1.7].forEach((x, k) => {
      const b = new T.IcosahedronGeometry(1, 0); b.scale(1.4, 0.85, 0.7); b.translate(x, 0.85, 0);
      hedge.push(part(foliage(b, x, 0.85, 0, 0.4, k * 2.3), 0x2b4a1e, [0, 0.9, 1.8]));
      hedgeCards.push(leafCards(7, [x, 0.95, 0], 1.15, 1.1, [0, 0.6, 0, 1.8], k * 5 + 3));
    });
    // A white marker post with a black band, as along a Belgian country road.
    const post = new T.BoxGeometry(0.12, 1, 0.12); post.translate(0, 0.5, 0);
    const band = new T.BoxGeometry(0.13, 0.18, 0.13); band.translate(0, 0.78, 0);
    // A low bush for the verge.
    const tuft = new T.IcosahedronGeometry(0.4, 1); tuft.scale(1.2, 0.75, 1); tuft.translate(0, 0.2, 0);
    treeKit = {
      tuft: [[merge([part(foliage(tuft, 0, 0.1, 0, 0.3, 4.1), 0x2f4a20, [0, 0.25, 0.7])]), mat], [leafCards(12, [0, 0.4, 0], 0.62, 0.65, [0, 0.1, 0, 0.7], 9), hedgeMat]],
      spruce: [[merge(spruce), mat], [merge(twigs), needleMat]], leafy: leafy(0), leafyNear: leafy(1),
      hedge: [[merge(hedge), mat], [merge(hedgeCards), hedgeMat]], post: [[merge([part(post, 0xeeeeee), part(band, 0x202020)]), mat]],
    };
    return treeKit;
  }
  // Instances of one kind: spots are [x, y, z, scale, turn, tint, height scale].
  function instances(geo, mat, spots, shadow) {
    if (!spots.length) return [];
    // three r149 culls instances by the bare shape at the origin, so each
    // piece gets a bounding sphere around its own spots.
    const box = new T.Box3(), pt = new T.Vector3();
    for (const [x, y, z] of spots) box.expandByPoint(pt.set(x, y, z));
    const g = new T.BufferGeometry();
    for (const k of ['position', 'normal', 'color', 'uv']) if (geo.attributes[k]) g.setAttribute(k, geo.attributes[k]);
    g.boundingSphere = box.getBoundingSphere(new T.Sphere()); g.boundingSphere.radius += 14;
    const mesh = new T.InstancedMesh(g, mat, spots.length);
    const m = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), sc = new T.Vector3(), v = new T.Vector3(), c = new T.Color();
    spots.forEach(([x, y, z, s, turn, tint, hs = 1], k) => {
      q.setFromEuler(e.set(0, turn, 0)); sc.set(s, s * hs, s);
      mesh.setMatrixAt(k, m.compose(v.set(x, y, z), q, sc));
      mesh.setColorAt(k, c.setRGB(1 + tint, 1 + tint * 0.8, 1 + tint * 0.4));
    });
    mesh.castShadow = shadow;
    if (mat.userData.depth) mesh.customDepthMaterial = mat.userData.depth;
    mesh.userData.sharedParts = true; // the geometry's attributes belong to the kit
    return [mesh];
  }

  // Trees, hedges and marker posts beside points s..e-1. Woods are dense near
  // the road and thinner further out; farmland gets the odd tree, hedges on
  // some field edges and a tree now and then in a hedge.
  // `avoid(x, z, i)` is true where nothing may stand (an open summit).
  function trees(g, s, e, seed, avoid) {
    const kit = treeKinds(), rand = rng(seed), spruce = [[], []], leafy = [[], []], hedges = [], posts = [], tufts = [];
    // Clear of every road, not just this stretch: on an out and back, a
    // hairpin or a road passing close by, trees used to stand on the other one.
    const clearOfRoad = (x, z, gap) => roadDist(g, x, z) >= gap;
    // Only trees near the road cast shadows (the sun's shadow covers a 70 m
    // square round the rider); drawing the rest into the shadow map is waste.
    const tree = (x, z, i, scale, kind, o) => {
      const y = groundAt(g, x, z, 300).y - 0.3;
      (kind ? spruce : leafy)[o < 45 ? 0 : 1].push([x, y, z, scale, rand() * 6.3, (rand() - 0.5) * 0.35, 0.85 + rand() * 0.3]);
    };
    for (let i = s; i < e; i++) {
      if (g.dup[i]) continue; // this road's scenery was built the first time along it
      for (const sg of [-1, 1]) {
        for (let o = 6 + rand() * 4; o < 520; o += 4.5 + o * 0.05 + rand() * 4) { // woods close-set, and deep enough to fill a hillside
          const a = (rand() - 0.5) * STEP, ii = Math.min(g.n - 2, i);
          const fx = g.xz[ii + 1][0] - g.xz[ii][0], fz = g.xz[ii + 1][1] - g.xz[ii][1], fl = Math.hypot(fx, fz) || 1;
          const x = g.xz[i][0] + g.side[i][0] * o * sg + (fx / fl) * a, z = g.xz[i][1] + g.side[i][1] * o * sg + (fz / fl) * a;
          const w = woods(x, z);
          if (w < WOOD - 0.01 && !(rand() < 0.004 && (!REAL || REAL.open(x, z)))) continue; // a lone tree in the fields now and then
          if (avoid(x, z, i) || !clearOfRoad(x, z, ROAD_HALF + 4)) continue;
          const pine = REAL ? REAL.conifer(x, z) : noise(x / 240 + 11, z / 240) > 0.48;
          tree(x, z, i, (0.75 + rand() * 0.5) * (w < WOOD ? 1.1 : 1), w > WOOD && pine, o);
        }
      }
    }
    // Hedges: walk the field edges near this stretch of road.
    const xs = [], zs = [];
    for (let i = s; i <= e; i++) { xs.push(g.xz[i][0]); zs.push(g.xz[i][1]); }
    const R = 150, x0 = Math.min(...xs) - R, x1 = Math.max(...xs) + R, z0 = Math.min(...zs) - R, z1 = Math.max(...zs) + R;
    const nearest = (x, z) => {
      let best = Infinity, bi = -1;
      for (const j of nearRoad(g, x, z, R + 100)) { const dx = g.xz[j][0] - x, dz = g.xz[j][1] - z, d = dx * dx + dz * dz; if (d < best) { best = d; bi = j; } }
      return [Math.sqrt(best), bi];
    };
    const hedgeAt = (x, z, turn) => {
      if (woods(x, z) > WOOD - 0.02 || (REAL && !REAL.hedgy(x, z))) return;
      const [d, j] = nearest(x, z);
      if (j < s || j >= e || d > R || d < ROAD_HALF + 5 || avoid(x, z, j)) return;
      const f = field(x, z); if (!f.hedge) return;
      hedges.push([x, groundAt(g, x, z, R).y - 0.15, z, 1, turn, (rand() - 0.5) * 0.25, 0.8 + rand() * 0.5]);
      if (rand() < 0.07 && d > ROAD_HALF + 8) tree(x, z, j, 0.8 + rand() * 0.4, false, d);
    };
    // The corners of the area in field coordinates.
    const us = [], vs = [];
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) { us.push(x * FCOS + z * FSIN); vs.push(-x * FSIN + z * FCOS); }
    const toXZ = (u, v) => [u * FCOS - v * FSIN, u * FSIN + v * FCOS];
    const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
    for (let c = Math.floor(u0 / FCOL); c <= Math.ceil(u1 / FCOL); c++) {
      // Along the column's edge (lengthwise).
      for (let v = v0; v < v1; v += 5) { const [x, z] = toXZ(c * FCOL + 0.01, v + 2.5); if (x > x0 && x < x1 && z > z0 && z < z1) hedgeAt(x, z, -FA + Math.PI / 2); }
      // Across, at the ends of each field in the column.
      const rowH = 55 + hash(c, 1.7) * 90, sh = hash(c, 2.9) * 300;
      for (let r = Math.floor((v0 + sh) / rowH); r <= Math.ceil((v1 + sh) / rowH); r++) {
        for (let u = c * FCOL + 2.5; u < (c + 1) * FCOL; u += 5) { const [x, z] = toXZ(u, r * rowH - sh + 0.01); if (x > x0 && x < x1 && z > z0 && z < z1) hedgeAt(x, z, -FA); }
      }
    }
    // The odd bush along the verge, more where it is wooded (the grass itself
    // is blades, near the rider: see grassTuft).
    for (let i = s; i < e; i++) {
      if (g.dup[i]) continue;
      for (const sg of [-1, 1]) for (let k = 0; k < 4; k++) {
        const o = sg * (ROAD_HALF + 0.9 + rand() ** 1.5 * 9), a = rand() * STEP;
        const x = g.xz[i][0] + g.side[i][0] * o + (g.xz[Math.min(g.n - 1, i + 1)][0] - g.xz[i][0]) * (a / STEP), z = g.xz[i][1] + g.side[i][1] * o + (g.xz[Math.min(g.n - 1, i + 1)][1] - g.xz[i][1]) * (a / STEP);
        if (!clearOfRoad(x, z, ROAD_HALF + 0.6)) continue;
        const big = rand() < (woods(x, z) > WOOD ? 0.15 : REAL && !REAL.open(x, z) ? 0 : 0.03);
        if (!big) continue;
        tufts.push([x, groundAt(g, x, z, 40).y - 0.05, z, big ? 1 + rand() * 0.6 : 0.4 + rand() * 0.5, rand() * 6.3, (rand() - 0.5) * 0.4, big ? 1.3 : 0.6 + rand() * 0.5]);
      }
    }
    // Marker posts every 50 m on both sides.
    for (let i = s - (s % 5); i < e; i += 5) {
      if (i < s) continue;
      if (g.dup[i]) continue;
      for (const sg of [-1, 1]) { const p = groundY(g, i, sg * (ROAD_HALF + 0.9)); if (clearOfRoad(p.x, p.z, ROAD_HALF + 0.5)) posts.push([p.x, p.y, p.z, 1, 0, 0, 1]); }
    }
    // Grouped in 250 m squares, so the squares out of sight or past the haze
    // are skipped as a whole (see `scatter` in mount).
    const out = [];
    for (const [geo, list, shadow] of [[kit.spruce, spruce[0], true], [kit.spruce, spruce[1], false], [kit.leafyNear, leafy[0], true], [kit.leafy, leafy[1], false], [kit.hedge, hedges, false], [kit.post, posts, false], [kit.tuft, tufts, false]]) {
      const cells = new Map();
      for (const sp of list) { const k = Math.floor(sp[0] / 250) * 65536 + Math.floor(sp[2] / 250); cells.get(k)?.push(sp) || cells.set(k, [sp]); }
      for (const c of cells.values()) for (const [part, mat] of geo) out.push(...instances(part, mat, c, shadow));
    }
    return out;
  }

  // Grass blades by the road. A tuft is sixteen thin curved blades, dark at
  // the root; tufts are scattered on the verge and into the fields for the
  // few stretches round the rider (see `grass` in mount) and take the land's
  // colour where they stand. They sway in the wind.
  function grassTuft() {
    const pos = [], col = [], nrm = [], idx = [], rand = rng(5);
    for (let b = 0; b < 16; b++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 0.3, h = 0.14 + rand() * 0.24, w = 0.009 + rand() * 0.008;
      const bx = Math.cos(a) * r, bz = Math.sin(a) * r, turn = rand() * Math.PI, lean = 0.25 + rand() * 0.45, la = a + (rand() - 0.5);
      const cx = Math.cos(turn) * w, cz = Math.sin(turn) * w, v0 = pos.length / 3;
      // Base pair, middle pair, tip; the blade bends outwards as it rises.
      for (const [t, ww] of [[0, 1], [0.55, 0.75], [1, 0]]) {
        const out = lean * h * t * t, x = bx + Math.cos(la) * out, z = bz + Math.sin(la) * out, y = h * (t - 0.25 * lean * t * t);
        for (const sd of ww ? [-1, 1] : [0]) { pos.push(x + cx * ww * sd, y, z + cz * ww * sd); const l = 0.68 + 0.45 * t; col.push(l, l, l); nrm.push(0, 1, 0); }
      }
      idx.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2, v0 + 2, v0 + 3, v0 + 4);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3)); // lit like the ground under it
    geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mat = new T.MeshLambertMaterial({ vertexColors: true });
    const wind = { value: 0 };
    mat.onBeforeCompile = sh => {
      sh.uniforms.wind = wind;
      sh.vertexShader = 'uniform float wind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  vec4 at = instanceMatrix[3];
  float sway = sin(wind * 1.7 + at.x * 0.31 + at.z * 0.23) * 0.6 + sin(wind * 3.1 + at.x * 1.3 - at.z * 0.7) * 0.25;
  transformed.xz += vec2(0.3, 0.18) * sway * transformed.y * transformed.y * 3.0;`);
    };
    mat.customProgramCacheKey = () => 'grass';
    bothSides(mat); // lit as the ground is, from either side
    return { geo, mat, wind };
  }
  // The tufts for the stretch of road from point i: [x, y, z, size, turn, r, g, b].
  function grassStretch(g, i) {
    const rand = rng(i * 7919 + 13), out = [], j = Math.min(g.n - 2, i);
    const fx = g.xz[j + 1][0] - g.xz[j][0], fz = g.xz[j + 1][1] - g.xz[j][1], fl = Math.hypot(fx, fz) || 1;
    for (let k = 0; k < 340; k++) {
      const sg = rand() < 0.5 ? -1 : 1, o = ROAD_HALF + 0.3 + rand() ** 1.4 * 14, a = rand() * STEP;
      const x = g.xz[j][0] + g.side[j][0] * o * sg + (fx / fl) * a, z = g.xz[j][1] + g.side[j][1] * o * sg + (fz / fl) * a;
      if (roadDist(g, x, z) < ROAD_HALF + 0.25) continue; // on a bend, or another part of the route
      ground(x, z, rgb, o);
      if (rgb[3] === 1 || (rgb[3] !== 2 && rgb[0] - rgb[1] > 0.04)) continue; // ploughed land, rock, snow, water, paving
      const tint = 0.85 + rand() * 0.4, s = (0.7 + rand() * 0.7) * (rgb[3] === 2 ? 1.8 : 1); // lavender stands taller
      out.push(x, groundAt(g, x, z, 40).y - 0.02, z, s, rand() * 6.3, rgb[0] * tint, rgb[1] * tint * 1.05, rgb[2] * tint);
    }
    return out;
  }

  // Where the scenery goes. A built-in course says so itself; any other route
  // gets a gantry at the start and the finish.
  function sceneryOf(route) {
    const total = route.total, c = route.scenery;
    if (c) {
      const pos = d => (d < 0 ? total + d : d);
      return { arch: c.arch.map(([d, text]) => [pos(d), text]), flags: c.flags || [], clearings: c.clearings || [] };
    }
    return { arch: total > 400 && !route.roam ? [[25, 'START'], [total - 25, 'FINISH']] : [[25, 'START']], flags: [], clearings: [] }; // a free ride has no finish
  }

  // Clouds: a few clusters of flattened balls high up, drifting slowly. Like
  // the mountains they stay round the camera.
  function clouds() {
    const group = new T.Group(), rand = rng(99);
    const mat = new T.MeshLambertMaterial({ vertexColors: true, emissive: 0x9aa6b4, fog: false });
    const kinds = [0, 1, 2].map(() => {
      const parts = [];
      for (let k = 0, n = 5 + Math.floor(rand() * 4); k < n; k++) {
        const s = new T.IcosahedronGeometry(1, 2), r = 0.5 + rand() * 0.5;
        s.scale(r * 1.4, r * 0.7, r); s.translate((k / n - 0.5) * 3.2 + rand() * 0.4, rand() * 0.3, (rand() - 0.5) * 0.9);
        parts.push(part(foliage(s, 0, 0, 0, 0.15, k), 0xffffff, [0, 0.1, 1.4]));
      }
      return merge(parts);
    });
    for (let k = 0; k < 20; k++) {
      const a = rand() * Math.PI * 2, r = 250 + rand() * 350;
      const m = new T.Mesh(kinds[k % 3], mat);
      m.position.set(Math.cos(a) * r, 140 + rand() * 90, Math.sin(a) * r);
      m.scale.setScalar(16 + rand() * 18); m.rotation.y = rand() * Math.PI;
      group.add(m);
    }
    return group;
  }

  // Start and finish gantries over the road, and flags lining the summit.
  function props(g, sc) {
    const group = new T.Group();
    const headingAt = i => { const a = g.xz[Math.max(0, i - 1)], b = g.xz[Math.min(g.n - 1, i + 1)]; return Math.atan2(b[0] - a[0], b[1] - a[1]); };
    const idx = d => Math.min(g.n - 1, Math.max(0, Math.round(d / STEP)));
    const dark = new T.MeshLambertMaterial({ color: 0x23262d });
    const banner = (text, w, h, bg) => {
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = Math.round((512 * h) / w);
      const cx = cv.getContext('2d');
      cx.fillStyle = bg; cx.fillRect(0, 0, cv.width, cv.height);
      cx.fillStyle = '#fff'; cx.font = `800 ${Math.round(cv.height * 0.55)}px "Segoe UI", sans-serif`; cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillText(text, cv.width / 2, cv.height / 2 + 2);
      return new T.MeshLambertMaterial({ map: new T.CanvasTexture(cv) });
    };
    for (const [d, text] of sc.arch) {
      const i = idx(d), gantry = new T.Group(), span = ROAD_HALF * 2 + 2.4;
      for (const sg of [-1, 1]) {
        const post = new T.Mesh(new T.BoxGeometry(0.35, 5.2, 0.35), dark);
        post.position.set((sg * span) / 2, 2.6, 0); post.castShadow = true; gantry.add(post);
      }
      const face = banner(text, span, 1.3, '#ff6a14');
      const board = new T.Mesh(new T.BoxGeometry(span + 0.4, 1.3, 0.25), [dark, dark, dark, dark, face, face]);
      board.position.set(0, 4.6, 0); board.castShadow = true; gantry.add(board);
      gantry.position.set(g.xz[i][0], g.y[i], g.xz[i][1]);
      gantry.rotation.y = Math.atan2(g.side[i][0], g.side[i][1]) - Math.PI / 2;
      group.add(gantry);
    }
    const cloth = [0xff6a14, 0x2a6fdb].map(c => new T.MeshLambertMaterial({ color: c, side: T.DoubleSide }));
    for (const [d0, d1] of sc.flags) {
      let k = 0;
      for (let d = d0; d < d1; d += 18, k++) {
        const i = idx(d), sg = k % 2 ? 1 : -1, p = groundY(g, i, sg * (ROAD_HALF + 1.4));
        const pole = new T.Mesh(new T.CylinderGeometry(0.04, 0.05, 4, 5), dark); pole.position.set(p.x, p.y + 2, p.z);
        const flag = new T.Mesh(new T.PlaneGeometry(0.7, 2.2), cloth[k % 4 < 2 ? 0 : 1]);
        flag.position.set(p.x, p.y + 2.8, p.z); flag.rotation.y = headingAt(i); flag.translateX(0.36);
        flag.castShadow = pole.castShadow = true;
        group.add(pole, flag);
      }
    }
    return group;
  }

  // ---- The ground's paint. Each piece of land gets a texture painted from
  // ground() at a resolution that depends on how close it is: fields with
  // their crop rows and margins, woods, the verge. Painted a few rows per
  // frame (a generator), so a new piece never stalls the ride.
  function* paintLand(g, mesh, mpp) {
    const p = mesh.userData.paint, out = [0, 0, 0];
    let W, H, at;
    if (p.tile) {
      const [x0, z0] = p.tile;
      W = H = Math.ceil(TILE / mpp);
      at = (px, py) => ground(x0 + ((px + 0.5) * TILE) / W, z0 + ((py + 0.5) * TILE) / H, out);
    } else {
      const [s, e] = p.strip, len = (e - s) * STEP;
      W = Math.ceil((2 * NEAR) / mpp); H = Math.max(2, Math.ceil(len / mpp));
      at = (px, py) => {
        const o = ((px + 0.5) / W) * 2 * NEAR - NEAR, f = s + (((py + 0.5) / H) * len) / STEP;
        const i = Math.min(g.n - 2, Math.floor(f)), t = f - i, a = g.xz[i], b = g.xz[i + 1], sa = g.side[i], sb = g.side[i + 1];
        const sx = sa[0] + (sb[0] - sa[0]) * t, sz = sa[1] + (sb[1] - sa[1]) * t;
        return ground(a[0] + (b[0] - a[0]) * t + sx * o, a[1] + (b[1] - a[1]) * t + sz * o, out, Math.abs(o));
      };
    }
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d'), img = cx.createImageData(W, H), d = img.data;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        at(px, py);
        const k = ((H - 1 - py) * W + px) * 4; // canvas row 0 is the texture's top (v = 1)
        d[k] = Math.max(0, Math.min(255, out[0] * 255)); d[k + 1] = Math.max(0, Math.min(255, out[1] * 255)); d[k + 2] = Math.max(0, Math.min(255, out[2] * 255)); d[k + 3] = 255;
      }
      yield;
    }
    cx.putImageData(img, 0, 0);
    return cv;
  }
  // Land materials share a fine grain laid on by world position, so the
  // ground stays crisp right at the wheels whatever its painted resolution.
  // With the photographs (detail.photo) that grain is real grass, and real
  // soil wherever the painted colour is brown (ploughed land, stubble, wood
  // floor), each at two sizes so the repeat does not show. The photographs
  // are evened out to mid grey, so the paint keeps its colour (applied after
  // the vertex colours, so it sees the land's real colour either way).
  // snowCover: snow lying on the land, 0 none, 1 white over; shared by all.
  const snowCover = { value: 0 };
  function grained(mat, detail) {
    mat.onBeforeCompile = sh => {
      sh.uniforms.snowCover = snowCover;
      sh.uniforms.grassMap = { value: detail.grass };
      sh.uniforms.soilMap = { value: detail.soil };
      sh.vertexShader = 'varying vec2 vDetail;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vDetail = position.xz;');
      sh.fragmentShader = 'uniform sampler2D grassMap;\nuniform sampler2D soilMap;\nuniform float snowCover;\nvarying vec2 vDetail;\n' + sh.fragmentShader.replace('#include <color_fragment>', (detail.photo
        ? `#include <color_fragment>
  vec3 grassD = texture2D(grassMap, vDetail / 1.7).rgb * 0.65 + texture2D(grassMap, vDetail / 9.0 + 0.37).rgb * 0.35;
  vec3 soilD = texture2D(soilMap, vDetail / 2.5).rgb * 0.6 + texture2D(soilMap, vDetail / 12.0 + 0.21).rgb * 0.4;
  diffuseColor.rgb *= 2.0 * mix(grassD, soilD, smoothstep(0.0, 0.07, diffuseColor.r - diffuseColor.g));`
        : '#include <color_fragment>\n  float grain = texture2D(grassMap, vDetail / 3.0).r * 0.6 + texture2D(grassMap, vDetail / 19.0).r * 0.4;\n  diffuseColor.rgb *= 0.5 + 0.7 * grain;')
        // Snow: white with the grass showing through in patches.
        + '\n  float drift = texture2D(grassMap, vDetail / 23.0).g;\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.92, 0.96) * (0.9 + 0.2 * drift), snowCover * smoothstep(0.25, 0.6, drift + snowCover * 0.5));');
    };
    mat.customProgramCacheKey = () => detail.photo ? 'grained-photo' : 'grained';
    return mat;
  }

  // A photograph from vendor/photos.js as a tiling texture, or null when that
  // file did not load. It shows mid grey until the picture has decoded.
  function photo(name, renderer) {
    const src = window.IW_PHOTOS?.[name];
    if (!src) return null;
    const grey = document.createElement('canvas'); grey.width = grey.height = 1;
    const cx = grey.getContext('2d'); cx.fillStyle = '#808080'; cx.fillRect(0, 0, 1, 1);
    const tex = new T.Texture(grey), img = new Image();
    tex.needsUpdate = true;
    img.onload = () => { tex.dispose(); tex.image = img; tex.needsUpdate = true; }; // dispose: the GPU copy changes size
    img.src = src;
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }

  function kmSigns(g, total) {
    const group = new T.Group();
    for (let km = 1; km * 1000 < total; km++) {
      const i = Math.round((km * 1000) / STEP);
      if (i >= g.n) break;
      const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#f2f4f8'; cx.fillRect(0, 0, 128, 64);
      cx.fillStyle = '#ff7a1a'; cx.fillRect(0, 0, 128, 10);
      cx.fillStyle = '#11141a'; cx.font = 'bold 34px "Segoe UI", sans-serif'; cx.textAlign = 'center'; cx.fillText(`${km} km`, 64, 50);
      const tex = new T.CanvasTexture(cv);
      const board = new T.Mesh(new T.PlaneGeometry(1.6, 0.8), new T.MeshBasicMaterial({ map: tex, side: T.DoubleSide }));
      const pole = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 1.6, 5), new T.MeshLambertMaterial({ color: 0x9aa0aa }));
      const p = groundY(g, i, ROAD_HALF + 1.5);
      board.position.set(p.x, p.y + 1.9, p.z);
      pole.position.set(p.x, p.y + 0.8, p.z);
      // Face the oncoming rider.
      board.rotation.y = Math.atan2(-g.side[i][1], g.side[i][0]);
      group.add(board, pole);
    }
    return group;
  }

  // Surfaces painted once on a canvas and tiled: asphalt grit and grass. Kept
  // light grey so the colour comes from the material (or the land's own
  // greens) and the texture only adds the grain.
  function surface(kind, renderer) {
    const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const cx = cv.getContext('2d'), rand = rng(kind === 'road' ? 11 : kind === 'gravel' ? 37 : 23);
    const img = cx.createImageData(N, N), d = img.data;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const k = (y * N + x) * 4;
      // Tileable blotches (noise on a wrapped grid) plus per-pixel grit.
      const u = x / N, v = y / N, blot = (noise(u * 8, v * 8) + noise((u * 8 + 4) % 8, v * 8)) / 2;
      let l = kind === 'road' ? 0.8 + 0.12 * blot + (rand() - 0.5) * 0.28 : 0.72 + 0.22 * blot + (rand() - 0.5) * 0.3;
      if (kind === 'road' && rand() < 0.015) l += 0.25; // light stones in the tar
      if (kind === 'gravel') { l = 0.7 + 0.18 * blot + (rand() - 0.5) * 0.45; if (rand() < 0.06) l += 0.3; else if (rand() < 0.05) l -= 0.3; } // loose stones
      const c = Math.max(0, Math.min(255, l * 255));
      d[k] = d[k + 1] = d[k + 2] = c; d[k + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    if (kind === 'grass') {
      for (let i = 0; i < 2600; i++) { // blades
        const x = rand() * N, y = rand() * N, l = Math.round(150 + rand() * 105);
        cx.strokeStyle = `rgba(${l},${l},${l},0.7)`; cx.lineWidth = 1;
        cx.beginPath(); cx.moveTo(x, y); cx.lineTo(x + (rand() - 0.5) * 3, y - 2 - rand() * 4); cx.stroke();
      }
    }
    const tex = new T.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }

  // A sky that pales towards the horizon, where it meets the haze.
  function sky() {
    const geo = new T.SphereGeometry(680, 32, 16), col = [], c = new T.Color(), top = new T.Color(0x5f93cc), low = new T.Color(HAZE);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const h = Math.max(0, p.getY(i) / 680); c.copy(low).lerp(top, Math.pow(h, 0.55)); col.push(c.r, c.g, c.b); }
    geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    const m = new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide, fog: false, depthWrite: false, depthTest: false }));
    m.renderOrder = -3; m.frustumCulled = false;
    return m;
  }

  // The photographed sky (see vendor/photos.js) on a dome round the camera,
  // from the top of the sky down to just under the horizon; the background
  // below it is the haze. The trees along the photo's horizon were taken out,
  // since they would stand still while the land moved.
  function photoSky(renderer) {
    const P = window.IW_PHOTOS, tex = photo('sky', renderer);
    if (!tex) return null;
    tex.wrapT = T.ClampToEdgeWrapping;
    const geo = new T.SphereGeometry(680, 48, 24, 0, Math.PI * 2, 0, (P.skyRows * Math.PI) / 180);
    const m = new T.Mesh(geo, new T.MeshBasicMaterial({ map: tex, side: T.BackSide, fog: false, depthWrite: false, depthTest: false }));
    m.scale.x = -1; // seen from inside, unmirrored
    // A veil over the photo for cloud, rain and fog: mixed toward a colour by
    // an amount, so the dome stays opaque and is still drawn first.
    const veil = { value: new T.Vector4(1, 1, 1, 0) };
    m.material.onBeforeCompile = sh => {
      sh.uniforms.veil = veil;
      sh.fragmentShader = 'uniform vec4 veil;\n' + sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, veil.rgb, veil.a);');
    };
    m.userData.veil = veil.value;
    m.renderOrder = -3; m.frustumCulled = false;
    // Where the sun is in the picture, so the shadows fall the way it shines.
    const phi = P.sun[0] * Math.PI * 2, th = ((90 - P.sun[1]) * Math.PI) / 180;
    m.userData.sun = new T.Vector3(Math.cos(phi) * Math.sin(th), Math.cos(th), Math.sin(phi) * Math.sin(th));
    return m;
  }

  // Mountains all round, past the fog, standing on a level line. They give the
  // eye a horizon that does not tilt with the road. Drawn first and behind
  // everything; they follow the camera sideways, and sink only a little as
  // the rider climbs, like real far-off hills.
  // With the photographed sky (haze given) they are lower and fade from a
  // hazy blue-green at the ridge into the haze at their foot, as real far
  // hills do; without it, flat pale shapes.
  function mountains(haze) {
    const group = new T.Group();
    for (const [r, top, colour, seed] of [[640, 0.75, 0xb3c4d2, 3.1], [600, 0.5, 0xa5b8bb, 7.7]]) {
      const N = 160, pos = [], idx = [], col = [], ridge = new T.Color(r === 600 ? 0x6f7f7c : 0x84919c), c = new T.Color(), lift = haze ? 0.55 : 1;
      for (let k = 0; k <= N; k++) {
        const a = (k / N) * Math.PI * 2, h = 25 + lift * top * (noise(Math.cos(a) * 3 + seed, Math.sin(a) * 3) * 140 + noise(Math.cos(a) * 9, Math.sin(a) * 9 + seed) * 40);
        pos.push(Math.cos(a) * r, -150, Math.sin(a) * r, Math.cos(a) * r, h, Math.sin(a) * r);
        if (haze) { c.copy(haze); col.push(c.r, c.g, c.b); c.lerp(ridge, Math.min(1, h / 90)); col.push(c.r, c.g, c.b); }
        if (k) { const b = (k - 1) * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      if (haze) geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      const m = new T.Mesh(geo, new T.MeshBasicMaterial(haze ? { vertexColors: true } : { color: colour }));
      Object.assign(m.material, { fog: false, side: T.DoubleSide, depthWrite: false, depthTest: false });
      m.renderOrder = -2 + (r === 600 ? 1 : 0); m.frustumCulled = false;
      group.add(m);
    }
    return group;
  }

  // The rider and bike, posed every frame. Joints are placed by hand-written
  // geometry rather than a loaded model: the legs follow the pedals by
  // two-bone IK (hip fixed on the saddle, ankle above a foot that tips with
  // the stroke), the arms reach the hoods, and standing up on a climb moves
  // the hips and shoulders forward. Body parts are lofted from measured
  // cross-sections (calf, quad, a rounded back, glutes) rather than
  // cylinders, so the shapes read as a person from the chase camera.
  // The model faces -z; units are metres.
  // Kit printed on canvases. The jersey's u runs round the body from his
  // left side (0) over the chest (0.25, the zip) and right side (0.5) to the
  // middle of the back (0.75); v runs from the bib shorts (0) up to the
  // collar (1). The helmet: shell with vent slots.
  // kit: [jersey, helmet] colours for a race rival; without, his own orange kit.
  const hex = (n, f = 1) => '#' + [16, 8, 0].map(b => Math.round(((n >> b) & 255) * f).toString(16).padStart(2, '0')).join('');
  function kitTexture(kind, kit) {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
    const cx = cv.getContext('2d');
    if (kind === 'jersey' && kit) { // the same jersey in a rival's colours
      cx.fillStyle = hex(kit[0]); cx.fillRect(0, 0, 256, 128);
      cx.fillStyle = hex(kit[1]); cx.fillRect(116, 0, 24, 128); cx.fillRect(244, 0, 12, 128); cx.fillRect(0, 0, 12, 128); cx.fillRect(0, 34, 256, 7);
      cx.fillStyle = hex(kit[0], 0.82); cx.fillRect(160, 80, 64, 20); cx.fillRect(0, 98, 256, 4);
      cx.fillStyle = '#15171b'; cx.fillRect(0, 102, 256, 26);
    } else if (kind === 'helmet' && kit) {
      cx.fillStyle = hex(kit[1]); cx.fillRect(0, 0, 256, 128);
      cx.fillStyle = '#1b1e23';
      for (const u of [96, 112, 128, 144, 160]) for (const v of [28, 52]) { cx.beginPath(); cx.ellipse(u, v, 4, 9, 0, 0, Math.PI * 2); cx.fill(); }
      cx.fillStyle = hex(kit[0]); cx.fillRect(0, 96, 256, 6);
    } else if (kind === 'jersey') {
      cx.fillStyle = '#ff7a1a'; cx.fillRect(0, 0, 256, 128);
      cx.fillStyle = '#1f2329'; cx.fillRect(116, 0, 24, 128); cx.fillRect(244, 0, 12, 128); cx.fillRect(0, 0, 12, 128); // side panels
      cx.fillStyle = '#2a2d33'; cx.fillRect(0, 0, 256, 12); // dark yoke over the shoulders
      cx.fillStyle = '#f4f5f7'; cx.fillRect(0, 34, 256, 7); // chest band
      cx.fillStyle = '#d9621a'; // three back pockets, a shade darker, with their seams
      cx.fillRect(160, 80, 64, 20);
      cx.fillStyle = '#b4500f'; for (const u of [160, 181, 202, 223]) cx.fillRect(u, 80, 1.5, 20); cx.fillRect(160, 80, 64, 1.5);
      cx.fillStyle = '#c85a14'; cx.fillRect(0, 98, 256, 4); // hem gripper
      cx.fillStyle = '#15171b'; cx.fillRect(0, 102, 256, 26); // bib shorts below the hem
      cx.fillStyle = '#2a2d33'; cx.fillRect(63, 12, 2, 86); // zip
    } else { // helmet: shell with vent slots from front to back
      cx.fillStyle = '#f4f5f7'; cx.fillRect(0, 0, 256, 128);
      cx.fillStyle = '#1b1e23';
      for (const u of [96, 112, 128, 144, 160]) for (const v of [28, 52]) { cx.beginPath(); cx.ellipse(u, v, 4, 9, 0, 0, Math.PI * 2); cx.fill(); }
      for (const u of [10, 30, 226, 246]) { cx.beginPath(); cx.ellipse(u, 40, 4, 8, 0, 0, Math.PI * 2); cx.fill(); }
      cx.fillStyle = '#ff7a1a'; cx.fillRect(0, 96, 256, 6); // a stripe round the rim
    }
    const t = new T.CanvasTexture(cv); t.anisotropy = 4;
    return t;
  }

  // A closed tube along local y, from -0.5 to 0.5 so `orient` can stretch it
  // between two joints. Each ring is [t, half-width, half-depth, forward
  // offset]: t from 0 at the first joint to 1 at the second (a little past
  // either end rounds it off), "forward" being the side `orient` is told.
  function loft(rings, seg = 18) {
    const pos = [], uv = [], idx = [], n = rings.length, t0 = rings[0][0], t1 = rings[n - 1][0];
    for (const [t, rx, rz, cz = 0] of rings) {
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        pos.push(rx * Math.cos(a), t - 0.5, cz + rz * Math.sin(a));
        uv.push(j / seg, (t - t0) / (t1 - t0));
      }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + seg + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const nr = g.attributes.normal; // the seam: both copies of each ring's first point share one normal
    for (let i = 0; i < n; i++) {
      const a = i * (seg + 1), b = a + seg;
      for (let c = 0; c < 3; c++) { const m = (nr.array[a * 3 + c] + nr.array[b * 3 + c]) / 2; nr.array[a * 3 + c] = nr.array[b * 3 + c] = m; }
    }
    return g;
  }

  // The real body's painted kit in another colour: its orange (strongly
  // coloured, orange-hued pixels; skin is too pale to count) turned to this
  // colour at the same brightness.
  // Put on mat once made (a texture's size is fixed at its first upload, so
  // it is a new texture, not the old one redrawn).
  function recolor(src, color, mat) {
    const cv = document.createElement('canvas'), img = new Image();
    const tr = (color >> 16) & 255, tg = (color >> 8) & 255, tb = color & 255;
    img.onload = () => {
      cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
      const px = cx.getImageData(0, 0, cv.width, cv.height), a = px.data;
      for (let i = 0; i < a.length; i += 4) {
        const r = a[i], g = a[i + 1], b = a[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx < 80 || (mx - mn) / mx < 0.55 || r !== mx || b > g) continue;
        const hue = ((g - b) / (mx - mn)) * 60;
        if (hue < 8 || hue > 42) continue;
        const v = mx / 255;
        a[i] = tr * v; a[i + 1] = tg * v; a[i + 2] = tb * v;
      }
      cx.putImageData(px, 0, 0);
      const t = new T.CanvasTexture(cv); t.anisotropy = 4;
      mat.map = t; mat.needsUpdate = true; // the plain one is shared, so it stays
    };
    img.src = src;
  }

  function rider(kit) {
    const root = new T.Group();
    const mat = (c, rough = 0.7, metal = 0) => new T.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal });
    const M = {
      frame: mat(0x1d2a3a, 0.32, 0.25), dark: mat(0x16181c, 0.6), tyre: mat(0x141517, 0.85), rim: mat(0x8d949e, 0.4, 0.5), steel: mat(0xb8bec7, 0.3, 0.8),
      jersey: mat(0xff7a1a, 0.7), jersey2: mat(0x1f2329, 0.7), bib: mat(0x15171b, 0.55), skin: mat(0xd29a76, 0.62), sock: mat(0xf1f1f1, 0.85),
      shoe: mat(0xf2f3f5, 0.35), sole: mat(0x1c1e22, 0.5), glove: mat(0x1b1d21, 0.75), helmet: mat(0xf4f5f7, 0.3), visor: mat(0x20242a, 0.4),
      saddle: mat(0x111214, 0.45), carbon: mat(0x1a1c20, 0.35, 0.15), bottle: mat(0xe9edf2, 0.5), cap: mat(0x2a7de1, 0.5), hair: mat(0x3a2a1e, 0.9),
      chain: mat(0x6b7078, 0.45, 0.7), tape: mat(0x202226, 0.9), cuff: mat(0xf4f5f7, 0.7),
      lens: new T.MeshPhongMaterial({ color: 0x111317, specular: 0x8899aa, shininess: 90 }),
    };
    M.jerseyKit = new T.MeshStandardMaterial({ map: kitTexture('jersey', kit), roughness: 0.7 });
    M.helmetKit = new T.MeshStandardMaterial({ map: kitTexture('helmet', kit), roughness: 0.32 });
    if (kit) { M.jersey.color.setHex(kit[0]); M.cap.color.setHex(kit[1]); }
    // A unit cylinder along +y, centred, that `limb` stretches between two points.
    const unitCyl = (r0, r1, seg = 10) => new T.CylinderGeometry(r1, r0, 1, seg, 1);
    const up = new T.Vector3(0, 1, 0), tmpV = new T.Vector3(), tmpQ = new T.Quaternion(), basis = new T.Matrix4();
    const bx = new T.Vector3(), by = new T.Vector3(), bz = new T.Vector3();
    function limb(mesh, a, b) {
      tmpV.subVectors(b, a); const len = tmpV.length() || 1e-6;
      mesh.position.copy(a).addScaledVector(tmpV, 0.5);
      mesh.quaternion.copy(tmpQ.setFromUnitVectors(up, tmpV.divideScalar(len)));
      mesh.scale.set(1, len, 1);
    }
    // As limb, for a lofted part: its y runs from a to b and its forward
    // side (+z) turns towards `fwd`, so a calf sits at the back of the shin.
    function orient(mesh, a, b, fwd) {
      by.subVectors(b, a); const len = by.length() || 1e-6; by.divideScalar(len);
      bz.copy(fwd).addScaledVector(by, -fwd.dot(by)).normalize();
      bx.crossVectors(by, bz);
      mesh.quaternion.setFromRotationMatrix(basis.makeBasis(bx, by, bz));
      mesh.position.copy(a).addScaledVector(by, len * 0.5);
      mesh.scale.set(1, len, 1);
    }
    const add = (geo, m) => { const o = new T.Mesh(geo, m); root.add(o); return o; };
    const V = (x, y, z) => new T.Vector3(x, y, z);
    const grow = (rings, d) => rings.map(([t, rx, rz, cz]) => [t, rx + d, rz + d, cz]);

    // ---- Bike. Rear axle z +0.5, front -0.5, wheels 0.34 m. His right is +x.
    const R = 0.34, BB = V(0, 0.27, 0.09), REAR = V(0, R, 0.5), FRONT = V(0, R, -0.5);
    const SEAT = V(0, 0.93, 0.29), HEAD_TOP = V(0, 0.84, -0.36), HEAD_LOW = V(0, 0.68, -0.40), BAR = V(0, 0.88, -0.47);
    const wheels = [];
    for (const c of [REAR, FRONT]) {
      const w = new T.Group(); w.position.copy(c); root.add(w); wheels.push(w);
      const tyre = new T.Mesh(new T.TorusGeometry(R - 0.0125, 0.0125, 10, 48), M.tyre); tyre.rotation.y = Math.PI / 2; w.add(tyre);
      const rim = new T.Mesh(new T.TorusGeometry(R - 0.03, 0.009, 6, 48), M.rim); rim.rotation.y = Math.PI / 2; w.add(rim);
      const spokes = [];
      for (let k = 0; k < 24; k++) { // laced from both hub flanges to the rim
        const a = (k / 24) * Math.PI * 2, x = k % 2 ? 0.022 : -0.022;
        spokes.push(x, Math.cos(a + 0.2) * 0.03, Math.sin(a + 0.2) * 0.03, 0, Math.cos(a) * (R - 0.075), Math.sin(a) * (R - 0.075));
      }
      const sg = new T.BufferGeometry(); sg.setAttribute('position', new T.Float32BufferAttribute(spokes, 3));
      w.add(new T.LineSegments(sg, new T.LineBasicMaterial({ color: 0x2a2d33 })));
      const hub = new T.Mesh(new T.CylinderGeometry(0.02, 0.02, 0.1, 10), M.carbon); hub.rotation.z = Math.PI / 2; w.add(hub);
      for (const x of [-0.022, 0.022]) { const fl = new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 0.006, 14), M.steel); fl.rotation.z = Math.PI / 2; fl.position.x = x; w.add(fl); }
      const deep = new T.Mesh(new T.CylinderGeometry(R - 0.035, R - 0.035, 0.024, 48, 1, true), M.carbon); deep.rotation.z = Math.PI / 2; w.add(deep); // 45 mm carbon rim
      const inner = new T.Mesh(new T.TorusGeometry(R - 0.072, 0.009, 6, 48), M.carbon); inner.rotation.y = Math.PI / 2; w.add(inner);
      for (const x of [-0.0125, 0.0125]) { const side = new T.Mesh(new T.RingGeometry(R - 0.075, R - 0.035, 48), M.carbon); side.rotation.y = Math.PI / 2; side.position.x = x; if (x < 0) side.rotation.y = -Math.PI / 2; w.add(side); }
      // Disc rotor and its calliper on his left.
      const rotor = new T.Mesh(new T.RingGeometry(0.045, 0.078, 24), M.steel); rotor.rotation.y = -Math.PI / 2; rotor.position.x = -0.045; rotor.material.side = T.DoubleSide; w.add(rotor);
    }
    for (const c of [REAR, FRONT]) { const cal = add(new T.BoxGeometry(0.03, 0.05, 0.06), M.dark); cal.position.copy(c).add(V(-0.048, c === REAR ? 0.05 : 0.05, c === REAR ? -0.04 : 0.04)); }
    const tube = (a, b, r, m = M.frame) => limb(add(unitCyl(r, r, 10), m), a, b);
    // Aero tubes: deeper than wide, so they read flat from behind.
    const aero = (a, b, w, d, m = M.frame) => { const o = add(loft([[0, w, d], [1, w, d]], 12), m); orient(o, a, b, V(0, 0, -1)); };
    aero(BB, SEAT.clone().lerp(BB, 0.1), 0.016, 0.024);       // seat tube
    aero(SEAT.clone().lerp(BB, 0.12), HEAD_TOP, 0.015, 0.02); // top tube
    aero(BB, HEAD_LOW, 0.02, 0.03);                           // down tube
    tube(HEAD_LOW.clone().addScaledVector(HEAD_TOP.clone().sub(HEAD_LOW), -0.08), HEAD_TOP.clone().addScaledVector(HEAD_TOP.clone().sub(HEAD_LOW), 0.12), 0.023); // head tube
    for (const x of [-0.05, 0.05]) {
      tube(BB.clone().setX(x * 0.6), REAR.clone().setX(x), 0.011);                       // chainstays
      tube(SEAT.clone().lerp(BB, 0.2).setX(x * 0.4), REAR.clone().setX(x), 0.009);      // seatstays, dropped
      aero(HEAD_LOW.clone().setX(x * 0.4), FRONT.clone().setX(x), 0.009, 0.016);          // fork
    }
    tube(HEAD_TOP.clone().add(V(0, 0.02, 0)), BAR, 0.016, M.dark); // stem
    tube(HEAD_TOP, HEAD_TOP.clone().add(V(0, 0.03, -0.005)), 0.02, M.dark); // headset spacers
    tube(V(-0.21, 0.88, -0.47), V(0.21, 0.88, -0.47), 0.013, M.tape); // bars, taped
    for (const x of [-0.2, 0.2]) {
      tube(V(x, 0.88, -0.47), V(x, 0.875, -0.55), 0.013, M.tape);      // round to the hoods
      tube(V(x, 0.875, -0.55), V(x, 0.80, -0.565), 0.013, M.tape);     // the drops
      tube(V(x, 0.80, -0.565), V(x, 0.745, -0.53), 0.013, M.tape);
      tube(V(x, 0.745, -0.53), V(x, 0.74, -0.47), 0.013, M.tape);
      const hood = add(loft([[-0.1, 0.012, 0.012], [0, 0.017, 0.02], [0.5, 0.018, 0.022, 0.004], [0.9, 0.015, 0.02, 0.006], [1.05, 0.008, 0.01, 0.004]], 12), M.dark);
      orient(hood, V(x, 0.885, -0.5), V(x, 0.9, -0.59), V(0, 1, 0)); // brake hood
      tube(V(x, 0.89, -0.585), V(x, 0.79, -0.585), 0.007, M.dark);    // lever
    }
    // A bottle in its cage on the down tube.
    const bAt = BB.clone().lerp(HEAD_LOW, 0.42), bDir = HEAD_LOW.clone().sub(BB).normalize(), bUp = V(0, 1, 0).addScaledVector(bDir, -bDir.y).normalize();
    const bottle = add(new T.CylinderGeometry(0.034, 0.034, 0.2, 14), M.bottle); bottle.position.copy(bAt).addScaledVector(bUp, 0.048); bottle.quaternion.setFromUnitVectors(V(0, 1, 0), bDir);
    const cap = add(new T.CylinderGeometry(0.015, 0.022, 0.035, 10), M.cap); cap.position.copy(bottle.position).addScaledVector(bDir, 0.115); cap.quaternion.copy(bottle.quaternion);
    // Saddle: a broad back narrowing to the nose, on its rails.
    const saddle = add(loft([[-0.04, 0.03, 0.006], [0, 0.068, 0.012], [0.18, 0.072, 0.016], [0.4, 0.05, 0.015], [0.6, 0.026, 0.013], [0.9, 0.019, 0.012], [1.03, 0.008, 0.006]], 14), M.saddle);
    orient(saddle, SEAT.clone().add(V(0, 0.035, 0.13)), SEAT.clone().add(V(0, 0.04, -0.14)), V(0, 1, 0));
    tube(SEAT.clone().lerp(BB, 0.1), SEAT, 0.0135, M.carbon); // seat post
    // Drivetrain on his right: two rings on a spider, cassette, mech, chain.
    const RING = BB.clone().setX(0.055);
    for (const [r, x] of [[0.105, 0.058], [0.085, 0.05]]) { const ring = add(new T.TorusGeometry(r, 0.006, 6, 40), M.steel); ring.rotation.y = Math.PI / 2; ring.position.copy(BB).setX(x); }
    const spider = add(new T.CylinderGeometry(0.075, 0.075, 0.008, 5), M.carbon); spider.rotation.z = Math.PI / 2; spider.position.copy(RING);
    for (let k = 0; k < 7; k++) { const cog = add(new T.CylinderGeometry(0.055 - k * 0.0045, 0.055 - k * 0.0045, 0.003, 20), M.steel); cog.rotation.z = Math.PI / 2; cog.position.copy(REAR).setX(0.03 + k * 0.0045); }
    const mech = add(new T.BoxGeometry(0.014, 0.075, 0.03), M.dark); mech.position.copy(REAR).add(V(0.06, -0.06, 0.015)); mech.rotation.x = 0.25;
    for (const dy of [-0.025, -0.09]) { const jw = add(new T.CylinderGeometry(0.013, 0.013, 0.008, 12), M.dark); jw.rotation.z = Math.PI / 2; jw.position.copy(REAR).add(V(0.055, dy, dy * 0.15)); }
    tube(RING.clone().add(V(0, 0.105, 0)), REAR.clone().add(V(0.055, 0.05, 0)), 0.0035, M.chain); // top run
    tube(RING.clone().add(V(0, -0.105, 0)), REAR.clone().add(V(0.055, -0.09, -0.013)), 0.0035, M.chain); // bottom run to the jockey wheel
    tube(REAR.clone().add(V(0.055, -0.09, -0.013)), REAR.clone().add(V(0.055, -0.025, -0.004)), 0.0035, M.chain);
    const cranks = [0, 1].map(() => add(loft([[-0.12, 0.012, 0.01], [0, 0.016, 0.012], [0.5, 0.012, 0.01], [1, 0.011, 0.01], [1.1, 0.008, 0.008]], 10), M.carbon));
    const pedals = [0, 1].map(() => add(new T.BoxGeometry(0.075, 0.014, 0.085), M.dark));

    const builtBike = root.children.slice(); // hidden when a bike model is loaded
    // A bike model of his own (glTF, rigged with wheel, chainring and pedal
    // bones, as Sketchfab's often are): set in place of the built bike, sized
    // so its wheels fall on ours, and its bones turned by pose().
    let own = null;
    const XA = V(1, 0, 0), q1 = new T.Quaternion();
    function useBike(model) {
      if (own) { root.remove(own.holder); own = null; }
      for (const o of builtBike) o.visible = !model;
      if (!model) return;
      const holder = new T.Group(); holder.add(model); root.add(holder);
      holder.updateMatrixWorld(true);
      const find = re => { let b = null; model.traverse(o => { if (!b && o.isBone && re.test(o.name)) b = o; }); return b; };
      const B = { rear: find(/back.?wheel|rear.?wheel/i), front: find(/front.?wheel/i), ring: find(/chain.?ring|crank/i), right: find(/right.?ped/i), left: find(/left.?ped/i) };
      if (!B.rear || !B.front) throw new Error('This model has no wheel bones, so its wheels could not turn.');
      // Which way it faces, from its wheels, and how big it is.
      const at = b => root.worldToLocal(b.getWorldPosition(new T.Vector3())); // in the rider's own frame
      const r = at(B.rear), f = at(B.front), along = f.clone().sub(r).setY(0);
      const scale = (FRONT.z - REAR.z) / -along.length();
      holder.rotation.y = Math.atan2(along.x, along.z); // its front to our -z
      holder.scale.setScalar(scale);
      holder.updateMatrixWorld(true);
      const r2 = at(B.rear);
      holder.position.set(-r2.x, REAR.y - r2.y, REAR.z - r2.z);
      holder.updateMatrixWorld(true);
      model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
      // Where its saddle and hoods are: the highest points over the seat post
      // and out on the bars, so the rider sits on the one and holds the other.
      let seatY = -1, hood = null; const v = new T.Vector3();
      model.traverse(o => {
        if (!o.isMesh) return;
        const pos = o.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 60000));
        for (let i = 0; i < pos.count; i += step) {
          v.fromBufferAttribute(pos, i); if (o.isSkinnedMesh) o.boneTransform(i, v); // r149 skins the vector it is given
          root.worldToLocal(v.applyMatrix4(o.matrixWorld));
          if (Math.abs(v.x) < 0.06 && v.z > 0.15 && v.z < 0.45) seatY = Math.max(seatY, v.y);
          if (Math.abs(v.x) > 0.12 && Math.abs(v.x) < 0.3 && v.z < -0.38 && v.z > -0.75 && (!hood || v.y > hood.y)) hood = v.clone();
        }
      });
      // Each moving bone turns about our x axis, seen from its parent.
      const spin = b => {
        if (!b) return null;
        const pq = b.parent.getWorldQuaternion(new T.Quaternion()).premultiply(root.getWorldQuaternion(new T.Quaternion()).invert());
        return { b, q0: b.quaternion.clone(), axis: XA.clone().applyQuaternion(pq.invert()) };
      };
      own = { holder, rear: spin(B.rear), front: spin(B.front), ring: spin(B.ring), pedals: [spin(B.left), spin(B.right)], wheel: 0,
        lift: seatY > 0.75 && seatY < 1.1 ? seatY - SEAT.y - 0.005 : 0, hood: hood && hood.y > 0.8 && hood.y < 1.15 ? hood : V(0.21, 0.945, -0.53) };
      if (B.ring && B.right) { // the cranks: centre, length, and the right one's angle as it was modelled
        const c = at(B.ring), pr = at(B.right), pl = B.left ? at(B.left) : pr.clone().setX(-pr.x);
        own.bb = c; own.crank = Math.hypot(pr.y - c.y, pr.z - c.z); own.a0 = Math.atan2(-(pr.z - c.z), pr.y - c.y);
        own.px = [pl.x, pr.x];
      }
    }
    const turn = (j, angle) => { if (j) j.b.quaternion.copy(q1.setFromAxisAngle(j.axis, angle)).multiply(j.q0); };

    // ---- Rider. Lengths in metres for a 1.80 m rider.
    const riderFrom = root.children.length; // the built rider's parts follow
    const THIGH = 0.45, SHIN = 0.44, UPPER = 0.29, FORE = 0.27, FOOT = 0.28;
    // Cross-sections, measured off photos of riders: quads in front of the
    // thigh, the calf high at the back of the shin, a narrow ankle.
    const THIGH_R = [[-0.1, 0.07, 0.07], [0, 0.088, 0.088], [0.2, 0.086, 0.085, 0.006], [0.45, 0.077, 0.075, 0.01], [0.7, 0.063, 0.06, 0.006], [0.88, 0.052, 0.05], [1, 0.048, 0.046], [1.07, 0.034, 0.034]];
    const SHIN_R = [[-0.07, 0.04, 0.04], [0, 0.049, 0.049], [0.1, 0.05, 0.055, -0.006], [0.25, 0.05, 0.062, -0.017], [0.4, 0.046, 0.057, -0.015], [0.6, 0.036, 0.04, -0.006], [0.8, 0.028, 0.03, -0.002], [0.95, 0.026, 0.028], [1.04, 0.026, 0.03], [1.08, 0.016, 0.016]];
    const legs = [-1, 1].map(() => ({
      thigh: add(loft(THIGH_R), M.skin),
      short: add(loft([...grow(THIGH_R.filter(r => r[0] <= 0.7), 0.004), [0.76, 0.064, 0.062, 0.005], [0.77, 0.03, 0.03]]), M.bib),
      band: add(loft([[0.68, 0.068, 0.066, 0.006], [0.76, 0.065, 0.063, 0.005], [0.765, 0.03, 0.03]]), M.jersey2), // leg gripper
      shin: add(loft(SHIN_R), M.skin),
      sock: add(loft([[0.66, 0.035, 0.037, -0.003], [0.8, 0.032, 0.034, -0.002], [0.95, 0.03, 0.032], [1.04, 0.03, 0.034], [1.1, 0.015, 0.015]]), M.sock),
      knee: add(new T.SphereGeometry(0.045, 12, 8), M.skin),
      // Shoe along the foot from heel to toe, upper white, sole dark.
      shoe: add(loft([[0, 0.022, 0.028, 0.025], [0.05, 0.035, 0.045, 0.032], [0.2, 0.041, 0.05, 0.036], [0.4, 0.044, 0.04, 0.026], [0.6, 0.047, 0.031, 0.019], [0.8, 0.042, 0.025, 0.012], [0.93, 0.032, 0.018, 0.008], [1, 0.012, 0.01, 0.006]], 16), M.shoe),
      sole: add(loft([[0, 0.02, 0.008, -0.002], [0.05, 0.034, 0.01, -0.004], [0.5, 0.045, 0.008, -0.007], [0.9, 0.035, 0.008, -0.005], [1, 0.012, 0.006, -0.002]], 14), M.sole),
      strap: add(new T.BoxGeometry(0.095, 0.012, 0.03), M.sole),
    }));
    const arms = [-1, 1].map(() => ({
      upper: add(loft([[-0.1, 0.05, 0.05], [0, 0.056, 0.056], [0.3, 0.05, 0.049], [0.7, 0.043, 0.041], [1, 0.037, 0.035], [1.09, 0.025, 0.025]]), M.skin),
      sleeve: add(loft([[-0.2, 0.03, 0.03], [-0.16, 0.055, 0.056], [-0.08, 0.065, 0.066], [0, 0.063, 0.063], [0.3, 0.056, 0.055], [0.52, 0.053, 0.052], [0.56, 0.045, 0.045]]), M.jersey),
      cuff: add(loft([[0.46, 0.0545, 0.0535], [0.54, 0.054, 0.053], [0.55, 0.04, 0.04]]), M.cuff),
      fore: add(loft([[-0.08, 0.03, 0.03], [0, 0.037, 0.034], [0.25, 0.04, 0.034], [0.6, 0.032, 0.026], [0.95, 0.024, 0.019], [1.03, 0.02, 0.017]]), M.skin),
      hand: add(loft([[-0.05, 0.02, 0.018], [0.05, 0.026, 0.02], [0.35, 0.04, 0.024, 0.004], [0.7, 0.042, 0.022, 0.002], [0.92, 0.034, 0.018], [1.0, 0.012, 0.01]], 14), M.glove),
      thumb: add(loft([[0, 0.012, 0.012], [0.6, 0.011, 0.01], [1.05, 0.006, 0.006]], 8), M.glove),
    }));
    // Torso from the hips (t=0) to the base of the neck (t=1), with the
    // bib shorts, glutes and pelvis below: narrow waist, broad chest, a back
    // that rounds over the bars, shoulder blades.
    const torso = add(loft([
      [-0.27, 0.06, 0.05, 0.0], [-0.23, 0.125, 0.105, -0.01], [-0.15, 0.162, 0.128, -0.02], [-0.06, 0.168, 0.125, -0.012],
      [0, 0.163, 0.118, -0.004], [0.1, 0.158, 0.114, 0], [0.25, 0.15, 0.11, 0.002], [0.45, 0.158, 0.118, -0.008],
      [0.62, 0.178, 0.125, -0.018], [0.78, 0.193, 0.12, -0.024], [0.9, 0.198, 0.104, -0.02], [0.98, 0.168, 0.084, -0.01],
      [1.04, 0.1, 0.06, 0.0], [1.07, 0.048, 0.045, 0.006],
    ], 24), M.jerseyKit);
    const neck = add(loft([[-0.1, 0.05, 0.05], [0, 0.05, 0.052], [0.6, 0.046, 0.048], [1, 0.05, 0.05], [1.1, 0.03, 0.03]], 12), M.skin);
    // Head: a sphere drawn narrower at the temples and in at the jaw, with ears.
    const headGeo = new T.SphereGeometry(1, 24, 16), hp = headGeo.attributes.position;
    for (let i = 0; i < hp.count; i++) {
      let x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
      if (y < 0) { x *= 1 - 0.28 * -y; z *= 1 - (z > 0 ? 0.35 : 0.12) * -y; } // jaw and chin in, the back of the skull rounds off
      if (z < -0.7 && Math.abs(x) < 0.25 && y > -0.35 && y < 0.1) z -= 0.12 * (1 - Math.abs(x) / 0.25); // nose
      hp.setXYZ(i, x * 0.076, y * 0.112, z * 0.098);
    }
    headGeo.computeVertexNormals();
    // Everything on the head moves with it, as one group.
    const headG = new T.Group(); root.add(headG);
    const hadd = (geo, m, x = 0, y = 0, z = 0) => { const o = new T.Mesh(geo, m); o.position.set(x, y, z); headG.add(o); return o; };
    hadd(headGeo, M.skin);
    for (const x of [-0.075, 0.075]) hadd(new T.SphereGeometry(0.03, 8, 6), M.skin, x, -0.005, 0.01).scale.set(0.35, 1, 0.65); // ears
    const hair = hadd(new T.SphereGeometry(0.08, 14, 8, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.35), M.hair, 0, -0.005, 0.02); hair.scale.set(0.95, 0.9, 1.05); hair.rotation.x = 0.5;
    // Helmet: a shell longer at the back, its tail dropping, with straps.
    const helGeo = new T.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.56), gp = helGeo.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      const x = gp.getX(i), y = gp.getY(i), z = gp.getZ(i);
      gp.setXYZ(i, x * 0.097, y * 0.09 - (z > 0 ? 0.25 * z * z * (1 - y) : 0) * 0.1, z * (z > 0 ? 0.142 : 0.122));
    }
    helGeo.computeVertexNormals();
    const helmet = hadd(helGeo, M.helmetKit, 0, 0.028, 0.01); helmet.rotation.x = -0.12;
    for (const x of [-0.072, 0.072]) { // straps, in front of and behind the ear to the chin
      const chin = V(x * 0.4, -0.1, -0.06);
      for (const z of [0.035, -0.03]) limb(hadd(unitCyl(0.004, 0.004, 4), M.dark), V(x, 0.03, z), chin);
    }
    // Wraparound sunglasses: a dark shiny band round the front of the face.
    const glasses = hadd(new T.TorusGeometry(0.1, 0.011, 6, 20, Math.PI * 0.7), M.lens, 0, 0.005, -0.008); glasses.scale.set(0.8, 1, 1.02); glasses.rotation.set(Math.PI / 2, 0, -Math.PI * 0.85);

    // The real body (vendor/rider.js: MakeHuman's CC0 human, skinned to 19
    // bones, kit painted on). When it is there it replaces the built one and
    // keeps only the built helmet and glasses, which ride on its head.
    const real = window.IW_RIDER ? realBody(window.IW_RIDER) : null;
    function realBody(D) {
      const dec = (str, A) => { const b = atob(str), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new A(u.buffer); };
      // Decoded once and shared by every rider (race rivals too): each has
      // its own bones, the shape is the same.
      const g = D.geo || (D.geo = new T.BufferGeometry());
      if (!g.index) {
      g.setAttribute('position', new T.BufferAttribute(Float32Array.from(dec(D.pos, Int16Array), x => x / 10000), 3));
      g.setAttribute('normal', new T.BufferAttribute(Float32Array.from(dec(D.nrm, Int8Array), x => x / 127), 3));
      g.setAttribute('uv', new T.BufferAttribute(Float32Array.from(dec(D.uv, Uint16Array), x => x / 65535), 2));
      g.setAttribute('skinIndex', new T.Uint16BufferAttribute(Uint16Array.from(dec(D.si, Uint8Array)), 4));
      g.setAttribute('skinWeight', new T.BufferAttribute(Float32Array.from(dec(D.sw, Uint8Array), x => x / 255), 4));
      g.setIndex(new T.BufferAttribute(dec(D.idx, Uint16Array), 1));
      }
      const tex = D.texture || (D.texture = new T.TextureLoader().load(D.tex)); tex.anisotropy = 4;
      const mesh = new T.SkinnedMesh(g, new T.MeshStandardMaterial({ map: tex, roughness: 0.66 }));
      if (kit) recolor(D.tex, kit[0], mesh.material); // a rival's kit
      mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false; // skinned: its box is the rest pose's
      const B = {}, frame = (q, ax, ref) => { // a bone's turn: +y along it, +z its reference side
        by.copy(ax).normalize(); bz.copy(ref).addScaledVector(by, -ref.dot(by)).normalize(); bx.crossVectors(by, bz);
        return q.setFromRotationMatrix(basis.makeBasis(bx, by, bz));
      };
      const bones = D.bones.map(d => {
        const b = new T.Bone(), h = V(...d.h), t = V(...d.t), r = V(...d.r);
        b.position.copy(h); frame(b.quaternion, t.clone().sub(h), r);
        B[d.name] = { b, h, t, r, len: t.distanceTo(h), q0: b.quaternion.clone() };
        mesh.add(b); return b;
      });
      root.add(mesh); mesh.updateMatrixWorld(true);
      mesh.bind(new T.Skeleton(bones));
      const set = (n, head, ax, ref) => { const o = B[n]; o.b.position.copy(head); frame(o.b.quaternion, ax, ref); };
      // A point carried rigidly by bone n from its rest place.
      const carry = (n, p, out = V()) => { const o = B[n]; return out.copy(p).sub(o.h).applyQuaternion(tmpQ.copy(o.b.quaternion).multiply(o.q0.clone().invert())).add(o.b.position); };
      const restDir = n => B[n].t.clone().sub(B[n].h);
      const H0 = B.thighL.h.clone().add(B.thighR.h).multiplyScalar(0.5); // between the hip joints
      const sh0 = [B.upperL.h, B.upperR.h], thumb0 = { L: B.fore2L.r.clone(), R: B.fore2R.r.clone() };
      const ball = D.ball.map(b => V(b[0], D.sole, b[2])); // under the balls of the feet
      const ARM = B.upperL.len + B.fore1L.len + B.fore2L.len;
      const skull = V(0, D.skull.top - 0.105, D.skull.c[2]); // where the built head's centre was
      const rot = (axis, a) => new T.Quaternion().setFromAxisAngle(axis, a), XAX = V(1, 0, 0);
      const CURL = [[0.25, 0.45, 0.35], [0.8, 1.0, 0.6]], CURL_SIGN = 1; // thumb; fingers (radians per joint)
      return {
        mesh, B,
        // hip: between the hip joints; pd/toe: pedal points and foot angles;
        // wrist/hand: where the wrists go and which way the hands point.
        pose(hip, tilt, pd, toe, wrist, hand) {
          const qp = rot(XAX, -tilt);
          const at = p => p.clone().sub(H0).applyQuaternion(qp).add(hip);
          set('hips', at(B.hips.h), restDir('hips').applyQuaternion(qp), FWD);
          // Torso: lean it until the hands reach the hoods with the elbows a
          // little bent, the back rounded over the bars.
          const s0 = at(B.hips.t), bend = 0.2;
          let lo = 0.1, hi = 1.4, a = 0.7;
          const place = a => {
            const d1 = V(0, Math.sin(a + bend), -Math.cos(a + bend)), s1 = s0.clone().addScaledVector(d1, B.spineLow.len);
            const d2 = V(0, Math.sin(a - bend * 0.6), -Math.cos(a - bend * 0.6));
            set('spineLow', s0, d1, FWD); set('chest', s1, d2, FWD);
            return s1;
          };
          for (let i = 0; i < 14; i++) {
            a = (lo + hi) / 2; place(a);
            const sh = carry('chest', sh0[1]);
            if (sh.distanceTo(wrist[1]) > ARM * 0.84) hi = a; else lo = a; // elbows bent
          }
          const s1 = place(a), n0 = s1.clone().add(V(0, Math.sin(a - bend * 0.6), -Math.cos(a - bend * 0.6)).multiplyScalar(B.chest.len));
          // Neck forward and up; the head lifted to look up the road.
          const nd = V(0, 0.62, -0.78), n1 = n0.clone().addScaledVector(nd, B.neck.len);
          set('neck', n0, nd, FWD);
          set('head', n1, V(0, 0.98, -0.2), V(0, 0.04, -1));
          [0, 1].forEach(k => {
            const sd = k ? 'R' : 'L', sgn = k ? 1 : -1;
            // Foot: the ball over the pedal, turned by the ankling angle.
            const qf = rot(XAX, -toe[k]);
            const ank = B['foot' + sd].h.clone().sub(ball[k]).applyQuaternion(qf).add(pd[k]);
            const hj = at(B['thigh' + sd].h), pole = V(sgn * 0.1, 0.3, -1).normalize();
            const knee = ik(hj, ank, B.thighL.len, B.shinL.len, pole, V());
            set('thigh' + sd, hj, knee.clone().sub(hj), pole);
            set('shin' + sd, knee, ank.clone().sub(knee), pole);
            set('foot' + sd, ank, restDir('foot' + sd).applyQuaternion(qf), V(0, 1, 0).applyQuaternion(qf));
            // Arm: shoulder -> elbow -> wrist; the forearm turns the hand thumb-up.
            const sh = carry('chest', sh0[k]), w = wrist[k];
            const elbow = ik(sh, w, B.upperL.len, B.fore1L.len + B.fore2L.len, V(sgn * 0.35, -0.3, 0.9).normalize(), V());
            const ua = elbow.clone().sub(sh), inside = w.clone().sub(sh);
            set('upper' + sd, sh, ua, inside);
            const fa = w.clone().sub(elbow), U = B['upper' + sd];
            const still = thumb0[sd].clone().applyQuaternion(tmpQ.copy(U.b.quaternion).multiply(U.q0.clone().invert())); // no twist
            const thumbUp = V(-sgn * 0.35, 1, -0.1);
            set('fore1' + sd, elbow, fa, still.clone().add(thumbUp.clone().normalize()));
            set('fore2' + sd, elbow.clone().addScaledVector(fa, B.fore1L.len / (B.fore1L.len + B.fore2L.len)), fa, still.clone().multiplyScalar(0.3).add(thumbUp.clone().normalize()));
            set('hand' + sd, w, hand[k], thumbUp);
            // Fingers curl round the hood, the thumb round its inside.
            const H = B['hand' + sd], dq = H.b.quaternion.clone().multiply(H.q0.clone().invert());
            const across = H.r.clone().applyQuaternion(dq).normalize();
            for (let f = 1; f <= 5; f++) {
              let p = carry('hand' + sd, B[`fing${f}1${sd}`].h), ang = 0;
              for (let g = 1; g <= 3; g++) {
                const o = B[`fing${f}${g}${sd}`]; ang += CURL[f === 1 ? 0 : 1][g - 1];
                const q = rot(across, ang * sgn * CURL_SIGN).multiply(dq), d = o.t.clone().sub(o.h).applyQuaternion(q);
                set(`fing${f}${g}${sd}`, p, d, o.r.clone().applyQuaternion(q));
                p = p.clone().add(d);
              }
            }
          });
          return carry('head', skull);
        },
      };
    }
    if (real) {
      const keep = new Set([headG, real.mesh, ...legs.flatMap(L => [L.shoe, L.sole, L.strap])]); // its feet are shaped to fit inside the built shoes
      for (const o of root.children.slice(riderFrom)) if (!keep.has(o)) o.visible = false;
      headG.children.forEach((o, i) => { o.visible = i === 4 || i === headG.children.length - 1; }); // only the helmet and glasses stay
    }

    // Two-bone IK: from a towards b with lengths l1, l2, bending towards `pole`.
    const ik = (a, b, l1, l2, pole, out) => {
      const d = tmpV.subVectors(b, a), dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, d.length()));
      const dir = d.normalize().clone(), along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
      const side = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
      return out.copy(a).addScaledVector(dir, along).addScaledVector(side, h);
    };
    const KNEE_POLE = V(0, 0.3, -1).normalize(), FWD = V(0, 0, -1);
    const hip = V(), j = V(), ank = V(), hand = V(), sh = V(), dir = V(), fup = V(), ball = V(), heel = V(), toe = V(), wrist = V(), tip = V();

    function pose(pedal, climb, roll) {
      for (const w of wheels) w.rotation.x -= roll;
      if (own) {
        own.wheel -= roll; turn(own.rear, own.wheel); turn(own.front, own.wheel);
        if (own.bb) turn(own.ring, -(pedal + Math.PI - own.a0));
      }
      // Seated hips on the saddle; standing, they rise and come forward over
      // the cranks. Seated, the hips rock a little with each stroke.
      const rock = Math.sin(pedal) * 0.006 * (1 - climb);
      const up = own ? own.lift : 0;
      const hipC = V(rock, 1.0 + up + 0.13 * climb, 0.27 - 0.2 * climb);
      const shC = V(-rock * 0.5, 1.37 + up + 0.1 * climb, -0.16 - 0.1 * climb);
      const spine = shC.clone().sub(hipC), chest = FWD.clone().addScaledVector(V(0, -1, 0), 0.3);
      orient(torso, hipC, shC, chest);
      const neckTop = shC.clone().add(V(0, 0.075, -0.075));
      orient(neck, shC.clone().addScaledVector(spine, -0.04), neckTop, FWD);
      // The head comes up to look down the road: the neck carries it forward.
      headG.position.copy(neckTop).add(V(0, 0.075, -0.045)); headG.rotation.x = 0.3; // looking up the road
      const rpd = [], rtoe = [], rwr = [], rhand = [];
      [0, 1].forEach(k => {
        const sgn = k ? 1 : -1, a = pedal + (k ? Math.PI : 0);
        // Crank and pedal.
        const cb = own?.bb || BB, cl = own?.bb ? own.crank : 0.17;
        const pd = V(own?.bb ? own.px[k] - Math.sign(own.px[k]) * 0.02 : sgn * 0.09, cb.y + Math.cos(a) * cl, cb.z - Math.sin(a) * cl);
        orient(cranks[k], BB.clone().setX(sgn * 0.075), pd.clone().setX(sgn * 0.08), V(1, 0, 0));
        pedals[k].position.copy(pd).setX(sgn * 0.11);
        // Foot: the ball over the pedal, the toe dropping as it comes round
        // the bottom and back up (ankling), flattest pushing over the top.
        const toeDown = 0.33 - 0.18 * Math.sin(a);
        dir.set(0, -Math.sin(toeDown), -Math.cos(toeDown)); fup.set(0, Math.cos(toeDown), -Math.sin(toeDown));
        pedals[k].rotation.x = toeDown;
        rpd[k] = pd.clone().setX(sgn * 0.1).add(V(0, 0.012, 0)); rtoe[k] = toeDown; // shoe sole on the pedal
        if (own?.bb) turn(own.pedals[k], pedal + Math.PI - own.a0 - toeDown); // the pedal stays under the shoe
        ball.copy(pd).setX(sgn * 0.1).addScaledVector(fup, 0.02);
        heel.copy(ball).addScaledVector(dir, real ? -0.215 : -0.68 * FOOT); toe.copy(ball).addScaledVector(dir, real ? 0.085 : 0.32 * FOOT); // the real body's feet are longer
        ank.copy(heel).addScaledVector(dir, 0.2 * FOOT).addScaledVector(fup, 0.085);
        const L = legs[k];
        orient(L.shoe, heel, toe, fup); orient(L.sole, heel, toe, fup);
        L.strap.position.copy(heel).addScaledVector(dir, 0.55 * FOOT).addScaledVector(fup, 0.05); L.strap.rotation.x = toeDown + 0.2;
        // Leg: hip -> knee -> ankle, the knee a little out over the top tube.
        hip.copy(hipC).setX(sgn * 0.095 + rock);
        ik(hip, ank, THIGH, SHIN, KNEE_POLE.clone().setX(sgn * 0.08).normalize(), j);
        const knee = KNEE_POLE.clone().setX(sgn * 0.08).normalize();
        orient(L.thigh, hip, j, knee); orient(L.short, hip, j, knee); orient(L.band, hip, j, knee);
        L.knee.position.copy(j).addScaledVector(knee, 0.018);
        orient(L.shin, j, ank, knee); orient(L.sock, j, ank, knee);
        // Arm: shoulder -> elbow -> wrist, hands over the hoods.
        sh.copy(hipC).addScaledVector(spine, 0.9).add(V(sgn * 0.175, -0.01, 0.0));
        if (own) wrist.set(sgn * Math.abs(own.hood.x) * 0.92, own.hood.y + 0.005, own.hood.z + 0.045); else wrist.set(sgn * 0.2, 0.935, -0.475);
        const A = arms[k], elbowPole = V(sgn * 0.6, -0.2, 0.8).normalize();
        ik(sh, wrist, UPPER, FORE, elbowPole, j);
        const armFwd = V(0, -0.4, -1);
        orient(A.upper, sh, j, armFwd); orient(A.sleeve, sh, j, armFwd); orient(A.cuff, sh, j, armFwd);
        orient(A.fore, j, wrist, armFwd);
        if (own) hand.set(wrist.x, wrist.y - 0.03, wrist.z - 0.11); else hand.set(sgn * 0.2, 0.9, -0.6);
        orient(A.hand, wrist, hand, V(0, 1, 0.3));
        if (real) { // the palm on top of the hood, the fingers round its front
          const hd = own ? own.hood : V(0.2, 0.9, -0.53);
          rwr[k] = V(sgn * Math.abs(hd.x) * 0.95, hd.y + 0.03, hd.z + 0.075); rhand[k] = V(-sgn * 0.04, -0.42, -1);
        }
        tip.copy(wrist).add(V(-sgn * 0.035, -0.02, -0.06));
        orient(A.thumb, wrist.clone().add(V(-sgn * 0.02, -0.005, -0.02)), tip, V(0, 1, 0));
      });
      if (real) { // the real body, from the same pedals and hoods
        const c = real.pose(hipC, 0.95 - 0.35 * climb, rpd, rtoe, rwr, rhand);
        headG.position.copy(c); headG.quaternion.copy(real.B.head.b.quaternion).multiply(real.B.head.q0.clone().invert());
      }
    }
    pose(0, 0, 0);
    return { root, pose, useBike, get bikeOn() { return !!own; } };
  }

  const VIEWS = {
    chase: { back: 7, ahead: 14, up: 2.6, look: 1.1, side: 0 },
    close: { back: 3.2, ahead: 6, up: 1.55, look: 1.0, side: 0 },
    side: { back: -0.6, ahead: 0.4, up: 1.0, look: 0.9, side: 3.6 },
    free: { back: 7, ahead: 14, up: 2.6, look: 1.1, side: 0 }, // moved by hand (see orbit in mount)
  };

  // Weather presets: how much of the photographed sky shows, the sun and
  // sky light, fog density and its colour (null: the photo's own haze).
  const WEATHER = {
    // On real land in clear or cloudy weather the near haze is thin (realFog)
    // and the distant mountains show, fading out over `far` metres.
    clear: { sky: 1, sun: 1.1, hemi: 0.62, fog: 0.0023, haze: null, shadow: true, realFog: 0.00025, far: 65000 },
    cloudy: { sky: 0.35, sun: 0.35, hemi: 0.95, fog: 0.003, haze: 0xa3a8b0, shadow: false, realFog: 0.0005, far: 22000 },
    rain: { sky: 0.15, sun: 0.2, hemi: 0.8, fog: 0.0065, haze: 0x868c94, shadow: false, fall: 'rain', wet: true },
    fog: { sky: 0, sun: 0.2, hemi: 1, fog: 0.02, haze: 0xbcc0c4, shadow: false },
    snow: { sky: 0.1, sun: 0.3, hemi: 1, fog: 0.009, haze: 0xc6cbd2, shadow: false, fall: 'snow', cover: 0.8 },
  };
  // Rain streaks or snowflakes in a 50 m box that travels with the camera:
  // each drop falls, drifts, and when it leaves the box comes back in at the
  // other side, so the box always looks full wherever the rider is.
  function flake() { // a soft round dot
    const cv = document.createElement('canvas'); cv.width = cv.height = 32;
    const cx = cv.getContext('2d'), g = cx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.8)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = g; cx.fillRect(0, 0, 32, 32);
    return new T.CanvasTexture(cv);
  }
  function falling(kind) {
    const rain = kind === 'rain', N = rain ? 3500 : 4000, B = 50, H = 24, rand = rng(rain ? 71 : 73);
    const p = new Float32Array(N * 3), speed = new Float32Array(N);
    for (let k = 0; k < N; k++) { p[k * 3] = rand() * B; p[k * 3 + 1] = rand() * H; p[k * 3 + 2] = rand() * B; speed[k] = rain ? 9 + rand() * 3 : 0.8 + rand() * 0.6; }
    const geo = new T.BufferGeometry(), pos = new T.Float32BufferAttribute(new Float32Array(N * (rain ? 6 : 3)), 3);
    geo.setAttribute('position', pos);
    const obj = rain
      ? new T.LineSegments(geo, new T.LineBasicMaterial({ color: 0xc8d0da, transparent: true, opacity: 0.45, fog: false }))
      : new T.Points(geo, new T.PointsMaterial({ color: 0xffffff, size: 0.13, map: flake(), transparent: true, depthWrite: false, fog: false }));
    obj.frustumCulled = false;
    let t = 0;
    const wrap = (v, lo) => lo + ((((v - lo) % B) + B) % B);
    return {
      obj,
      step(dt, cam) {
        t += dt;
        const x0 = cam.x - B / 2, z0 = cam.z - B / 2, y0 = cam.y - H / 2, a = pos.array;
        for (let k = 0; k < N; k++) {
          const i = k * 3;
          p[i + 1] -= speed[k] * dt;
          if (!rain) { p[i] += Math.sin(t * 0.9 + k) * 0.3 * dt; p[i + 2] += Math.cos(t * 0.7 + k * 1.3) * 0.3 * dt; }
          if (p[i + 1] < 0) p[i + 1] += H;
          const x = wrap(p[i], x0), y = y0 + p[i + 1], z = wrap(p[i + 2], z0);
          if (rain) { const j = k * 6; a[j] = x; a[j + 1] = y; a[j + 2] = z; a[j + 3] = x + 0.05; a[j + 4] = y + 0.55; a[j + 5] = z + 0.02; }
          else { a[i] = x; a[i + 1] = y; a[i + 2] = z; }
        }
        pos.needsUpdate = true;
      },
    };
  }

  // A camera-like grade over the whole picture, the sky included so the haze
  // and the sky still meet: highlights roll off instead of clipping to flat
  // white, a gentle S-curve gives the land depth, the blacks lift a little
  // toward blue as a lens does, and mid-tone colour gets slightly richer.
  // Colours in this app are picked as display colours, so this works on
  // those rather than on physical light (which would mean re-picking all).
  T.ShaderChunk.tonemapping_pars_fragment = T.ShaderChunk.tonemapping_pars_fragment.replace(
    'vec3 CustomToneMapping( vec3 color ) { return color; }',
    `vec3 CustomToneMapping( vec3 color ) {
      color *= toneMappingExposure;
      vec3 hi = 0.78 + 0.22 * (1.0 - exp(-(color - 0.78) / 0.22));
      color = mix(color, hi, step(0.78, color));
      color = color + 0.22 * color * (1.0 - color) * (color - 0.42) * 2.2;
      float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(l), color, 1.0 + 0.16 * smoothstep(0.05, 0.4, l) * (1.0 - smoothstep(0.6, 0.95, l)));
      color += vec3(0.010, 0.013, 0.020) * (1.0 - l);
      return clamp(color, 0.0, 1.0);
    }`);

  // The video look: the frame goes through a camera before it reaches the
  // screen. Moving things smear as they do at a 1/50 s shutter (the rider,
  // who moves with the camera, stays sharp), bright sky and wet road glow,
  // the lens bends and fringes a little toward its edges and darkens its
  // corners, and the sensor adds a fine grain. The grade that used to be
  // the renderer's tone mapping happens here instead, after the blur.
  // Needs WebGL 2 (half-float targets with multisampling); without it the
  // view is drawn plain, as before.
  function lens(renderer) {
    if (!renderer.capabilities.isWebGL2) return null;
    const half = { type: T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter, depthBuffer: false };
    const main = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, samples: 4 });
    main.depthTexture = new T.DepthTexture(1, 1, T.UnsignedIntType);
    const mask = new T.WebGLRenderTarget(1, 1, { depthBuffer: true });
    const glowA = new T.WebGLRenderTarget(1, 1, half), glowB = new T.WebGLRenderTarget(1, 1, half);
    const quad = new T.Mesh(new T.PlaneGeometry(2, 2)), qScene = new T.Scene(), qCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quad.frustumCulled = false; qScene.add(quad);
    const maskScene = new T.Scene(); maskScene.overrideMaterial = new T.MeshBasicMaterial({ color: 0xffffff });
    const vert = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    const pass = (frag, uniforms) => new T.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
    // Glow: what is brighter than white, at a quarter of the size, blurred.
    const bright = pass(`uniform sampler2D src; uniform vec2 px; varying vec2 vUv;
      void main() {
        vec3 c = vec3(0.0);
        for (int i = 0; i < 4; i++) { vec2 o = vec2(i == 1 || i == 3 ? 1.0 : -1.0, i >= 2 ? 1.0 : -1.0) * px; c += texture2D(src, vUv + o).rgb; }
        c *= 0.25; float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor = vec4(c * smoothstep(0.82, 1.25, l), 1.0);
      }`, { src: { value: null }, px: { value: new T.Vector2() } });
    const blur = pass(`uniform sampler2D src; uniform vec2 dir; varying vec2 vUv;
      void main() {
        vec3 c = texture2D(src, vUv).rgb * 0.227;
        c += (texture2D(src, vUv + dir * 1.385).rgb + texture2D(src, vUv - dir * 1.385).rgb) * 0.316;
        c += (texture2D(src, vUv + dir * 3.231).rgb + texture2D(src, vUv - dir * 3.231).rgb) * 0.070;
        gl_FragColor = vec4(c, 1.0);
      }`, { src: { value: null }, dir: { value: new T.Vector2() } });
    const final = pass(`uniform sampler2D src; uniform sampler2D depth; uniform sampler2D rider; uniform sampler2D glow;
      uniform mat4 invViewProj; uniform mat4 prevViewProj; uniform vec3 eye; uniform float shutter; uniform float seed; uniform vec2 px;
      varying vec2 vUv;
      vec3 grade(vec3 color) {
        vec3 hi = 0.78 + 0.22 * (1.0 - exp(-(color - 0.78) / 0.22));
        color = mix(color, hi, step(0.78, color));
        color = clamp(color, 0.0, 1.0);
        color = color + 0.22 * color * (1.0 - color) * (color - 0.42) * 2.2;
        float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color = mix(vec3(l), color, 1.0 + 0.16 * smoothstep(0.05, 0.4, l) * (1.0 - smoothstep(0.6, 0.95, l)));
        color += vec3(0.010, 0.013, 0.020) * (1.0 - l);
        return clamp(color, 0.0, 1.0);
      }
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
      void main() {
        // A slight barrel bend, zoomed in a touch so the corners stay filled.
        vec2 c = vUv - 0.5; float r2 = dot(c, c);
        vec2 uv = 0.5 + c * (1.0 + 0.045 * r2) / 1.012;
        // Where this pixel was a frame ago, from its depth and the camera's
        // last position: the smear runs between the two. The sky and the far
        // land (no depth here) move with the camera's turning only.
        float d = texture2D(depth, uv).x;
        vec4 w = invViewProj * vec4(uv * 2.0 - 1.0, min(d, 0.99999) * 2.0 - 1.0, 1.0); w /= w.w;
        if (d >= 1.0) w.xyz = eye + normalize(w.xyz - eye) * 1e5;
        vec4 p = prevViewProj * vec4(w.xyz, 1.0);
        vec2 v = (uv - (p.xy / p.w * 0.5 + 0.5)) * shutter;
        float vl = length(v); if (vl > 0.035) v *= 0.035 / vl;
        if (texture2D(rider, uv).r > 0.5) v = vec2(0.0);
        vec3 col = vec3(0.0); float n = 0.0;
        for (int i = 0; i < 9; i++) {
          vec2 q = uv + v * (float(i) / 8.0 - 0.5);
          float k = (i == 4 || texture2D(rider, q).r < 0.5) ? 1.0 : 0.0; // never smear the rider over the road
          col += texture2D(src, q).rgb * k; n += k;
        }
        col /= n;
        // Colour fringes toward the edges.
        vec2 ca = c * r2 * 0.012;
        col.r = mix(col.r, texture2D(src, uv + ca).r, smoothstep(0.04, 0.25, r2));
        col.b = mix(col.b, texture2D(src, uv - ca).b, smoothstep(0.04, 0.25, r2));
        col += texture2D(glow, uv).rgb * 0.35;
        col = grade(col);
        col *= 1.0 - 0.32 * pow(r2 * 2.0, 1.25);
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col += (hash(vUv / px) - 0.5) * 0.045 * (1.0 - abs(l - 0.45) * 1.4);
        gl_FragColor = vec4(col, 1.0);
      }`, {
      src: { value: main.texture }, depth: { value: main.depthTexture }, rider: { value: mask.texture }, glow: { value: glowA.texture },
      invViewProj: { value: new T.Matrix4() }, prevViewProj: { value: new T.Matrix4() }, eye: { value: new T.Vector3() },
      shutter: { value: 0 }, seed: { value: 0 }, px: { value: new T.Vector2() },
    });
    const vp = new T.Matrix4(), clear = new T.Color();
    let w = 0, h = 0, fresh = true;
    function run(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(qScene, qCam); }
    return {
      size(W, H) {
        const pr = renderer.getPixelRatio(); W = Math.round(W * pr); H = Math.round(H * pr);
        if (W === w && H === h) return;
        w = W; h = H;
        main.setSize(w, h); mask.setSize(w >> 1, h >> 1);
        glowA.setSize(w >> 2, h >> 2); glowB.setSize(w >> 2, h >> 2);
        final.uniforms.px.value.set(1 / w, 1 / h); bright.uniforms.px.value.set(1 / w, 1 / h);
      },
      // draw() renders the scenes into the lens's target; rider is the
      // object kept sharp; cut skips the smear for one frame (a jump).
      render(draw, camera, rider, dt, cut) {
        renderer.setRenderTarget(main);
        draw();
        // The rider's outline, so the smear leaves him out.
        const parent = rider.parent;
        maskScene.add(rider);
        renderer.getClearColor(clear); const alpha = renderer.getClearAlpha();
        renderer.setRenderTarget(mask); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(maskScene, camera);
        renderer.setClearColor(clear, alpha);
        parent.add(rider);
        bright.uniforms.src.value = main.texture; run(bright, glowA);
        for (let i = 0; i < 2; i++) {
          blur.uniforms.src.value = glowA.texture; blur.uniforms.dir.value.set(1.6 / (w >> 2), 0); run(blur, glowB);
          blur.uniforms.src.value = glowB.texture; blur.uniforms.dir.value.set(0, 1.6 / (h >> 2)); run(blur, glowA);
        }
        const u = final.uniforms;
        vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        u.invViewProj.value.copy(vp).invert();
        u.eye.value.setFromMatrixPosition(camera.matrixWorld);
        u.shutter.value = fresh || cut ? 0 : Math.min(1, (1 / 50) / Math.max(dt, 1e-3));
        u.seed.value = (u.seed.value + 7.31) % 1000;
        run(final, null);
        u.prevViewProj.value.copy(vp);
        fresh = false;
      },
      reset() { fresh = true; },
      dispose() { for (const t of [main, mask, glowA, glowB]) t.dispose(); main.depthTexture.dispose(); },
    };
  }

  // Google's map script, once, with the key. A key Google refuses shows up
  // as gm_authFailure, not as an error on the script.
  let googleLoad = null;
  function loadGoogle(key) {
    if (window.google?.maps?.importLibrary) return Promise.resolve();
    return googleLoad || (googleLoad = new Promise((res, rej) => {
      window.__iwGoogle = res;
      window.gm_authFailure = () => { // can come after the script has loaded
        const m = 'Google refused the key. Check that the Maps JavaScript API is enabled, billing is on, and the key allows this site.';
        googleLoad = null; rej(new Error(m)); window.__iwGoogleFail?.(m);
      };
      const sc = document.createElement('script');
      sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=beta&loading=async&callback=__iwGoogle`;
      sc.onerror = () => { googleLoad = null; rej(new Error('Google Maps could not be reached.')); };
      document.head.append(sc);
    }));
  }

  function mount(container, getState) {
    let renderer;
    try { renderer = new T.WebGLRenderer({ antialias: true, alpha: true }); } // see-through where Google 3D shows behind
    catch (e) { throw new Error('This browser cannot draw 3D here (WebGL is off).'); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.toneMapping = T.CustomToneMapping; renderer.toneMappingExposure = 1;
    container.prepend(renderer.domElement);
    const post = lens(renderer);
    let look = !!post;
    const scene = new T.Scene();
    // Two scenes, drawn one over the other each frame: far (the sky and, on
    // real land, the mountains out to 40 km) and then everything near. The
    // near camera stops at 700 m so the land there can be fine.
    const farScene = new T.Scene(), farCam = new T.PerspectiveCamera(62, 1, 150, 60000);
    renderer.autoClear = false;
    const photoDome = photoSky(renderer), haze = photoDome ? new T.Color().fromArray(window.IW_PHOTOS.haze) : new T.Color(HAZE);
    farScene.background = photoDome ? haze : new T.Color(SKY);
    farScene.fog = new T.Fog(haze, 0, 45000);
    // Haze that thickens with distance but never quite hides the land, so the
    // far edge of the land and the mountains behind it share one tone.
    scene.fog = new T.FogExp2(haze, 0.0023);
    const hemi = new T.HemisphereLight(photoDome ? 0xc9d3e2 : 0xd3e3f5, 0x56603f, 0.62); // ground light picks up the grass
    scene.add(hemi);
    // The sun casts shadows in a 70 m square that travels with the rider:
    // enough for him, the bike and the nearest trees, cheap to draw.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const sun = new T.DirectionalLight(0xffefd9, 1.1), SUN_DIR = photoDome ? photoDome.userData.sun : new T.Vector3(-0.5, 0.6, 0.4).normalize();
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 400 });
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    const dome = photoDome || sky(); farScene.add(dome);
    const camera = new T.PerspectiveCamera(62, 1, 0.2, FAR);
    const bike = rider(); scene.add(bike.root);
    bike.root.traverse(o => { if (o.isMesh) o.castShadow = true; });
    // Race rivals: a rider each, made the first time one comes into sight
    // (one a frame, they take a moment to build) and kept for the race.
    const rivalsOn = new Map(); // id -> { r: rider, disp, pedal, climb, tag }
    function nameTag(text) {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 48;
      const cx = cv.getContext('2d');
      cx.font = '600 26px "Segoe UI", Arial, sans-serif';
      const w = Math.min(248, cx.measureText(text).width + 24);
      cx.fillStyle = 'rgba(12,14,18,0.72)'; cx.beginPath(); cx.roundRect ? cx.roundRect((256 - w) / 2, 6, w, 36, 10) : cx.rect((256 - w) / 2, 6, w, 36); cx.fill();
      cx.fillStyle = '#f2f4f8'; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(text, 128, 25);
      const sp = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(cv), depthWrite: false, transparent: true }));
      sp.scale.set(1.6, 0.3, 1); sp.position.set(0, 2.15, 0); sp.renderOrder = 5;
      return sp;
    }
    // Only the nearest RIVALS_SHOWN within RIVALS_FAR are drawn; past 60 m
    // they are posed every third frame (too small to tell); none casts a
    // shadow (each would be drawn again for the sun).
    const RIVALS_SHOWN = 8, RIVALS_FAR = 250;
    let rivalTick = 0;
    function drawRivals(list, dt) {
      const seen = new Set();
      let made = false;
      rivalTick++;
      const near = (list || []).filter(o => Math.abs(o.d - disp) < RIVALS_FAR).sort((a, b) => Math.abs(a.d - disp) - Math.abs(b.d - disp)).slice(0, RIVALS_SHOWN);
      for (const o of near) {
        let e = rivalsOn.get(o.id);
        if (!e) {
          if (made) continue; // one new rider a frame
          made = true;
          const r = rider(o.kit); r.root.traverse(m => { if (m.isMesh) m.castShadow = false; });
          const tag = nameTag(o.name); r.root.add(tag);
          e = { r, disp: o.d, pedal: Math.random() * 6, climb: 0, tag, k: rivalsOn.size };
          rivalsOn.set(o.id, e); scene.add(r.root);
        }
        seen.add(o.id);
        e.r.root.visible = true;
        e.disp += o.speed * dt; e.disp += (o.d - e.disp) * Math.min(1, dt * 2.5);
        if (Math.abs(o.d - e.disp) > 50) e.disp = o.d;
        e.dt = (e.dt || 0) + dt;
        if (Math.abs(e.disp - disp) > 60 && (rivalTick + e.k) % 3) continue; // far: every third frame
        const edt = e.dt; e.dt = 0;
        const p = at(e.disp, new T.Vector3()), f = at(e.disp + 4, new T.Vector3()).sub(at(e.disp - 4, new T.Vector3()));
        const fl = Math.hypot(f.x, f.z) || 1, side = KEEP + o.lane;
        e.r.root.position.copy(p).add(new T.Vector3(-f.z / fl * side, 0, f.x / fl * side));
        e.r.root.rotation.set(0, Math.atan2(-f.x, -f.z), 0); e.r.root.rotateX(Math.atan2(f.y, fl));
        e.pedal += (o.cadence / 60) * Math.PI * 2 * edt;
        e.climb += ((o.standing ? 1 : 0) - e.climb) * Math.min(1, edt * 2);
        e.r.root.rotateZ(Math.sin(e.pedal) * 0.09 * e.climb);
        e.r.pose(e.pedal, e.climb, (o.speed / 0.34) * edt);
        e.tag.visible = camPos.distanceTo(e.r.root.position) < 60;
      }
      for (const [id, e] of rivalsOn) if (!seen.has(id)) e.r.root.visible = false;
      if (!list && rivalsOn.size) { // the race is over and gone: let them go
        const D = window.IW_RIDER || {}; // the body's shape and plain skin are shared with him
        for (const e of rivalsOn.values()) {
          scene.remove(e.r.root);
          e.r.root.traverse(m => { if (m.isMesh || m.isSprite) { if (m.geometry !== D.geo) m.geometry?.dispose(); if (m.material?.map !== D.texture) m.material?.map?.dispose(); m.material?.dispose(); } });
        }
        rivalsOn.clear();
      }
    }
    const hills0 = mountains(photoDome && haze); scene.add(hills0);

    // Grass round the rider: tufts for the stretches from GRASS_BACK behind to
    // GRASS_AHEAD ahead, each stretch made once when it comes into range.
    const GRASS_BACK = 2, GRASS_AHEAD = 6, tuft = grassTuft();
    const grass = new T.InstancedMesh(tuft.geo, tuft.mat, (GRASS_BACK + GRASS_AHEAD + 1) * 340);
    grass.instanceColor = new T.InstancedBufferAttribute(new Float32Array(grass.count * 3), 3);
    grass.frustumCulled = false; grass.receiveShadow = true; grass.count = 0;
    scene.add(grass);
    let grassAt = null, grassMade = new Map();
    let scatter = [], scatterTick = 0; // tree and hedge groups, hidden when far away
    // Land pieces and their painted textures: the job being painted, and the
    // grass grain every land material shares.
    let pieces = [], paintTick = 0, job = null, chunks = [], tileOf = new Map(), builtVer = null, builtArea = null;
    const grassPhoto = photo('grass', renderer), grain = grassPhoto ? { photo: true, grass: grassPhoto, soil: photo('dirt', renderer) } : { grass: surface('grass', renderer) };
    const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    let built = null, world = null, disp = 0, last = performance.now(), pedal = 0, raf = 0, running = false, climb = 0, view = 'chase', tiles = [], tileMat = null, sortedAt = null, sky2 = null, drift = 0;
    const camPos = new T.Vector3(), camLook = new T.Vector3(), tmp = new T.Vector3(), ahead = new T.Vector3();
    // The free camera: drag to go round the rider (and up and down), the
    // wheel or two fingers to come closer or go further out, double-click
    // to put it back behind him.
    const ORBIT0 = { yaw: 0, pitch: 0.32, dist: 9 }, orbit = { ...ORBIT0 }, touches = new Map();
    let pinch = 0;
    function bindOrbit(canvas) {
    canvas.addEventListener('pointerdown', e => {
      if (view !== 'free') return;
      touches.set(e.pointerId, [e.clientX, e.clientY]); canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing';
      if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
    });
    canvas.addEventListener('pointermove', e => {
      const p = touches.get(e.pointerId);
      if (view !== 'free' || !p) return;
      if (touches.size === 1) {
        orbit.yaw -= (e.clientX - p[0]) * 0.006;
        orbit.pitch = Math.max(0.02, Math.min(1.45, orbit.pitch + (e.clientY - p[1]) * 0.005));
      }
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) orbit.dist = Math.max(2.5, Math.min(450, orbit.dist * (pinch / d)));
        pinch = d;
      }
    });
    const lift = e => { touches.delete(e.pointerId); pinch = 0; if (view === 'free') canvas.style.cursor = 'grab'; };
    canvas.addEventListener('pointerup', lift); canvas.addEventListener('pointercancel', lift);
    canvas.addEventListener('wheel', e => {
      if (view !== 'free') return;
      e.preventDefault();
      orbit.dist = Math.max(2.5, Math.min(450, orbit.dist * Math.exp(e.deltaY * 0.0015)));
    }, { passive: false });
    canvas.addEventListener('dblclick', () => { if (view === 'free') Object.assign(orbit, ORBIT0); });
    }
    bindOrbit(renderer.domElement);

    // ---- World: Google 3D. A hybrid: Google's photoreal world is drawn by
    // Google's own map element (its tiles can't be taken into three.js from
    // Europe) behind our canvas, and our own world is drawn over it as usual,
    // fading out from GFADE[0] to GFADE[1] metres. So up close it is our road,
    // trees and houses with him on them, always at the right height; beyond,
    // it is Google's land, towns and mountains, and the sky. Every frame the
    // map's camera is set to ours, so the far land lines up with the near.
    const GFADE = [220, 560];
    let gl3 = null, glFail = '';
    function googleOn(key) {
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;inset:0;background:#9aa7b4';
      container.prepend(box);
      renderer.domElement.style.position = 'relative'; // over the map
      const rt = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, samples: renderer.capabilities.isWebGL2 ? 4 : 0 });
      rt.depthTexture = new T.DepthTexture(1, 1, T.UnsignedIntType);
      // Our picture onto the canvas, graded as the renderer would, and clear
      // with distance (and wherever nothing of ours was drawn).
      const fade = new T.ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `uniform sampler2D src; uniform sampler2D depth; uniform float near; uniform float far; uniform vec2 fade; varying vec2 vUv;
          void main() {
            vec4 c = texture2D(src, vUv);
            float z = texture2D(depth, vUv).x * 2.0 - 1.0;
            float d = 2.0 * near * far / (far + near - z * (far - near));
            float a = c.a * (1.0 - smoothstep(fade.x, fade.y, d));
            gl_FragColor = vec4(CustomToneMapping(c.rgb) * a, a);
          }`,
        uniforms: { src: { value: rt.texture }, depth: { value: rt.depthTexture }, near: { value: 0 }, far: { value: 0 }, fade: { value: new T.Vector2(...GFADE) }, toneMappingExposure: { value: 1 } },
        depthTest: false, depthWrite: false, toneMapped: false, transparent: false,
      });
      fade.fragmentShader = T.ShaderChunk.tonemapping_pars_fragment + fade.fragmentShader; // CustomToneMapping, the renderer's grade
      const quad = new T.Mesh(new T.PlaneGeometry(2, 2), fade), qs = new T.Scene(), qc = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      quad.frustumCulled = false; qs.add(quad);
      const L = { box, rt, fade, quad, qs, qc, map: null };
      loadGoogle(key).then(async () => {
        const { Map3DElement } = await google.maps.importLibrary('maps3d');
        if (gl3 !== L) return;
        L.map = new Map3DElement({ mode: 'SATELLITE', defaultUIHidden: true, fov: camera.fov, center: { lat: 0, lng: 0, altitude: 0 }, range: 10, tilt: 70, heading: 0 });
        L.map.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        L.map.addEventListener('gmp-error', () => googleFail('Google 3D reported an error. Check the key allows this site and the Maps JavaScript API is on.'));
        box.append(L.map);
      }).catch(e => googleFail(e.message));
      return L;
    }
    function googleOff() {
      if (!gl3) return;
      const L = gl3; gl3 = null;
      L.box.remove(); L.rt.dispose(); L.rt.depthTexture.dispose(); L.fade.dispose(); L.quad.geometry.dispose();
      renderer.domElement.style.position = '';
    }
    // Our world into the target, then faded onto the canvas over the map.
    // No sky, clouds or painted mountains of ours: Google's are there.
    function googleDraw(L) {
      const w = renderer.domElement.width, h = renderer.domElement.height;
      if (L.rt.width !== w || L.rt.height !== h) L.rt.setSize(w, h);
      const dens = scene.fog.density, cc = new T.Color(), ca = renderer.getClearAlpha();
      renderer.getClearColor(cc);
      scene.fog.density = dens * 0.35; hills0.visible = false; if (sky2) sky2.visible = false;
      renderer.setRenderTarget(L.rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
      scene.fog.density = dens; hills0.visible = true; if (sky2) sky2.visible = true;
      // Measured from the camera, plus however far it has been pulled back
      // from him, so a free camera out at 300 m still sees him and his road.
      const u = L.fade.uniforms, back = camera.position.distanceTo(camLook), end = Math.min(GFADE[1] + back, camera.far - 20);
      u.near.value = camera.near; u.far.value = camera.far; u.fade.value.set(Math.min(GFADE[0] + back, end - 150), end);
      renderer.setRenderTarget(null); renderer.clear(); renderer.render(L.qs, L.qc);
      renderer.setClearColor(cc, ca);
    }
    function googleFail(m) { glFail = m; googleOff(); }
    window.__iwGoogleFail = googleFail;
    // Where Google's camera goes: the same as ours, as a point looked at
    // (latitude, longitude, height above the sea), how far back, how far
    // tipped up from looking straight down, and which way.
    function googleCamera(L, g, pos) {
      const msl = (x, z, y) => { const h = g.dem ? g.dem(x, z) : NaN; return Number.isFinite(h) ? h : g.ele0 + y / LIFT; };
      const ground = msl(pos.x, pos.z, pos.y) + googleLift;
      const d = camera.position.clone().sub(camLook), range = Math.max(0.5, d.length());
      const [lat, lng] = g.ll(camLook.x, camLook.z);
      const m = L.map;
      m.center = { lat, lng, altitude: ground + (camLook.y - pos.y) };
      m.range = range;
      m.tilt = (Math.acos(Math.max(-1, Math.min(1, d.y / range))) * 180) / Math.PI;
      m.heading = ((Math.atan2(-d.x, d.z) * 180) / Math.PI + 360) % 360; // looking along -d: east -d.x, north +d.z (z is south)
      if (m.fov !== camera.fov) m.fov = camera.fov;
    }
    // Google's camera rides this much higher than ours. Its ground and our
    // terrain disagree by up to 20 m (and ours is drawn LIFT times steeper),
    // so with the cameras level Google's land could rise in front of our
    // road or the camera end up inside Google's hill. From higher up, its
    // land sits a little lower in the picture, under our near world, and
    // the far mountains move by a fraction of a degree.
    let googleLift = 25;

    // Weather. Clear is the photographed sky as it is; the others fade the sky
    // into a heavier haze, dim the sun (no hard shadows under cloud), thicken
    // the fog and, for rain and snow, let it fall round the camera. Rain also
    // darkens the road, as wet tarmac does.
    let weather = 'clear', fall = null, roadMat = null;
    const clearHaze = haze.clone();
    function setWeather(w) {
      weather = w;
      const W = WEATHER[w];
      haze.set(W.haze ?? clearHaze);
      scene.fog.color.copy(haze); farScene.fog.color.copy(haze);
      if (!photoDome) farScene.background.set(W.haze ?? SKY);
      dome.userData.veil?.set(haze.r, haze.g, haze.b, 1 - W.sky);
      hazeFor();
      sun.intensity = W.sun; sun.castShadow = W.shadow;
      hemi.intensity = W.hemi;
      roadMat?.color.set(W.wet ? 0x2f3236 : 0x4a4e55);
      snowCover.value = W.cover || 0;
      grass.visible = !W.cover; // buried
      if (fall) { scene.remove(fall.obj); fall.obj.geometry.dispose(); fall.obj.material.map?.dispose(); fall.obj.material.dispose(); fall = null; }
      if (W.fall) { fall = falling(W.fall); scene.add(fall.obj); }
    }

    // How far one can see: thick haze for the made-up world (its land ends at
    // 700 m), thin on real land when the distant mountains can show.
    function hazeFor() {
      const W = WEATHER[weather], far = REAL && W.far;
      scene.fog.density = far ? W.realFog : W.fog;
      farScene.fog.far = far || 1;
      farScene.fog.near = far ? 2000 : 0; // clear air: the first kilometres of mountains stay sharp
      if (farMesh) farMesh.visible = !!far;
      hills0.visible = weather === 'clear' && !REAL; // their foot is painted into the clear-sky haze
    }

    // The real place for a route, loading in the background: the heights
    // near the road, the far heights, the map. The world is built again as
    // each arrives (v counts them). note is the line shown under the view.
    const placeData = new WeakMap();
    let realWant = true, builtV = null, farMesh = null, farAt = null, sea = null, bannerTick = 0, bannerText = '', afterRender = null;
    const farMat = new T.MeshBasicMaterial({ vertexColors: true });
    function placesFor(route) {
      if (route.roam) return route.roam.rec; // a free ride loads its own squares of map (roam.js)
      let rec = placeData.get(route);
      if (rec || !window.IW_PLACES) return rec || null;
      placeData.set(route, (rec = { v: 0 }));
      const P = window.IW_PLACES, pts = route.res.filter((_, i) => i % 3 === 0).map(p => [p.lat, p.lon]);
      P.terrain(pts, 1100, [13, 12, 11], 160).then(h => { rec.near = h; }, e => { rec.nearErr = e.message || String(e); }).finally(() => rec.v++);
      P.terrain(pts, 42000, [11, 10, 9, 8], 80).then(h => { rec.far = h; }, () => {});
      P.osm(pts).then(m => { rec.osm = m; }, e => { rec.osmErr = e.message || String(e); }).finally(() => rec.v++);
      if (P.imagery) {
        P.imagery(pts, 1100, [14, 13], 220).then(f => { rec.sat = f; }, e => { rec.satErr = e.message || String(e); }).finally(() => rec.v++);
        P.imagery(pts, 42000, [12, 11, 10], 140).then(f => { rec.farSat = f; }, () => {});
      }
      if (P.aerial) rec.aerial = P.aerial(window.IW_ESRI_KEY || '');
      return rec;
    }
    function noteOf(rec) {
      if (!rec) return '';
      if (rec.nearErr) return `The real land could not load (${rec.nearErr}), so this is made-up land.`;
      if (!rec.near) return 'Loading the real land…';
      const hi = rec.aerial?.credits.join(' · ');
      const credit = `Heights: AWS Terrain Tiles · ${hi ? `${hi} · ` : ''}${rec.sat ? 'Imagery: Sentinel-2 cloudless by EOX, Copernicus Sentinel data 2020 · ' : ''}Map © OpenStreetMap contributors`;
      if (rec.osmErr) return `The map could not load (${rec.osmErr}), so the woods are made up and there are no towns. Heights: AWS Terrain Tiles`;
      if (!rec.osm) return `Loading the map (woods, water, towns)… ${credit}`;
      if (rec.satErr) return `The satellite photos could not load (${rec.satErr}), so the land is painted. ${credit}`;
      return credit;
    }
    let note = '', noteRec = null;

    function setRoute(route) {
      if (farMesh) { farScene.remove(farMesh); farMesh.geometry.dispose(); farMesh = null; farAt = null; }
      sea = null; REAL = null; builtV = null; note = ''; noteRec = null; showBanner(null);
      if (world) {
        scene.remove(world);
        world.traverse(o => {
          if (o.userData.sharedParts) { o.dispose(); return; } // trees: the kit is kept for the next route
          o.geometry?.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m?.map?.dispose(); m?.dispose(); });
        });
        tileMat?.dispose(); // the land's plain material, also under the painted pieces
      }
      built = route; tiles = []; grassAt = null; grassMade = new Map(); grass.count = 0;
      world = new T.Group();
      if (!route) return;
      // Real land for a GPX route (the built-in course is the made-up world).
      const rec = (realWant || route.roam) && !route.scenery ? placesFor(route) : null; // a free ride is always the real place
      // Gravel and dirt from the map; the ride's road speed reads it too.
      route.surface = rec?.osm ? surfacesOf(route.res, rec.osm) : null;
      const g = geometryOf(route);
      world.userData.g = g;
      builtV = rec ? rec.v : null; note = noteOf(rec); noteRec = rec;
      if (rec?.near) { useTerrain(g, rec.near); REAL = realOf(route, g, rec); }
      hazeFor();
      // Built in pieces of CHUNK points (600 m) so the ones behind the rider
      // or past the fog are skipped instead of drawn every frame.
      const tarmac = photo('asphalt', renderer);
      tarmac?.repeat.set(2, 2); // a 2 m tile
      const asphalt = worn(new T.MeshLambertMaterial({ color: WEATHER[weather].wet ? 0x2f3236 : 0x4a4e55, map: tarmac || surface('road', renderer) }));
      roadMat = asphalt;
      const paint = new T.MeshLambertMaterial({ color: 0xf2f4f6 });
      const land = grained(new T.MeshLambertMaterial({ vertexColors: true }), grain); // until a piece's paint is in
      // Side roads (a free ride): tarmac and dirt, drawn over the land.
      const lane = new T.MeshLambertMaterial({ color: WEATHER[weather].wet ? 0x34373c : 0x50545b, map: tarmac || null, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      const dirt = new T.MeshLambertMaterial({ color: 0x8b7b5f, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      // The route itself where it is gravel or dirt: lighter, narrower, no lines.
      const loose = surface('gravel', renderer), soil = photo('dirt', renderer);
      soil?.repeat.set(0.5, 0.5);
      const gravel = new T.MeshLambertMaterial({ color: WEATHER[weather].wet ? 0x8a8170 : 0xb9ad94, map: loose });
      const track = new T.MeshLambertMaterial({ color: WEATHER[weather].wet ? 0x5e4c38 : 0x8d7454, map: soil || loose });
      const mid = new T.MeshLambertMaterial({ color: 0x5c7440, map: surface('grass', renderer), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      world.userData.mats = { asphalt, paint, land, lane, dirt, gravel, track, mid };
      world.userData.seed = Math.round(route.total) + route.res.length;
      scatter = []; pieces = []; job = null; chunks = []; tileOf = new Map();
      const sc = sceneryOf(route);
      woodsAt = route.scenery?.woods || [0, 0];
      world.userData.sc = sc;
      if (REAL) for (const c of REAL.cols) sc.flags.push([c.top * STEP - 70, c.top * STEP + 70]); // flags over each col
      if (!sky2 && !photoDome) scene.add((sky2 = clouds())); // the photographed sky has its own
      world.add(props(g, sc));
      for (let s = 0; s < g.n - 1; s += CHUNK) buildChunk(g, s);
      // The far land is built a few tiles per frame, nearest first, so a long
      // route shows at once instead of freezing the page for a second or two.
      tiles = landTiles(g); tileMat = land; sortedAt = null;
      world.userData.km = kmSigns(g, route.total); world.add(world.userData.km);
      if (REAL) {
        if (!route.roam) { const h = houses(g, REAL, rec.osm); if (h.length) world.add(...h); scatter.push(...h); }
        world.userData.water = new T.Group(); world.add(world.userData.water);
        const wt = waters(g, rec.osm);
        if (wt.length) world.userData.water.add(...wt);
        world.userData.signs = realSigns(g, REAL); world.add(world.userData.signs);
        if (REAL.sea) { // the sea, a plane at sea level that travels with the camera
          sea = new T.Mesh(new T.PlaneGeometry(2400, 2400), waterMat);
          sea.rotation.x = -Math.PI / 2; sea.position.y = -g.ele0 * LIFT; sea.receiveShadow = true;
          world.add(sea);
        }
      }
      builtVer = route.ver; builtArea = rec?.area; route.changedFrom = Infinity;
      scene.add(world);
      disp = getState().dist;
      camPos.set(0, 0, 0); camLook.set(0, 0, 0);
    }

    // One piece of the world: the road from point s to the next CHUNK, its
    // land strip, its trees, and on a free ride the side roads and houses
    // nearest it. Kept by s, so a free ride can build it again when the road
    // past it changes.
    function buildChunk(g, s, e = Math.min(g.n - 1, s + CHUNK)) {
      const M = world.userData.mats, sc = world.userData.sc, objs = [];
      const add = o => { world.add(o); objs.push(o); };
      const piece = { s, e, objs, extra: [] };
      const strip = (from, to, lift, mat, keep) => { const m = new T.Mesh(ribbon(g, s, e, from, to, lift, keep), mat); m.receiveShadow = true; add(m); };
      const fresh = i => !(g.dup[i] && g.dup[i - 1]); // road ridden before is drawn once
      // What the road is made of (surfacesOf): tarmac with its lines, a
      // narrower gravel road, or a dirt track with grass up the middle.
      const kind = i => (g.surf ? g.surf[i] : 0), on = k => i => fresh(i) && (kind(i) === k || kind(i - 1) === k);
      const tar = on(0);
      strip(-ROAD_HALF, ROAD_HALF, 0.02, M.asphalt, tar);
      strip(-ROAD_HALF + 0.25, -ROAD_HALF + 0.4, 0.04, M.paint, tar);
      strip(ROAD_HALF - 0.4, ROAD_HALF - 0.25, 0.04, M.paint, tar);
      strip(-0.07, 0.07, 0.04, M.paint, i => i % 2 === 0 && tar(i)); // dashed centre line
      if (g.surf) {
        let has1 = false, has2 = false;
        for (let i = s; i <= e; i++) { has1 = has1 || g.surf[i] === 1; has2 = has2 || g.surf[i] === 2; }
        if (has1) strip(-2.2, 2.2, 0.025, M.gravel, on(1));
        if (has2) { strip(-1.6, 1.6, 0.025, M.track, on(2)); strip(-0.3, 0.3, 0.04, M.mid, on(2)); }
      }
      const strip0 = nearLand(g, s, e, M.land);
      add(strip0); pieces.push(strip0);
      const avoid = (x, z, i) => sc.clearings.some(([a, b]) => i * STEP >= a && i * STEP <= b);
      const t = trees(g, s, e, world.userData.seed + s, avoid);
      for (const o of t) add(o);
      scatter.push(...t);
      chunks.push(piece);
      if (built.roam) roamExtras(g, piece);
    }
    // A free ride's side roads and houses for a piece. The last piece also has
    // those past the end of the road, so they are made again when it grows.
    function roamExtras(g, piece) {
      for (const o of piece.extra) drop(o);
      piece.extra = [];
      const { s, e } = piece, add = o => { world.add(o); piece.extra.push(o); };
      const side = sideRoads(g, s, e, built.roam, world.userData.mats);
      if (side) add(side);
      if (REAL) { const h = houses(g, REAL, built.roam.rec.osm, [s, e === g.n - 1 ? e + 1 : e]); for (const o of h) add(o); scatter.push(...h); }
    }
    // Take something out of the world for good, keeping the materials other
    // pieces share.
    function drop(o) {
      world.remove(o);
      o.traverse(q => {
        if (q.userData.sharedParts) { q.dispose(); return; }
        if (pieces.includes(q)) { unpaint(q); if (job?.m === q) job = null; }
        q.geometry?.dispose();
      });
      if (pieces.includes(o)) pieces = pieces.filter(m => m !== o);
      if (scatter.includes(o)) scatter = scatter.filter(m => m !== o);
    }
    // A free ride's road grew (or turned round): new pieces for the new road;
    // everything already built stays as it is, paint and all, so nothing
    // round the rider flickers or changes.
    function grow(route) {
      const rec = route.roam.rec, old = world.userData.g;
      // The road ridden so far stays as it is; after a U-turn, up to where he turned.
      const turned = route.turnedAt != null, keep = Math.max(1, Math.min(old.n, turned ? route.turnedAt : old.n));
      route.turnedAt = null; route.changedFrom = Infinity; builtVer = route.ver;
      route.surface = surfacesOf(route.res, rec.osm);
      const g = geometryOf(route, old, keep);
      world.userData.g = g;
      if (rec.near) useTerrain(g, rec.near, old, keep);
      const newArea = rec.area !== builtArea;
      builtArea = rec.area;
      if (REAL) {
        const was = REAL.cover;
        REAL = realOf(route, g, rec, newArea ? null : was);
        if (newArea) { // the next square of map is in: its lakes and rivers
          for (const o of [...world.userData.water.children]) drop(o);
          const wt = waters(g, rec.osm);
          if (wt.length) world.userData.water.add(...wt);
        }
      }
      // Nothing already built is taken away: after a U-turn the road on
      // ahead is still there (it is a real road), just not where you go now.
      // The piece that ended where the road went on gets its side roads and
      // houses again (the new road is no longer a side road), and the new
      // road gets pieces of its own.
      for (const c of chunks) if (!c.gone && c.e >= keep) {
        // Its land keeps the paint it has: its point numbers now mean the road back.
        c.gone = true;
        pieces = pieces.filter(m => !c.objs.includes(m));
        if (job && c.objs.includes(job.m)) job = null;
      }
      const last = chunks.find(c => !c.gone && c.e === keep - 1);
      if (last) roamExtras(g, last);
      for (let s0 = turned ? keep : keep - 1; s0 < g.n - 1;) { const e = Math.min(g.n - 1, s0 + CHUNK); buildChunk(g, s0, e); s0 = e; }
      // The land tiles round the new road: new where there were none; where
      // the new road crosses one, made again and swapped in under its paint.
      const fresh = landTiles(g, Math.max(0, keep - 3));
      tiles = tiles.filter(t => !fresh.some(f => f.key === t.key));
      for (const t of fresh) {
        const was = tileOf.get(t.key);
        if (was && t.near > TILE * 0.71 + NEAR + 30) continue;
        t.swap = was || null;
        tiles.push(t);
      }
      sortedAt = null;
      if (Math.floor(route.total / 1000) !== Math.floor((world.userData.kmAt || 0) / 1000)) {
        drop(world.userData.km); world.userData.km = kmSigns(g, route.total); world.add(world.userData.km);
      }
      world.userData.kmAt = route.total;
      if (REAL) { drop(world.userData.signs); world.userData.signs = realSigns(g, REAL); world.add(world.userData.signs); }
      grassMade = new Map(); grassAt = null;
    }

    // Paint the land near the rider, finer the closer it is; far pieces keep
    // their plain colours (the haze hides the difference) and give their
    // textures back. One piece is painted at a time, nearest first, in slices.
    function paintGround(dt) {
      if ((paintTick -= dt) <= 0) {
        paintTick = 0.4;
        const here = at(disp, new T.Vector3());
        let best = null;
        for (const m of pieces) {
          const u = m.userData;
          if (!u.c) { m.geometry.computeBoundingSphere(); u.c = m.geometry.boundingSphere.center; u.mpp = 0; }
          const d = Math.max(0, Math.hypot(u.c.x - here.x, u.c.z - here.z) - (u.paint.strip ? 250 : 100));
          const want = d < 250 ? 1 : d < 700 ? 2.5 : 0;
          if (!want) { if (u.mpp) unpaint(m); u.hi = null; u.hiDone = false; continue; }
          // Sharp photos for the close pieces: ask for them, and paint (or
          // paint again) once they are in or known missing. Until then a
          // piece keeps what it has, and the road right ahead waits.
          let again = false;
          if (want === 1 && REAL?.hiEnsure) {
            if (!u.hi) { const r = REAL; u.hi = 'loading'; r.hiEnsure(u.c.x, u.c.z, m.geometry.boundingSphere.radius + 20).then(() => { if (REAL === r) { u.hi = 'in'; paintTick = 0; } }); }
            if (u.hi === 'loading' && (u.mpp || d < 120)) continue;
            again = u.hi === 'in' && !u.hiDone && u.mpp === 1;
          }
          if ((!u.mpp || want < u.mpp || again || u.stale) && (!best || d < best.d) && job?.m !== m) best = { m, d, want };
        }
        if (best && (!job || best.d < job.d - 100)) job = { ...best, hi: best.m.userData.hi, gen: paintLand(world.userData.g, best.m, best.want) };
      }
      for (const t0 = performance.now(); job && performance.now() - t0 < 4;) {
        const r = job.gen.next();
        if (!r.done) continue;
        const m = job.m, tex = new T.CanvasTexture(r.value);
        tex.anisotropy = maxAniso;
        unpaint(m);
        m.material = grained(new T.MeshLambertMaterial({ map: tex }), grain);
        m.userData.mpp = job.want; m.userData.stale = false;
        m.userData.hiDone = job.hi === 'in'; // the photos were all in when this paint began
        job = null; paintTick = 0; // straight on to the next
      }
    }
    function plantGrass(g, i0) {
      const L = g.n - 1, m = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), v = new T.Vector3(), sc = new T.Vector3(), keep = new Map();
      let n = 0;
      for (let k = -GRASS_BACK; k <= GRASS_AHEAD; k++) {
        let i = i0 + k;
        if (g.loop) i = ((i % L) + L) % L; else if (i < 0 || i >= L) continue;
        const t = grassMade.get(i) || grassStretch(g, i);
        keep.set(i, t);
        for (let a = 0; a < t.length; a += 8, n++) {
          q.setFromEuler(e.set(0, t[a + 4], 0)); sc.setScalar(t[a + 3]);
          grass.setMatrixAt(n, m.compose(v.set(t[a], t[a + 1], t[a + 2]), q, sc));
          grass.instanceColor.setXYZ(n, t[a + 5], t[a + 6], t[a + 7]);
        }
      }
      grassMade = keep; grass.count = n;
      grass.instanceMatrix.needsUpdate = true; grass.instanceColor.needsUpdate = true;
    }
    function unpaint(m) {
      if (m.material !== tileMat) { m.material.map?.dispose(); m.material.dispose(); m.material = tileMat; }
      m.userData.mpp = 0;
    }

    // A point on the road at a distance, with its height. Before the start or
    // past the end it carries straight on along the first or last stretch, so
    // the camera behind the rider at 0 m sits on the road, not inside him.
    function at(d, out) {
      const g = world.userData.g;
      if (g.loop) { const L = (g.n - 1) * STEP; d = ((d % L) + L) % L; } // a loop: round and round
      const f = d / STEP, i = Math.min(g.n - 2, Math.max(0, Math.floor(f))), t = f - i;
      const a = g.xz[i], b = g.xz[i + 1], h = Math.min(1, Math.max(0, t));
      return out.set(a[0] + (b[0] - a[0]) * t, g.y[i] + (g.y[i + 1] - g.y[i]) * h, a[1] + (b[1] - a[1]) * t);
    }

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
      camera.aspect = w / h; camera.updateProjectionMatrix();
      farCam.aspect = w / h; farCam.updateProjectionMatrix();
      if (post) post.size(w, h);
    }
    // The name of the place, a col or a border, over the top of the view.
    const banner = document.createElement('div');
    banner.style.cssText = 'position:absolute;left:0;right:0;top:12%;text-align:center;color:#fff;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,.6),0 0 14px rgba(0,0,0,.45);opacity:0;transform:translateY(-6px);transition:opacity 300ms cubic-bezier(.23,1,.32,1),transform 300ms cubic-bezier(.23,1,.32,1);font-family:"Segoe UI",Arial,sans-serif';
    container.append(banner);
    function showBanner(b) {
      const text = b ? b.join('|') : '';
      if (text === bannerText) return;
      bannerText = text;
      if (!b) { banner.style.opacity = 0; banner.style.transform = 'translateY(-6px)'; return; }
      banner.innerHTML = '';
      const t = document.createElement('div'); t.textContent = b[0]; t.style.cssText = 'font-size:clamp(20px,3.2vw,40px);font-weight:800;letter-spacing:.02em';
      banner.append(t);
      if (b[1]) { const s = document.createElement('div'); s.textContent = b[1]; s.style.cssText = 'font-size:clamp(13px,1.6vw,19px);font-weight:600;opacity:.9;margin-top:2px'; banner.append(s); }
      banner.style.opacity = 1; banner.style.transform = 'none';
    }
    const ro = new ResizeObserver(resize); ro.observe(container);

    function frame(now) {
      raf = running ? requestAnimationFrame(frame) : 0;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const s = getState();
      const want = s.real !== false || !!s.google; // Google 3D wants the real heights too
      if (s.route !== built || want !== realWant) { realWant = want; setRoute(s.route); }
      else if (built && !built.scenery && (realWant || built.roam) && (built.roam ? built.roam.rec : placeData.get(built))?.v !== builtV) setRoute(built); // more of the real place is in
      else if (built?.roam && world && (built.ver !== builtVer || built.roam.rec.area !== builtArea)) grow(built); // a free ride's road went on
      if (!built) return;
      if (s.google && !gl3 && !glFail) gl3 = googleOn(s.google);
      else if (!s.google && gl3) googleOff();
      if (!s.google) glFail = '';
      if (tiles.length) {
        // Nearest to the rider first; sorted again after he has moved on 300 m (or jumped).
        const here = at(disp, new T.Vector3());
        if (!sortedAt || sortedAt.distanceTo(here) > 300) {
          sortedAt = here;
          for (const t of tiles) t.d = Math.hypot(t.x - here.x, t.z - here.z);
          tiles.sort((p, q) => p.d - q.d);
        }
        for (const t0 = performance.now(); tiles.length && performance.now() - t0 < 6;) {
          const t = tiles.shift(), m = t.build(tileMat);
          if (t.swap && t.swap.parent) { // the same tile with a new road through it: new shape, same paint for now
            const u = t.swap.userData;
            t.swap.geometry.dispose(); t.swap.geometry = m.geometry; u.c = null; u.stale = true;
            continue;
          }
          world.add(m); pieces.push(m); tileOf.set(t.key, m);
        }
      }
      paintGround(dt);
      // Glide between the ride's 4 ticks a second, then ease onto the real distance.
      disp += s.speed * dt;
      disp += (s.dist - disp) * Math.min(1, dt * 2.5);
      if (Math.abs(s.dist - disp) > 50) { disp = s.dist; camPos.set(0, 0, 0); } // a jump (new ride, route reset): cut, don't fly
      // Keep right, as on a Belgian road.
      const pos = at(disp, tmp.clone()), fwd = at(disp + 4, ahead).sub(at(disp - 4, new T.Vector3()));
      const heading = Math.atan2(-fwd.x, -fwd.z), pitch = Math.atan2(fwd.y, Math.hypot(fwd.x, fwd.z));
      const fl = Math.hypot(fwd.x, fwd.z) || 1, right = new T.Vector3(-fwd.z / fl * KEEP, 0, fwd.x / fl * KEEP);
      bike.root.position.copy(pos).add(right);
      pedal += ((s.cadence || (s.speed > 0.5 ? 80 : 0)) / 60) * Math.PI * 2 * dt;
      // Out of the saddle on a steep bit: up off the seat, bike rocking with the
      // pedals. Eased in and out so a short ramp doesn't make him jump up.
      const grade = (at(disp + 15, new T.Vector3()).y - at(disp - 15, new T.Vector3()).y) / 30 / LIFT; // real gradient
      // With a power meter the ride says when you are out of the saddle
      // (estimated from cadence and pedal force); without one, steep road does.
      const stand = s.standing != null ? (s.standing ? 1 : 0) : grade > 0.06 ? Math.min(1, (grade - 0.06) / 0.03) : 0;
      climb += (stand - climb) * Math.min(1, dt * 2);
      bike.root.rotation.set(0, heading, 0); bike.root.rotateX(pitch); // the model faces -z
      bike.root.rotateZ(Math.sin(pedal) * 0.09 * climb);
      bike.pose(pedal, climb, (s.speed / 0.34) * dt);
      drawRivals(s.rivals, dt);
      // Chase camera: behind and above, looking down the road. It only tilts a
      // third of the way with the road, so a climb rises up the screen ahead of
      // the rider (and a descent drops away) instead of the horizon tilting with it.
      // Other views: close behind the rider, or from the roadside next to him.
      const v = VIEWS[view];
      const back = at(disp - v.back, new T.Vector3()), front = at(disp + v.ahead, new T.Vector3());
      const lookY = back.y + v.look + (front.y - back.y) / 3;
      let wantPos = back.add(right).addScaledVector(right, v.side / KEEP).add(new T.Vector3(0, v.up, 0)), wantLook = front.add(right).setY(lookY);
      if (view === 'free') {
        // Round the rider at the angle and distance set by hand, turning
        // with the road so "behind" stays behind; never under the ground.
        wantLook = pos.clone().add(right).setY(pos.y + 1.1);
        const yaw = heading + orbit.yaw, cp = Math.cos(orbit.pitch);
        wantPos = wantLook.clone().add(new T.Vector3(Math.sin(yaw) * cp, Math.sin(orbit.pitch), Math.cos(yaw) * cp).multiplyScalar(orbit.dist));
        const floor = groundAt(world.userData.g, wantPos.x, wantPos.z, 300).y + 1.2;
        if (wantPos.y < floor) wantPos.y = floor;
      }
      const cut = !camPos.lengthSq(), k = cut ? 1 : Math.min(1, dt * (view === 'free' ? 10 : 4));
      camPos.lerp(wantPos, k); camLook.lerp(wantLook, k);
      camera.position.copy(camPos);
      if (look && view !== 'free') {
        // Filmed, not drawn: the camera drifts and sways a little, as one
        // held on a following motorbike does, and buzzes with the road
        // the faster the rider goes.
        const t = now / 1000, buzz = Math.min(1, s.speed / 10) * 0.003;
        camera.position.y += (Math.sin(t * 1.3) * 0.6 + Math.sin(t * 2.9 + 1) * 0.4) * 0.03 + (Math.sin(t * 37) + Math.sin(t * 53 + 2)) * buzz;
        camera.position.x += Math.sin(t * 0.9 + 2) * 0.025 + Math.sin(t * 41 + 1) * buzz;
        camera.lookAt(camLook);
        camera.rotateZ((Math.sin(t * 0.7) + Math.sin(t * 1.9 + 1) * 0.5) * 0.003);
      } else camera.lookAt(camLook);
      const g = world.userData.g;
      if ((scatterTick -= dt) <= 0) {
        scatterTick = 0.3;
        for (const m of scatter) { const c = m.geometry.boundingSphere.center; m.visible = Math.hypot(c.x - camPos.x, c.z - camPos.z) < FAR - 50 + m.geometry.boundingSphere.radius * 0.6; }
      }
      tuft.wind.value += dt * (WEATHER[weather].fall ? 1.8 : 1); // gustier in rain and snow
      if (fall) fall.step(dt, camPos);
      if (REAL) {
        // The distant land, built again round the camera every 700 m.
        const rec = placesFor(built);
        if (rec?.far && (!farAt || Math.hypot(farAt.x - camPos.x, farAt.z - camPos.z) > 700)) {
          farAt = camPos.clone();
          const geo = farLand(g, REAL, rec.near, rec.far, camPos.x, camPos.z, SUN_DIR, rec.farSat || rec.sat);
          if (farMesh) { farMesh.geometry.dispose(); farMesh.geometry = geo; }
          else { farMesh = new T.Mesh(geo, farMat); farMesh.frustumCulled = false; farScene.add(farMesh); hazeFor(); }
        }
        if (sea) sea.position.set(camPos.x, sea.position.y, camPos.z);
        if ((bannerTick -= dt) <= 0) { bannerTick = 0.25; showBanner(bannerAt(REAL, Math.floor(disp / STEP))); }
      }
      const gi = Math.floor(disp / STEP);
      if (gi !== grassAt) { grassAt = gi; plantGrass(g, gi); }
      dome.position.copy(camPos);
      sun.target.position.copy(pos); sun.position.copy(pos).addScaledVector(SUN_DIR, 200);
      hills0.position.set(camPos.x, g.base[0] + (camPos.y - g.base[0]) * 0.85, camPos.z);
      if (sky2) { drift += dt * 1.5; sky2.position.set(camPos.x * 0.9 + drift, hills0.position.y, camPos.z * 0.9); }
      farCam.position.copy(camera.position); farCam.quaternion.copy(camera.quaternion);
      if (gl3) { // Google draws the far world and the sky; we draw the near world over it
        camera.updateMatrixWorld();
        if (gl3.map) googleCamera(gl3, g, pos);
        googleDraw(gl3);
        return;
      }
      const draw = () => {
        renderer.clear();
        renderer.render(farScene, farCam);
        renderer.clearDepth();
        renderer.render(scene, camera);
      };
      if (look) { camera.updateMatrixWorld(); post.render(draw, camera, bike.root, dt, cut); }
      else draw();
      // The drawing buffer is only readable until this frame is handed over,
      // so screenshots and recordings copy it from here.
      if (afterRender) afterRender(renderer.domElement);
    }

    return {
      start() { if (running) return; running = true; last = performance.now(); resize(); raf = requestAnimationFrame(frame); },
      stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
      get canvas() { return renderer.domElement; },
      get view() { return view; },
      set view(v) { if (VIEWS[v] && v !== view) { view = v; camPos.set(0, 0, 0); renderer.domElement.style.touchAction = v === 'free' ? 'none' : ''; renderer.domElement.style.cursor = v === 'free' ? 'grab' : ''; } },
      get weather() { return weather; },
      set weather(w) { if (WEATHER[w]) setWeather(w); },
      get info() { return renderer.info.render; },
      get scenery() { return built && world.userData.sc; }, // where the gantries and flags went
      get note() { return noteRec ? noteOf(noteRec) : note; }, // what has loaded of the real place, and its credits (live, as photo tiles arrive)
      get real() { return REAL && { towns: REAL.towns.map(t => [t.name, t.a * STEP, t.b * STEP]), cols: REAL.cols.map(c => [c.name, c.ele, c.start * STEP, c.top * STEP]), borders: REAL.borders.map(b => [b.to.name, b.i * STEP]), region: { med: REAL.med, alps: REAL.alps, lavender: REAL.lavender, snowLine: REAL.snowLine, treeLine: REAL.treeLine, code: REAL.code(0) } }; },
      get banner() { return bannerText; },
      set afterRender(fn) { afterRender = fn || null; },
      get look() { return look ? 'video' : 'plain'; }, // the video look (null when this browser can't have it)
      set look(v) { const on = v === 'video' && !!post; if (on !== look) { look = on; if (post) post.reset(); } },
      get canLook() { return !!post; },
      get google() { return gl3 ? (gl3.map ? 'on' : 'loading') : glFail ? `fail:${glFail}` : ''; },
      // Your own bike: a .glb file's ArrayBuffer (needs THREE.GLTFLoader), or
      // null for the built-in one. Resolves to the model's title, if it has one.
      setBike(buf) {
        if (!buf) { bike.useBike(null); return Promise.resolve(null); }
        return new Promise((ok, fail) => new THREE.GLTFLoader().parse(buf, '', g => {
          try { bike.useBike(g.scene); ok(g.asset?.extras?.title || g.parser?.json?.asset?.extras?.title || ''); } catch (e) { bike.useBike(null); fail(e); }
        }, e => fail(new Error(`That file could not be read as a 3D model (${e?.message || e}).`))));
      },
      set googleLift(m) { googleLift = Number.isFinite(+m) ? +m : 25; },
    };
  }

  window.World3D = { mount };
})();
