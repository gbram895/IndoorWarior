// IndoorWarior 3D view: rides a GPX route in three.js (r149, vendor/three.min.js,
// a classic script so it also works when index.html is opened as a file).
//
// The road follows the route's real shape and elevation. The land beside it is
// made up: rolling hills that rise away from the road, trees and a sign every
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
    const xz = raw.map((_, i) => {
      let x = 0, z = 0, c = 0;
      for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) { x += raw[j][0]; z += raw[j][1]; c++; }
      return [x / c, z / c];
    });
    // Heights are drawn 1.6x steeper than they are. From a chase camera a true
    // 8% looks almost flat; this makes it read like the climb it feels like.
    // Only the picture: gradient, speed and the trainer use the real figures.
    const y = res.map(p => (p.ele - res[0].ele) * LIFT);
    // Right-hand side of the direction of travel, flat.
    const side = xz.map((_, i) => {
      const a = xz[Math.max(0, i - 1)], b = xz[Math.min(n - 1, i + 1)];
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

  // Greens that vary across the land, a little drier on high ground.
  function landColour(c, x, z, y, road, d) {
    const t = noise(x / 90, z / 90), dry = smooth(10, 40, y - road);
    if (d < 7) return c.setRGB(0.44, 0.5, 0.31); // verge
    return c.setRGB(0.3 + 0.12 * t + 0.16 * dry, 0.46 + 0.1 * t - 0.04 * dry, 0.22 + 0.05 * t);
  }

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
        uv.push(x / 5, z / 5);
        landColour(c, x, z, p.y, p.road, Math.abs(o));
        col.push(c.r, c.g, c.b);
      }
      if (r) {
        const w = OFF.length, a = (r - 1) * w, b = r * w;
        for (let j = 0; j < w - 1; j++) idx.push(a + j, a + j + 1, b + j, a + j + 1, b + j + 1, b + j);
      }
    }
    return landMesh(pos, col, uv, idx, mat);
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
        pos.push(x, y, z); uv.push(x / 5, z / 5);
        landColour(c, x, z, p.y, p.road, p.d); col.push(c.r, c.g, c.b);
        if (r && q) { const i0 = (r - 1) * (CELLS + 1) + q - 1, i1 = i0 + CELLS + 1; idx.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1); }
      }
      return landMesh(pos, col, uv, idx, mat);
    } }));
  }

  // Trees either side of points s..e-1, thicker away from the road, never on it at a bend.
  // `avoid(x, z, i)` is true where a tree must not stand (houses, an open summit).
  function trees(g, s, e, seed, kit, models, avoid) {
    const rand = rng(seed), spots = [];
    for (let i = s; i < e; i++) {
      for (const s of [-1, 1]) {
        if (rand() > 0.55) continue;
        const o = s * (10 + rand() ** 1.6 * 230);
        const p = groundY(g, i, o);
        let clear = !avoid(p.x, p.z, i);
        for (let j = Math.max(0, i - 40); j <= Math.min(g.n - 1, i + 40) && clear; j++) {
          if (Math.hypot(g.xz[j][0] - p.x, g.xz[j][1] - p.z) < ROAD_HALF + 5) clear = false;
        }
        if (clear) spots.push([p.x, p.y, p.z, 0.7 + rand() * 0.7, rand() * Math.PI, Math.floor(rand() * 1e6)]);
      }
    }
    if (!spots.length) return [];
    if (models) return kenneyTrees(spots, models);
    // three r149 culls instances by the bare tree shape at the origin, so each
    // piece gets a bounding sphere around its own trees.
    const box = new T.Box3(), pt = new T.Vector3();
    for (const [x, y, z] of spots) box.expandByPoint(pt.set(x, y, z));
    const sphere = box.getBoundingSphere(new T.Sphere()); sphere.radius += 12;
    const geo = base => { const c = base.clone(); c.boundingSphere = sphere.clone(); return c; };
    const trunk = new T.InstancedMesh(geo(kit.trunk), kit.bark, spots.length);
    const crown = new T.InstancedMesh(geo(kit.crown), kit.leaf, spots.length);
    const m = new T.Matrix4(), q = new T.Quaternion(), eu = new T.Euler(), sc = new T.Vector3(), v = new T.Vector3();
    const tint = new T.Color();
    spots.forEach(([x, y, z, s, r], k) => {
      q.setFromEuler(eu.set(0, r, 0)); sc.set(s, s, s);
      m.compose(v.set(x, y + 1.1 * s, z), q, sc); trunk.setMatrixAt(k, m);
      m.compose(v.set(x, y + (2.2 + 2.6) * s, z), q, sc); crown.setMatrixAt(k, m);
      crown.setColorAt(k, tint.setHSL(0.31 + (r % 0.06), 0.35, 0.2 + (s - 0.7) * 0.12));
    });
    trunk.castShadow = crown.castShadow = true;
    return [trunk, crown];
  }

  // ---- Kenney models (vendor/kenney-models.js, CC0): decoded once, shared by
  // every route. Each is one mesh painted from a small colour-map texture.
  function decode(str, Type) {
    const bin = atob(str), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Type(bytes.buffer);
  }
  let kenney = null;
  function kenneyModels() {
    if (kenney !== null) return kenney;
    kenney = false;
    const src = window.IW_MODELS;
    if (!src) return kenney;
    const mats = {};
    for (const [kit, url] of Object.entries(src.textures)) {
      const tex = new T.TextureLoader().load(url);
      tex.flipY = false; // left linear: sRGB made the houses dark navy
      mats[kit] = new T.MeshLambertMaterial({ map: tex });
    }
    const models = {};
    for (const [name, m] of Object.entries(src.models)) {
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(decode(m.pos, Float32Array), 3));
      geo.setAttribute('normal', new T.BufferAttribute(decode(m.nor, Float32Array), 3));
      geo.setAttribute('uv', new T.BufferAttribute(decode(m.uv, Float32Array), 2));
      geo.setIndex(new T.BufferAttribute(decode(m.idx, Uint16Array), 1));
      geo.computeBoundingBox();
      models[name] = { geo, mat: mats[m.kit], size: geo.boundingBox.getSize(new T.Vector3()) };
    }
    models.trees = Object.keys(models).filter(k => k.startsWith('tree-')).map(k => models[k]);
    models.houses = ['house-a', 'house-b', 'house-c', 'house-d', 'garage'].map(k => models[k]);
    return (kenney = models);
  }
  // A mesh of a shared model, marked so changing route never disposes it.
  function place(model, x, y, z, rotY, scale) {
    const m = new T.Mesh(model.geo, model.mat);
    m.position.set(x, y, z); m.rotation.y = rotY; m.scale.setScalar(scale);
    m.castShadow = m.receiveShadow = true; m.userData.shared = true;
    return m;
  }

  // Kenney trees, one instanced mesh per kind of tree in this piece, 5-11 m tall.
  function kenneyTrees(spots, models) {
    const byKind = new Map();
    for (const sp of spots) { const k = sp[5] % models.trees.length; byKind.get(k)?.push(sp) || byKind.set(k, [sp]); }
    const out = [], mtx = new T.Matrix4(), q = new T.Quaternion(), eu = new T.Euler(), sc = new T.Vector3(), v = new T.Vector3();
    for (const [k, list] of byKind) {
      const model = models.trees[k];
      const box = new T.Box3(), pt = new T.Vector3();
      for (const [x, y, z] of list) box.expandByPoint(pt.set(x, y, z));
      const geo = new T.BufferGeometry();
      for (const [name, attr] of Object.entries(model.geo.attributes)) geo.setAttribute(name, attr);
      geo.setIndex(model.geo.index);
      geo.boundingSphere = box.getBoundingSphere(new T.Sphere()); geo.boundingSphere.radius += 14;
      const mesh = new T.InstancedMesh(geo, model.mat, list.length);
      list.forEach(([x, y, z, s, r], n) => {
        const h = (5 + 4 * (s - 0.7) / 0.7) / model.size.y;
        q.setFromEuler(eu.set(0, r * 2, 0)); sc.set(h, h * (0.9 + (r % 0.2)), h);
        mtx.compose(v.set(x, y - 0.1, z), q, sc); mesh.setMatrixAt(n, mtx);
      });
      mesh.castShadow = true; mesh.userData.sharedParts = true;
      out.push(mesh);
    }
    return out;
  }

  // Houses along a stretch of road (d0..d1 m), both sides, fronts to the road.
  function village(g, d0, d1, rand, models, homes) {
    const group = new T.Group();
    for (const sideSign of [-1, 1]) {
      for (let d = d0 + rand() * 20; d < d1; d += 24 + rand() * 16) {
        if (rand() < 0.2) continue; // a gap now and then
        const i = Math.min(g.n - 2, Math.max(0, Math.round(d / STEP)));
        const model = models.houses[Math.floor(rand() * models.houses.length)];
        const size = 9 + rand() * 3, o = sideSign * (ROAD_HALF + 6 + size / 2 + rand() * 4);
        const x = g.xz[i][0] + g.side[i][0] * o, z = g.xz[i][1] + g.side[i][1] * o;
        // Sit on the lowest corner so no corner floats.
        let y = Infinity;
        for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) y = Math.min(y, groundAt(g, x + a * size / 2, z + b * size / 2).y);
        // The door is on the model's +x side: turn that side to the road.
        const ux = -g.side[i][0] * sideSign, uz = -g.side[i][1] * sideSign;
        const face = Math.atan2(-uz, ux);
        group.add(place(model, x, y - 0.2, z, face, size));
        homes.push([x, z, size * 0.75 + 4]);
      }
    }
    return group;
  }

  // Where the scenery goes. A built-in course says so itself; any other route
  // gets an arch at the start and the finish and a village every few
  // kilometres where the road runs straight and fairly flat for a while.
  function sceneryOf(route, g, seed) {
    const total = route.total, c = route.scenery;
    if (c) {
      const pos = d => (d < 0 ? total + d : d);
      return {
        arch: c.arch.map(pos), tents: (c.tents || []).map(([d, side]) => [pos(d), side]),
        villages: c.villages || [], flags: c.flags || [], clearings: c.clearings || [],
      };
    }
    const rand = rng(seed + 3), villages = [];
    for (let d = 1200 + rand() * 1500; d < total - 800; d += 2500 + rand() * 2500) {
      const len = 300 + rand() * 250;
      const i0 = Math.round(d / STEP), i1 = Math.min(g.n - 1, Math.round((d + len) / STEP));
      let ok = i1 > i0;
      for (let i = i0; i <= i1 && ok; i++) {
        if (Math.abs(g.bend[i]) > 1 / 120) ok = false;
        if (i > i0 && Math.abs(g.y[i] - g.y[i - 1]) / STEP / LIFT > 0.05) ok = false;
      }
      if (ok) villages.push([d, d + len]);
    }
    const arch = total > 400 ? [25, total - 25] : [25];
    return { arch, tents: [[60, 'left']], villages, flags: [], clearings: [] };
  }

  // A few flat clouds high up, drifting slowly. Like the mountains they stay
  // round the camera.
  function clouds(models) {
    const group = new T.Group(), rand = rng(99);
    const mat = new T.MeshLambertMaterial({ color: 0xffffff, emissive: 0xc8d0da, fog: false });
    for (let k = 0; k < 22; k++) {
      const a = rand() * Math.PI * 2, r = 220 + rand() * 380;
      const m = new T.Mesh(models.cloud.geo, mat);
      m.position.set(Math.cos(a) * r, 150 + rand() * 90, Math.sin(a) * r);
      m.scale.set(70 + rand() * 70, 14 + rand() * 10, 45 + rand() * 40);
      m.rotation.y = rand() * Math.PI;
      group.add(m);
    }
    return group;
  }

  // Start/finish arches, team tents and flags.
  function props(g, sc, models, total) {
    const group = new T.Group();
    const headingAt = i => { const a = g.xz[Math.max(0, i - 1)], b = g.xz[Math.min(g.n - 1, i + 1)]; return Math.atan2(b[0] - a[0], b[1] - a[1]); };
    const idx = d => Math.min(g.n - 1, Math.max(0, Math.round(d / STEP)));
    for (const d of sc.arch) {
      const i = idx(d), s = 0.72; // 14 m wide model over a 6 m road
      group.add(place(models.arch, g.xz[i][0], g.y[i], g.xz[i][1], headingAt(i), s));
    }
    for (const [d, side] of sc.tents) {
      const i = idx(d), sg = side === 'left' ? -1 : 1, o = sg * (ROAD_HALF + 7);
      const x = g.xz[i][0] + g.side[i][0] * o, z = g.xz[i][1] + g.side[i][1] * o;
      group.add(place(models.tents, x, groundAt(g, x, z).y + 0.05, z, headingAt(i), 1));
    }
    for (const [d0, d1] of sc.flags) {
      let k = 0;
      for (let d = d0; d < d1; d += 18, k++) {
        const i = idx(d), sg = k % 2 ? 1 : -1, o = sg * (ROAD_HALF + 1.2);
        const x = g.xz[i][0] + g.side[i][0] * o, z = g.xz[i][1] + g.side[i][1] * o;
        group.add(place(models.flag, x, groundAt(g, x, z).y, z, headingAt(i) + (sg > 0 ? Math.PI / 2 : -Math.PI / 2), 2.6));
      }
    }
    return group;
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

  // Mountains all round, past the fog, standing on a level line. They give the
  // eye a horizon that does not tilt with the road. Drawn first and behind
  // everything; they follow the camera sideways, and sink only a little as
  // the rider climbs, like real far-off hills.
  function mountains() {
    const group = new T.Group();
    for (const [r, top, colour, seed] of [[640, 0.75, 0xb3c4d2, 3.1], [600, 0.5, 0xa5b8bb, 7.7]]) {
      const N = 160, pos = [], idx = [];
      for (let k = 0; k <= N; k++) {
        const a = (k / N) * Math.PI * 2, h = 25 + top * (noise(Math.cos(a) * 3 + seed, Math.sin(a) * 3) * 140 + noise(Math.cos(a) * 9, Math.sin(a) * 9 + seed) * 40);
        pos.push(Math.cos(a) * r, -150, Math.sin(a) * r, Math.cos(a) * r, h, Math.sin(a) * r);
        if (k) { const b = (k - 1) * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      const m = new T.Mesh(geo, new T.MeshBasicMaterial({ color: colour, fog: false, side: T.DoubleSide, depthWrite: false, depthTest: false }));
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
    scene.background = new T.Color(SKY);
    // Haze that thickens with distance but never quite hides the land, so the
    // far edge of the land and the mountains behind it share one tone.
    scene.fog = new T.FogExp2(HAZE, 0.0023);
    scene.add(new T.HemisphereLight(0xdfeeff, 0x4a6b3a, 0.7));
    // The sun casts shadows in a 70 m square that travels with the rider:
    // enough for him, the bike and the nearest trees, cheap to draw.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const sun = new T.DirectionalLight(0xfff1dc, 0.95), SUN_DIR = new T.Vector3(-0.45, 0.75, 0.35).normalize();
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 400 });
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    const dome = sky(); scene.add(dome);
    const camera = new T.PerspectiveCamera(62, 1, 0.2, FAR);
    const bike = rider(); scene.add(bike.root);
    bike.root.traverse(o => { if (o.isMesh) o.castShadow = true; });
    const hills0 = mountains(); scene.add(hills0);

    let built = null, world = null, disp = 0, last = performance.now(), pedal = 0, raf = 0, running = false, climb = 0, view = 'chase', tiles = [], tileMat = null, sortedAt = null, sky2 = null, drift = 0;
    const camPos = new T.Vector3(), camLook = new T.Vector3(), tmp = new T.Vector3(), ahead = new T.Vector3();

    function setRoute(route) {
      if (world) {
        scene.remove(world);
        world.traverse(o => {
          if (o.userData.shared) return;                  // Kenney models are kept for the next route
          if (o.userData.sharedParts) { o.dispose(); return; }
          o.geometry?.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m?.map?.dispose(); m?.dispose(); });
        });
      }
      built = route; tiles = [];
      world = new T.Group();
      if (!route) return;
      const g = geometryOf(route);
      world.userData.g = g;
      // Built in pieces of CHUNK points (600 m) so the ones behind the rider
      // or past the fog are skipped instead of drawn every frame.
      const asphalt = new T.MeshLambertMaterial({ color: 0x4a4e55, map: surface('road', renderer) });
      const paint = new T.MeshLambertMaterial({ color: 0xf2f4f6 });
      const land = new T.MeshLambertMaterial({ vertexColors: true, map: surface('grass', renderer) });
      const kit = {
        trunk: new T.CylinderGeometry(0.18, 0.25, 2.2, 5), crown: new T.ConeGeometry(1.7, 5.5, 7),
        bark: new T.MeshLambertMaterial({ color: 0x5b4632 }), leaf: new T.MeshLambertMaterial({ color: 0x2f5a2e }),
      };
      const seed = Math.round(route.total) + route.res.length;
      const models = kenneyModels(), sc = sceneryOf(route, g, seed), homes = [];
      world.userData.sc = sc;
      if (models && !sky2) scene.add((sky2 = clouds(models)));
      if (models) {
        const rand = rng(seed + 7);
        for (const [d0, d1] of sc.villages) world.add(village(g, d0, d1, rand, models, homes));
        world.add(props(g, sc, models, route.total));
      }
      const within = (ranges, d) => ranges.some(([a, b]) => d >= a && d <= b);
      const avoid = (x, z, i) => {
        const d = i * STEP;
        if (within(sc.clearings, d)) return true;
        if (within(sc.villages, d) && Math.hypot(x - g.xz[i][0], z - g.xz[i][1]) < 45) return true;
        return homes.some(([hx, hz, r]) => Math.abs(hx - x) < r && Math.abs(hz - z) < r);
      };
      for (let s = 0; s < g.n - 1; s += CHUNK) {
        const e = Math.min(g.n - 1, s + CHUNK);
        const strip = (from, to, lift, mat, keep) => { const m = new T.Mesh(ribbon(g, s, e, from, to, lift, keep), mat); m.receiveShadow = true; world.add(m); };
        strip(-ROAD_HALF, ROAD_HALF, 0.02, asphalt);
        strip(-ROAD_HALF + 0.25, -ROAD_HALF + 0.4, 0.04, paint);
        strip(ROAD_HALF - 0.4, ROAD_HALF - 0.25, 0.04, paint);
        strip(-0.07, 0.07, 0.04, paint, i => i % 2 === 0); // dashed centre line
        world.add(nearLand(g, s, e, land));
        world.add(...trees(g, s, e, seed + s, kit, models, avoid));
      }
      kit.trunk.dispose(); kit.crown.dispose();
      // The far land is built a few tiles per frame, nearest first, so a long
      // route shows at once instead of freezing the page for a second or two.
      tiles = landTiles(g); tileMat = land; sortedAt = null;
      world.add(kmSigns(g, route.total));
      scene.add(world);
      disp = getState().dist;
      camPos.set(0, 0, 0); camLook.set(0, 0, 0);
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
        for (const t0 = performance.now(); tiles.length && performance.now() - t0 < 6;) world.add(tiles.shift().build(tileMat));
      }
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
      get scenery() { return built && world.userData.sc; }, // where the arches and villages went
    };
  }

  window.World3D = { mount };
})();
