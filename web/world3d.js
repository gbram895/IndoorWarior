// IndoorWarior 3D view: rides a GPX route in three.js (r149, vendor/three.min.js,
// a classic script so it also works when index.html is opened as a file).
//
// The road follows the route's real shape and elevation. The land beside it is
// made up: rolling hills, fields and hedges, woods, the verge and a sign every
// kilometre, all from a fixed seed so the same route always looks the same.
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

  // ---- The route as 3D points: x east, z south, y up, in metres from the start.
  function geometryOf(route) {
    const res = route.res, n = res.length;
    const lat0 = res[0].lat, lon0 = res[0].lon, k = Math.cos((lat0 * Math.PI) / 180);
    const raw = res.map(p => [(p.lon - lon0) * 111320 * k, -(p.lat - lat0) * 110540]);
    // GPS wobble makes the road zigzag; average a few points either side.
    // The window stays centred, so the ends don't get pulled inwards (that
    // left a 30 m gap at the line of a loop); a loop averages round the line.
    const xz = raw.map((_, i) => {
      const w = route.loop ? 3 : Math.min(3, i, n - 1 - i);
      let x = 0, z = 0, c = 0;
      for (let j = i - w; j <= i + w; j++) { const q = raw[route.loop ? (((j % (n - 1)) + n - 1) % (n - 1)) : j]; x += q[0]; z += q[1]; c++; } // a loop's last point is its first
      return [x / c, z / c];
    });
    // Heights are drawn 1.6x steeper than they are. From a chase camera a true
    // 8% looks almost flat; this makes it read like the climb it feels like.
    // Only the picture: gradient, speed and the trainer use the real figures.
    const y = res.map(p => (p.ele - res[0].ele) * LIFT);
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
    // Road points in 100 m buckets, to find the road near any spot quickly.
    const hash = new Map();
    xz.forEach(([x, z], i) => { const k = bucket(x, z); hash.get(k)?.push(i) || hash.set(k, [i]); });
    return { n, xz, y, side, base, tilt, bend, hash, loop: !!route.loop };
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
    let sw = 0, ry = 0, b = 0, tl = 0;
    for (let k = 0; k < cand.length; k++) {
      const e = ds[k] - dpt; if (e > width * 3) continue;
      const j = cand[k], w = Math.exp(-((e / width) ** 2));
      const so = (x - g.xz[j][0]) * g.side[j][0] + (z - g.xz[j][1]) * g.side[j][1];
      sw += w; ry += w * g.y[j]; b += w * g.base[j]; tl += w * Math.max(-300, Math.min(300, so)) * g.tilt[j];
    }
    const near = 1 - smooth(4, 25, dmin); // right by the road, its exact height
    roadY = roadY * near + (ry / sw) * (1 - near);
    const far = smooth(120, 650, dmin);
    const land = b / sw + hills(x, z) + far * (noise(x / 900, z / 900) * 160 - 40) - tl / sw;
    return { y: roadY - 0.12 + hillWeight(dmin) * (land - roadY), d: dmin, road: roadY };
  }
  // The land at a spot within `r` of the road (searching wider if needed).
  function groundAt(g, x, z, r = 260) {
    for (const rr of [r, r * 3, 2000]) { const p = landAt(g, x, z, nearRoad(g, x, z, rr)); if (p) return p; }
    return { y: 0, d: Infinity, road: 0 };
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

  // The land close to the road, as a strip that follows it at the road's own
  // spacing so the verge meets the tarmac exactly. Rows every second point; s
  // and e are even (or the last point), so pieces meet on the same row. On
  // the inside of a tight bend the strip stops short of where it would cross
  // itself; the land map below fills in.
  const NEAR = 80;
  function nearLand(g, s, e, mat) {
    const OFF = [-80, -55, -35, -20, -11, -6, -3.2, 3.2, 6, 11, 20, 35, 55, 80];
    const rowsAt = [];
    for (let i = s; i < e; i += 2) rowsAt.push(i);
    rowsAt.push(e);
    const pos = [], col = [], uv = [], idx = [], c = new T.Color();
    for (let r = 0; r < rowsAt.length; r++) {
      const i = rowsAt[r], cand = nearRoad(g, g.xz[i][0], g.xz[i][1], NEAR + 60);
      // Inside of the bend: no further than 80% of its radius.
      let inner = Infinity;
      for (let j = Math.max(0, i - 8); j <= Math.min(g.n - 1, i + 8); j++) inner = Math.min(inner, 0.8 / (Math.abs(g.bend[j]) || 1e-9));
      const insideSign = Math.sign(g.bend[i]) || 1;
      for (let o of OFF) {
        if (Math.sign(o) === insideSign && Math.abs(o) > inner) o = Math.sign(o) * Math.max(3.4, inner);
        const x = g.xz[i][0] + g.side[i][0] * o, z = g.xz[i][1] + g.side[i][1] * o;
        const p = landAt(g, x, z, cand);
        pos.push(x, p.y, z);
        uv.push((o + NEAR) / (2 * NEAR), 1 - (i - s) / ((e - s) || 1)); // into its painted texture (see paintLand)
        landColour(c, x, z, p.y, p.road, Math.abs(o));
        col.push(c.r, c.g, c.b);
      }
      if (r) {
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
  const TILE = 200, CELLS = 10;
  function landTiles(g) {
    const keys = new Map(), reach = 700 + TILE * 0.71;
    for (let i = 0; i < g.n; i += 3) {
      const [x, z] = g.xz[i], tx = Math.floor(x / TILE), tz = Math.floor(z / TILE), k = Math.ceil(reach / TILE);
      for (let a = tx - k; a <= tx + k; a++) for (let b = tz - k; b <= tz + k; b++) {
        if (Math.hypot((a + 0.5) * TILE - x, (b + 0.5) * TILE - z) < reach) keys.set(a * 65536 + b, [a, b]);
      }
    }
    const c = new T.Color(), step = TILE / CELLS;
    return [...keys.values()].map(([a, b]) => ({ x: (a + 0.5) * TILE, z: (b + 0.5) * TILE, build: mat => {
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
        const y = p.y - 3 * (1 - smooth(NEAR - 10, NEAR + 8, p.d));
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
  const woods = (x, z) => { x += woodsAt[0]; z += woodsAt[1]; return noise(x / 380 + 7.3, z / 380) * 0.72 + noise(x / 110, z / 110 + 3.1) * 0.28; };
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
    const f = field(x, z);
    let k = 0; while (f.crop > CROPS[k][0]) k++;
    const [, [r, g, b], rows] = CROPS[k], tone = hash(f.c + 0.5, f.r) * 0.08 - 0.04;
    let l = 1 + tone;
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
    const clearOfRoad = (x, z, i, gap) => {
      for (let j = Math.max(0, i - 40); j <= Math.min(g.n - 1, i + 40); j++) {
        const dx = g.xz[j][0] - x, dz = g.xz[j][1] - z;
        if (dx * dx + dz * dz < gap * gap) return false;
      }
      return true;
    };
    // Only trees near the road cast shadows (the sun's shadow covers a 70 m
    // square round the rider); drawing the rest into the shadow map is waste.
    const tree = (x, z, i, scale, kind, o) => {
      const y = groundAt(g, x, z, 300).y - 0.3;
      (kind ? spruce : leafy)[o < 45 ? 0 : 1].push([x, y, z, scale, rand() * 6.3, (rand() - 0.5) * 0.35, 0.85 + rand() * 0.3]);
    };
    for (let i = s; i < e; i++) {
      for (const sg of [-1, 1]) {
        for (let o = 7 + rand() * 4; o < 330; o += 6 + o * 0.07 + rand() * 5) {
          const a = (rand() - 0.5) * STEP, ii = Math.min(g.n - 2, i);
          const fx = g.xz[ii + 1][0] - g.xz[ii][0], fz = g.xz[ii + 1][1] - g.xz[ii][1], fl = Math.hypot(fx, fz) || 1;
          const x = g.xz[i][0] + g.side[i][0] * o * sg + (fx / fl) * a, z = g.xz[i][1] + g.side[i][1] * o * sg + (fz / fl) * a;
          const w = woods(x, z);
          if (w < WOOD - 0.01 && !(rand() < 0.004)) continue; // a lone tree in the fields now and then
          if (avoid(x, z, i) || !clearOfRoad(x, z, i, ROAD_HALF + 4)) continue;
          const pine = noise(x / 240 + 11, z / 240) > 0.48;
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
      if (woods(x, z) > WOOD - 0.02) return;
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
      for (const sg of [-1, 1]) for (let k = 0; k < 4; k++) {
        const o = sg * (ROAD_HALF + 0.9 + rand() ** 1.5 * 9), a = rand() * STEP;
        const x = g.xz[i][0] + g.side[i][0] * o + (g.xz[Math.min(g.n - 1, i + 1)][0] - g.xz[i][0]) * (a / STEP), z = g.xz[i][1] + g.side[i][1] * o + (g.xz[Math.min(g.n - 1, i + 1)][1] - g.xz[i][1]) * (a / STEP);
        if (!clearOfRoad(x, z, i, ROAD_HALF + 0.6)) continue;
        const big = rand() < (woods(x, z) > WOOD ? 0.15 : 0.03);
        if (!big) continue;
        tufts.push([x, groundAt(g, x, z, 40).y - 0.05, z, big ? 1 + rand() * 0.6 : 0.4 + rand() * 0.5, rand() * 6.3, (rand() - 0.5) * 0.4, big ? 1.3 : 0.6 + rand() * 0.5]);
      }
    }
    // Marker posts every 50 m on both sides.
    for (let i = s - (s % 5); i < e; i += 5) {
      if (i < s) continue;
      for (const sg of [-1, 1]) { const p = groundY(g, i, sg * (ROAD_HALF + 0.9)); posts.push([p.x, p.y, p.z, 1, 0, 0, 1]); }
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
      let near = Infinity; // on a bend the far side of the next stretch may be the road
      for (let q = Math.max(0, j - 4); q <= Math.min(g.n - 1, j + 5); q++) near = Math.min(near, Math.hypot(g.xz[q][0] - x, g.xz[q][1] - z));
      if (near < ROAD_HALF + 0.25) continue;
      ground(x, z, rgb, o);
      if (rgb[0] - rgb[1] > 0.04) continue; // ploughed land
      const tint = 0.85 + rand() * 0.4, s = 0.7 + rand() * 0.7;
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
    return { arch: total > 400 ? [[25, 'START'], [total - 25, 'FINISH']] : [[25, 'START']], flags: [], clearings: [] };
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
  // are evened out to mid grey, so the paint keeps its colour.
  function grained(mat, detail) {
    mat.onBeforeCompile = sh => {
      sh.uniforms.grassMap = { value: detail.grass };
      sh.uniforms.soilMap = { value: detail.soil };
      sh.vertexShader = 'varying vec2 vDetail;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vDetail = position.xz;');
      sh.fragmentShader = 'uniform sampler2D grassMap;\nuniform sampler2D soilMap;\nvarying vec2 vDetail;\n' + sh.fragmentShader.replace('#include <map_fragment>', detail.photo
        ? `#include <map_fragment>
  vec3 grassD = texture2D(grassMap, vDetail / 1.7).rgb * 0.65 + texture2D(grassMap, vDetail / 9.0 + 0.37).rgb * 0.35;
  vec3 soilD = texture2D(soilMap, vDetail / 2.5).rgb * 0.6 + texture2D(soilMap, vDetail / 12.0 + 0.21).rgb * 0.4;
  diffuseColor.rgb *= 2.0 * mix(grassD, soilD, smoothstep(0.0, 0.07, diffuseColor.r - diffuseColor.g));`
        : '#include <map_fragment>\n  float grain = texture2D(grassMap, vDetail / 3.0).r * 0.6 + texture2D(grassMap, vDetail / 19.0).r * 0.4;\n  diffuseColor.rgb *= 0.5 + 0.7 * grain;');
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
    const cx = cv.getContext('2d'), rand = rng(kind === 'road' ? 11 : 23);
    const img = cx.createImageData(N, N), d = img.data;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const k = (y * N + x) * 4;
      // Tileable blotches (noise on a wrapped grid) plus per-pixel grit.
      const u = x / N, v = y / N, blot = (noise(u * 8, v * 8) + noise((u * 8 + 4) % 8, v * 8)) / 2;
      let l = kind === 'road' ? 0.8 + 0.12 * blot + (rand() - 0.5) * 0.28 : 0.72 + 0.22 * blot + (rand() - 0.5) * 0.3;
      if (kind === 'road' && rand() < 0.015) l += 0.25; // light stones in the tar
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
  // two-bone IK (hip fixed on the saddle, foot on the pedal), the arms reach
  // the hoods, and standing up on a climb moves the hips and shoulders forward.
  // The model faces -z; units are metres.
  function rider() {
    const root = new T.Group();
    const mat = c => new T.MeshLambertMaterial({ color: c });
    const M = {
      frame: mat(0x1d2a3a), dark: mat(0x16181c), tyre: mat(0x111214), rim: mat(0x8d949e), steel: mat(0xb8bec7),
      jersey: mat(0xff7a1a), jersey2: mat(0x1f2329), bib: mat(0x15171b), skin: mat(0xd9a882), sock: mat(0xf1f1f1),
      shoe: mat(0x22252b), helmet: mat(0xf4f5f7), visor: mat(0x20242a), saddle: mat(0x111214),
    };
    // A unit cylinder along +y, centred, that `limb` stretches between two points.
    const unitCyl = (r0, r1, seg = 10) => new T.CylinderGeometry(r1, r0, 1, seg, 1);
    const up = new T.Vector3(0, 1, 0), tmpV = new T.Vector3(), tmpQ = new T.Quaternion();
    function limb(mesh, a, b) {
      tmpV.subVectors(b, a); const len = tmpV.length() || 1e-6;
      mesh.position.copy(a).addScaledVector(tmpV, 0.5);
      mesh.quaternion.copy(tmpQ.setFromUnitVectors(up, tmpV.divideScalar(len)));
      mesh.scale.set(1, len, 1);
    }
    const add = (geo, m) => { const o = new T.Mesh(geo, m); root.add(o); return o; };
    const V = (x, y, z) => new T.Vector3(x, y, z);

    // ---- Bike. Rear axle z +0.5, front -0.5, wheels 0.34 m.
    const R = 0.34, BB = V(0, 0.27, 0.09), REAR = V(0, R, 0.5), FRONT = V(0, R, -0.5);
    const SEAT = V(0, 0.93, 0.29), HEAD_TOP = V(0, 0.84, -0.36), HEAD_LOW = V(0, 0.68, -0.40), BAR = V(0, 0.88, -0.47);
    const wheels = [];
    for (const c of [REAR, FRONT]) {
      const w = new T.Group(); w.position.copy(c); root.add(w); wheels.push(w);
      const tyre = new T.Mesh(new T.TorusGeometry(R - 0.014, 0.014, 8, 40), M.tyre); tyre.rotation.y = Math.PI / 2; w.add(tyre);
      const rim = new T.Mesh(new T.TorusGeometry(R - 0.04, 0.012, 6, 40), M.rim); rim.rotation.y = Math.PI / 2; w.add(rim);
      const spokes = [];
      for (let k = 0; k < 18; k++) { const a = (k / 18) * Math.PI * 2; spokes.push(0, 0, 0, 0, Math.cos(a) * (R - 0.05), Math.sin(a) * (R - 0.05)); }
      const sg = new T.BufferGeometry(); sg.setAttribute('position', new T.Float32BufferAttribute(spokes, 3));
      w.add(new T.LineSegments(sg, new T.LineBasicMaterial({ color: 0x9aa1aa })));
      const hub = new T.Mesh(new T.CylinderGeometry(0.025, 0.025, 0.1, 8), M.steel); hub.rotation.z = Math.PI / 2; w.add(hub);
    }
    const tube = (a, b, r, m = M.frame) => limb(add(unitCyl(r, r, 8), m), a, b);
    tube(BB, SEAT.clone().lerp(BB, 0.1), 0.017);          // seat tube
    tube(SEAT.clone().lerp(BB, 0.12), HEAD_TOP, 0.016);   // top tube
    tube(BB, HEAD_LOW, 0.022);                            // down tube
    tube(HEAD_LOW, HEAD_TOP, 0.022);                      // head tube
    for (const x of [-0.05, 0.05]) {
      tube(BB.clone().setX(x * 0.6), REAR.clone().setX(x), 0.011);                       // chainstays
      tube(SEAT.clone().lerp(BB, 0.14).setX(x * 0.4), REAR.clone().setX(x), 0.01);      // seatstays
      tube(HEAD_LOW.clone().setX(x * 0.4), FRONT.clone().setX(x), 0.012);                // fork
    }
    tube(HEAD_TOP, BAR, 0.015, M.dark);                   // stem
    tube(V(-0.21, 0.88, -0.47), V(0.21, 0.88, -0.47), 0.013, M.dark); // bars
    for (const x of [-0.2, 0.2]) {
      tube(V(x, 0.88, -0.47), V(x, 0.84, -0.56), 0.013, M.dark);       // reach to the drops
      tube(V(x, 0.84, -0.56), V(x, 0.74, -0.52), 0.013, M.dark);
    }
    const saddle = add(new T.BoxGeometry(0.13, 0.04, 0.27), M.saddle); saddle.position.copy(SEAT).add(V(0, 0.02, 0.0));
    tube(SEAT.clone().lerp(BB, 0.1), SEAT, 0.013, M.steel); // seat post
    const ring = add(new T.TorusGeometry(0.1, 0.008, 6, 30), M.steel); ring.rotation.y = Math.PI / 2; ring.position.copy(BB).setX(0.05);
    const cranks = [add(unitCyl(0.012, 0.012, 6), M.steel), add(unitCyl(0.012, 0.012, 6), M.steel)];
    const pedals = [add(new T.BoxGeometry(0.09, 0.015, 0.06), M.dark), add(new T.BoxGeometry(0.09, 0.015, 0.06), M.dark)];

    // ---- Rider.
    const THIGH = 0.45, SHIN = 0.44, UPPER = 0.29, FORE = 0.28;
    const legs = [-1, 1].map(() => ({
      thigh: add(unitCyl(0.075, 0.058), M.bib), shin: add(unitCyl(0.052, 0.038), M.skin),
      sock: add(unitCyl(0.04, 0.038), M.sock), knee: add(new T.SphereGeometry(0.057, 10, 8), M.skin), shoe: add(new T.BoxGeometry(0.08, 0.06, 0.25), M.shoe),
    }));
    const arms = [-1, 1].map(() => ({
      upper: add(unitCyl(0.05, 0.043), M.jersey), fore: add(unitCyl(0.04, 0.032), M.skin),
      elbow: add(new T.SphereGeometry(0.043, 8, 6), M.skin), hand: add(new T.SphereGeometry(0.038, 8, 6), M.dark),
    }));
    const pelvis = add(new T.SphereGeometry(0.15, 14, 10), M.bib); pelvis.scale.set(1.15, 0.8, 1);
    const torso = add(unitCyl(0.15, 0.135, 14), M.jersey);
    const stripe = add(unitCyl(0.152, 0.137, 14), M.jersey2); // dark band round the waist
    const shoulders = add(new T.SphereGeometry(0.12, 12, 8), M.jersey); shoulders.scale.set(1.9, 0.75, 1);
    const neck = add(unitCyl(0.05, 0.05, 8), M.skin);
    const head = add(new T.SphereGeometry(0.105, 16, 12), M.skin); head.scale.set(0.95, 1.05, 1.1);
    const helmet = add(new T.SphereGeometry(0.135, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), M.helmet); helmet.scale.set(0.95, 0.9, 1.3);
    const visor = add(new T.BoxGeometry(0.17, 0.035, 0.06), M.visor);

    // Two-bone IK: from a towards b with lengths l1, l2, bending towards `pole`.
    const ik = (a, b, l1, l2, pole, out) => {
      const d = tmpV.subVectors(b, a), dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, d.length()));
      const dir = d.normalize().clone(), along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
      const side = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
      return out.copy(a).addScaledVector(dir, along).addScaledVector(side, h);
    };
    const KNEE_POLE = V(0, 0.3, -1).normalize(), ELBOW_POLE = V(0, -0.3, 1).normalize();
    const hip = V(), shoulder = V(), j = V(), foot = V(), toe = V(), hand = V(), sh = V(), lift = V();

    function pose(pedal, climb, roll) {
      for (const w of wheels) w.rotation.x -= roll;
      // Seated hips on the saddle; standing, they rise and come forward over the cranks.
      const hipC = V(0, 1.0 + 0.13 * climb, 0.28 - 0.2 * climb);
      const shC = V(0, 1.33 + 0.12 * climb, -0.2 - 0.08 * climb);
      limb(torso, hipC, shC); torso.scale.x = 1.2; torso.scale.z = 0.85;
      limb(stripe, hipC, hipC.clone().lerp(shC, 0.18)); stripe.scale.x = 1.21; stripe.scale.z = 0.86;
      pelvis.position.copy(hipC).add(V(0, 0.02, 0.02));
      shoulders.position.copy(shC); shoulders.lookAt(shC.clone().sub(hipC).add(shC));
      const neckTop = shC.clone().add(V(0, 0.09, -0.12));
      limb(neck, shC, neckTop);
      head.position.copy(neckTop).add(V(0, 0.08, -0.06));
      helmet.position.copy(head.position).add(V(0, 0.03, 0.01)); helmet.rotation.x = -0.25;
      visor.position.copy(head.position).add(V(0, 0.07, -0.15));
      [0, 1].forEach(k => {
        const sgn = k ? 1 : -1, a = pedal + (k ? Math.PI : 0);
        // Crank and pedal.
        const pd = V(sgn * 0.09, BB.y + Math.cos(a) * 0.17, BB.z - Math.sin(a) * 0.17);
        limb(cranks[k], BB.clone().setX(sgn * 0.075), pd);
        pedals[k].position.copy(pd).setX(sgn * 0.11);
        // Leg: hip -> knee -> ankle just above the pedal.
        hip.copy(hipC).setX(sgn * 0.1);
        foot.copy(pd).setX(sgn * 0.1).add(lift.set(0, 0.07, 0.02));
        ik(hip, foot, THIGH, SHIN, KNEE_POLE, j);
        const L = legs[k];
        limb(L.thigh, hip, j); L.knee.position.copy(j);
        limb(L.shin, j, foot);
        limb(L.sock, foot.clone().lerp(j, 0.18), foot);
        L.shoe.position.copy(pd).setX(sgn * 0.1).add(V(0, 0.04, -0.03));
        L.shoe.rotation.x = 0.15 - Math.sin(a) * 0.25; // ankle follows the stroke a little
        // Arm: shoulder -> elbow -> hands on the hoods.
        sh.copy(shC).setX(sgn * 0.19);
        hand.set(sgn * 0.2, 0.92, -0.5);
        ik(sh, hand, UPPER, FORE, ELBOW_POLE.clone().setX(sgn * 0.5).normalize(), j);
        const A = arms[k];
        limb(A.upper, sh, j); A.elbow.position.copy(j); limb(A.fore, j, hand); A.hand.position.copy(hand);
      });
    }
    pose(0, 0, 0);
    return { root, pose };
  }

  const VIEWS = {
    chase: { back: 7, ahead: 14, up: 2.6, look: 1.1, side: 0 },
    close: { back: 3.2, ahead: 6, up: 1.55, look: 1.0, side: 0 },
    side: { back: -0.6, ahead: 0.4, up: 1.0, look: 0.9, side: 3.6 },
  };

  function mount(container, getState) {
    let renderer;
    try { renderer = new T.WebGLRenderer({ antialias: true }); }
    catch (e) { throw new Error('This browser cannot draw 3D here (WebGL is off).'); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    container.prepend(renderer.domElement);
    const scene = new T.Scene();
    const photoDome = photoSky(renderer), haze = photoDome ? new T.Color().fromArray(window.IW_PHOTOS.haze) : new T.Color(HAZE);
    scene.background = photoDome ? haze : new T.Color(SKY);
    // Haze that thickens with distance but never quite hides the land, so the
    // far edge of the land and the mountains behind it share one tone.
    scene.fog = new T.FogExp2(haze, 0.0023);
    scene.add(new T.HemisphereLight(photoDome ? 0xc9d3e2 : 0xd3e3f5, 0x5d5440, 0.62));
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
    const dome = photoDome || sky(); scene.add(dome);
    const camera = new T.PerspectiveCamera(62, 1, 0.2, FAR);
    const bike = rider(); scene.add(bike.root);
    bike.root.traverse(o => { if (o.isMesh) o.castShadow = true; });
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
    let pieces = [], paintTick = 0, job = null;
    const grassPhoto = photo('grass', renderer), grain = grassPhoto ? { photo: true, grass: grassPhoto, soil: photo('dirt', renderer) } : { grass: surface('grass', renderer) };
    const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    let built = null, world = null, disp = 0, last = performance.now(), pedal = 0, raf = 0, running = false, climb = 0, view = 'chase', tiles = [], tileMat = null, sortedAt = null, sky2 = null, drift = 0;
    const camPos = new T.Vector3(), camLook = new T.Vector3(), tmp = new T.Vector3(), ahead = new T.Vector3();

    function setRoute(route) {
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
      const g = geometryOf(route);
      world.userData.g = g;
      // Built in pieces of CHUNK points (600 m) so the ones behind the rider
      // or past the fog are skipped instead of drawn every frame.
      const tarmac = photo('asphalt', renderer);
      tarmac?.repeat.set(2, 2); // a 2 m tile
      const asphalt = new T.MeshLambertMaterial({ color: 0x4a4e55, map: tarmac || surface('road', renderer) });
      const paint = new T.MeshLambertMaterial({ color: 0xf2f4f6 });
      const land = grained(new T.MeshLambertMaterial({ vertexColors: true }), grain); // until a piece's paint is in
      const seed = Math.round(route.total) + route.res.length;
      scatter = []; pieces = []; job = null;
      const sc = sceneryOf(route);
      woodsAt = route.scenery?.woods || [0, 0];
      world.userData.sc = sc;
      if (!sky2 && !photoDome) scene.add((sky2 = clouds())); // the photographed sky has its own
      world.add(props(g, sc));
      const avoid = (x, z, i) => sc.clearings.some(([a, b]) => i * STEP >= a && i * STEP <= b);
      for (let s = 0; s < g.n - 1; s += CHUNK) {
        const e = Math.min(g.n - 1, s + CHUNK);
        const strip = (from, to, lift, mat, keep) => { const m = new T.Mesh(ribbon(g, s, e, from, to, lift, keep), mat); m.receiveShadow = true; world.add(m); };
        strip(-ROAD_HALF, ROAD_HALF, 0.02, asphalt);
        strip(-ROAD_HALF + 0.25, -ROAD_HALF + 0.4, 0.04, paint);
        strip(ROAD_HALF - 0.4, ROAD_HALF - 0.25, 0.04, paint);
        strip(-0.07, 0.07, 0.04, paint, i => i % 2 === 0); // dashed centre line
        const strip0 = nearLand(g, s, e, land);
        world.add(strip0); pieces.push(strip0);
        const t = trees(g, s, e, seed + s, avoid);
        world.add(...t); scatter.push(...t);
      }
      // The far land is built a few tiles per frame, nearest first, so a long
      // route shows at once instead of freezing the page for a second or two.
      tiles = landTiles(g); tileMat = land; sortedAt = null;
      world.add(kmSigns(g, route.total));
      scene.add(world);
      disp = getState().dist;
      camPos.set(0, 0, 0); camLook.set(0, 0, 0);
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
          if (!want) { if (u.mpp) unpaint(m); continue; }
          if ((!u.mpp || want < u.mpp) && (!best || d < best.d) && job?.m !== m) best = { m, d, want };
        }
        if (best && (!job || best.d < job.d - 100)) job = { ...best, gen: paintLand(world.userData.g, best.m, best.want) };
      }
      for (const t0 = performance.now(); job && performance.now() - t0 < 4;) {
        const r = job.gen.next();
        if (!r.done) continue;
        const m = job.m, tex = new T.CanvasTexture(r.value);
        tex.anisotropy = maxAniso;
        unpaint(m);
        m.material = grained(new T.MeshLambertMaterial({ map: tex }), grain);
        m.userData.mpp = job.want;
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
    }
    const ro = new ResizeObserver(resize); ro.observe(container);

    function frame(now) {
      raf = running ? requestAnimationFrame(frame) : 0;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const s = getState();
      if (s.route !== built) setRoute(s.route);
      if (!built) return;
      if (tiles.length) {
        // Nearest to the rider first; sorted again after he has moved on 300 m (or jumped).
        const here = at(disp, new T.Vector3());
        if (!sortedAt || sortedAt.distanceTo(here) > 300) {
          sortedAt = here;
          for (const t of tiles) t.d = Math.hypot(t.x - here.x, t.z - here.z);
          tiles.sort((p, q) => p.d - q.d);
        }
        for (const t0 = performance.now(); tiles.length && performance.now() - t0 < 6;) { const m = tiles.shift().build(tileMat); world.add(m); pieces.push(m); }
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
      climb += ((grade > 0.06 ? Math.min(1, (grade - 0.06) / 0.03) : 0) - climb) * Math.min(1, dt * 2);
      bike.root.rotation.set(0, heading, 0); bike.root.rotateX(pitch); // the model faces -z
      bike.root.rotateZ(Math.sin(pedal) * 0.09 * climb);
      bike.pose(pedal, climb, (s.speed / 0.34) * dt);
      // Chase camera: behind and above, looking down the road. It only tilts a
      // third of the way with the road, so a climb rises up the screen ahead of
      // the rider (and a descent drops away) instead of the horizon tilting with it.
      // Other views: close behind the rider, or from the roadside next to him.
      const v = VIEWS[view];
      const back = at(disp - v.back, new T.Vector3()), look = at(disp + v.ahead, new T.Vector3());
      const lookY = back.y + v.look + (look.y - back.y) / 3;
      const wantPos = back.add(right).addScaledVector(right, v.side / KEEP).add(new T.Vector3(0, v.up, 0)), wantLook = look.add(right).setY(lookY);
      const k = camPos.lengthSq() ? Math.min(1, dt * 4) : 1;
      camPos.lerp(wantPos, k); camLook.lerp(wantLook, k);
      camera.position.copy(camPos); camera.lookAt(camLook);
      const g = world.userData.g;
      if ((scatterTick -= dt) <= 0) {
        scatterTick = 0.3;
        for (const m of scatter) { const c = m.geometry.boundingSphere.center; m.visible = Math.hypot(c.x - camPos.x, c.z - camPos.z) < FAR - 50 + m.geometry.boundingSphere.radius * 0.6; }
      }
      tuft.wind.value += dt;
      const gi = Math.floor(disp / STEP);
      if (gi !== grassAt) { grassAt = gi; plantGrass(g, gi); }
      dome.position.copy(camPos);
      sun.target.position.copy(pos); sun.position.copy(pos).addScaledVector(SUN_DIR, 200);
      hills0.position.set(camPos.x, g.base[0] + (camPos.y - g.base[0]) * 0.85, camPos.z);
      if (sky2) { drift += dt * 1.5; sky2.position.set(camPos.x * 0.9 + drift, hills0.position.y, camPos.z * 0.9); }
      renderer.render(scene, camera);
    }

    return {
      start() { if (running) return; running = true; last = performance.now(); resize(); raf = requestAnimationFrame(frame); },
      stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
      get canvas() { return renderer.domElement; },
      get view() { return view; },
      set view(v) { if (VIEWS[v] && v !== view) { view = v; camPos.set(0, 0, 0); } },
      get info() { return renderer.info.render; },
      get scenery() { return built && world.userData.sc; }, // where the gantries and flags went
    };
  }

  window.World3D = { mount };
})();
