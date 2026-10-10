// IndoorWarior free ride: start on any road on earth and ride where you like,
// choosing left, right, straight on or back at every junction.
// A classic script (window.IW_ROAM), so it also works from a file.
//
// The road network comes from OpenStreetMap a square of land at a time
// (places.js area()), with the land's heights from the same terrain tiles
// the 3D view uses. What you ride is an ordinary route (the same shape as a
// GPX route: points every 10 m with a height) that grows as you go: up to the
// next junction, and on through it the way you picked once you are close.
// A U-turn cuts it where you are and sends it back the way you came.
(function () {
  const STEP = 10;          // m between route points (ROUTE_STEP in index.html)
  const RAD = 3000;         // m, half the side of the square of map loaded at a time
  const MOVE = 1600;        // m from that square's middle before the next one loads
  const COMMIT = 45;        // m before a junction where the way you picked is taken
  const AHEAD = 2500;       // m of road taken in one go when there is no junction
  const M_PER_DEG = 111320;

  // Roads a bike may use. Footpaths and bridleways only where bikes are
  // allowed; nothing private, nothing marked no bikes, no motorways.
  const MAIN = /^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road|track|cycleway|busway)$/;
  function rideable(t) {
    const ok = t.bicycle === 'yes' || t.bicycle === 'designated' || t.bicycle === 'permissive';
    if (/^(path|footway|bridleway)$/.test(t.highway)) return ok;
    if (!MAIN.test(t.highway) || t.bicycle === 'no' || t.bicycle === 'use_sidepath' || t.area === 'yes' || t.motorroad === 'yes') return false;
    if (/^(private|no)$/.test(t.access || '') && !ok) return false;
    if (t.highway === 'service' && /^(parking_aisle|driveway|drive-through)$/.test(t.service || '')) return false;
    return true;
  }
  // How a road is drawn beside the route: its half-width and surface.
  function kindOf(t) {
    const h = t.highway || '';
    const dirt = h === 'track' || /^(gravel|dirt|ground|grass|unpaved|compacted|fine_gravel|earth|mud|sand)$/.test(t.surface || '');
    const half = /^(trunk|primary|secondary)/.test(h) ? 3.2 : /^(tertiary|unclassified|road)/.test(h) ? 2.8 : h === 'track' || /^(path|footway|bridleway|cycleway)$/.test(h) ? 1.4 : 2.4;
    return { half, dirt };
  }
  const nameOf = t => t.name || t.ref || '';

  const rad = d => (d * Math.PI) / 180;
  const metres = (a, b) => { const k = Math.cos(rad((a.lat + b.lat) / 2)); return Math.hypot((b.lat - a.lat) * 110540, (b.lon - a.lon) * M_PER_DEG * k); };
  const bearing = (a, b) => Math.atan2((b.lon - a.lon) * Math.cos(rad(a.lat)), b.lat - a.lat); // 0 north, + east
  const turnOf = (inB, outB) => { let t = outB - inB; t = Math.atan2(Math.sin(t), Math.cos(t)); return (t * 180) / Math.PI; }; // + right, - left

  // ---- The road network: nodes joined by straight edges, from every square
  // loaded so far. A node is known completely (all its roads) only inside a
  // loaded square; outside one, a road may carry on that is not here yet.
  function network() {
    const nodes = new Map(), seen = new Set(), boxes = [];
    function add(roads, box) {
      boxes.push(box);
      for (const r of roads) {
        if (seen.has(r.id) || !rideable(r.tags)) continue;
        seen.add(r.id);
        const way = { id: r.id, name: nameOf(r.tags), kind: kindOf(r.tags), level: r.tags.bridge && r.tags.bridge !== 'no' ? 'bridge' : r.tags.tunnel && r.tags.tunnel !== 'no' ? 'tunnel' : '', line: r.line, oneway: r.tags.oneway };
        let prev = null;
        r.nodes.forEach((id, k) => {
          const [lat, lon] = r.line[k];
          let n = nodes.get(id);
          if (!n) nodes.set(id, (n = { id, lat, lon, adj: [] }));
          if (prev && prev !== n) { prev.adj.push({ to: n, way }); n.adj.push({ to: prev, way }); }
          prev = n;
        });
      }
    }
    const inside = n => boxes.some(([s, w, nn, e]) => n.lat > s + 0.0005 && n.lat < nn - 0.0005 && n.lon > w + 0.0007 && n.lon < e - 0.0007);
    // The nearest point on any road to a spot: its edge and where along it.
    function snap(lat, lon, within) {
      const k = Math.cos(rad(lat));
      let best = null;
      for (const a of nodes.values()) {
        if (Math.abs(a.lat - lat) * 110540 > within + 2000) continue;
        for (const { to: b, way } of a.adj) {
          if (a.id > b.id) continue;
          const ax = (a.lon - lon) * M_PER_DEG * k, az = (a.lat - lat) * 110540, bx = (b.lon - lon) * M_PER_DEG * k, bz = (b.lat - lat) * 110540;
          const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, -(ax * dx + az * dz) / l2));
          const d = Math.hypot(ax + dx * t, az + dz * t);
          if (d < within && (!best || d < best.d)) best = { a, b, t, d, way, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
        }
      }
      return best;
    }
    // Roads near a spot, as lines with their kind, for drawing.
    function linesNear(lat, lon, r) {
      const out = [], k = Math.cos(rad(lat)), dlat = r / 110540, dlon = r / (M_PER_DEG * k);
      const done = new Set();
      for (const n of nodes.values()) {
        if (Math.abs(n.lat - lat) > dlat || Math.abs(n.lon - lon) > dlon) continue;
        for (const { way } of n.adj) if (!done.has(way.id)) { done.add(way.id); out.push(way); }
      }
      return out;
    }
    return { nodes, add, inside, snap, linesNear };
  }

  // A point a few tens of metres along a branch, for its direction (the first
  // node can be a metre away).
  function along(from, to, want) {
    let prev = from, cur = to, d = metres(from, to);
    while (d < want) {
      const next = cur.adj.length === 2 ? cur.adj.find(e => e.to !== prev) : null;
      if (!next) break;
      d += metres(cur, next.to); prev = cur; cur = next.to;
    }
    return cur;
  }

  // ---- A free ride from a spot. Resolves once the first square of map and
  // heights are in and the route has its first stretch of road.
  async function start(lat, lon, { onState } = {}) {
    const P = window.IW_PLACES;
    if (!P?.area) throw new Error('The map code did not load.');
    const net = network();
    const rec = { v: 0, area: 0, osm: null, near: null, far: null, sat: null, aerial: P.aerial ? P.aerial(window.IW_ESRI_KEY || '') : null, roam: true };
    let centre = null, loading = null, demFns = [];
    const dem = (la, lo) => { for (const f of demFns) { const h = f(la, lo); if (Number.isFinite(h)) return h; } return NaN; };

    // One square of land: roads, map, heights (near and far) and the satellite
    // photo. Merged into what is there, newest first, keeping the last two.
    async function loadSquare(la, lo) {
      const k = Math.cos(rad(la)), dl = RAD / 110540, dn = RAD / (M_PER_DEG * k);
      const box = [la - dl, lo - dn, la + dl, lo + dn], pts = [[la, lo]];
      const [map, near, far, sat] = await Promise.all([
        P.area(box, [la, lo]),
        P.terrain(pts, RAD * 1.42, [13, 12], 160),
        P.terrain(pts, 42000, [11, 10, 9, 8], 80).catch(() => null),
        P.imagery ? P.imagery(pts, RAD * 1.42, [14, 13], 220).catch(e => ({ err: e })) : null,
      ]);
      net.add(map.roads, box);
      const keep = rec.squares ? rec.squares.slice(-1) : [];
      const sq = { box, lat: la, lon: lo, osm: map, near, far, sat: sat && !sat.err ? sat : null, satErr: sat?.err?.message };
      rec.squares = keep.concat(sq);
      const newest = rec.squares.slice().reverse();
      const first = (pick, out) => { for (const s of newest) { const f = pick(s); if (f && f(...out)) return true; } return false; };
      demFns = newest.map(s => s.near);
      rec.near = Object.assign((a, b) => dem(a, b), { zoom: near.zoom });
      const farFns = newest.map(s => s.far).filter(Boolean);
      rec.far = farFns.length ? (a, b) => { for (const f of farFns) { const h = f(a, b); if (Number.isFinite(h)) return h; } return NaN; } : null;
      rec.sat = newest.some(s => s.sat) ? (a, b, out) => first(s => s.sat, [a, b, out]) : null;
      rec.satErr = rec.sat ? null : sq.satErr || null;
      rec.osm = mergeOsm(newest.map(s => s.osm));
      rec.bounds = rec.squares.map(s => s.box);
      rec.area++;
      centre = { lat: la, lon: lo };
      return sq;
    }

    onState?.('Loading the roads and the land round there…');
    await loadSquare(lat, lon);
    const s0 = net.snap(lat, lon, 400);
    if (!s0) throw new Error('There is no road a bike can use within 400 m of that spot. Pick a spot on a road.');
    rec.v = 3; // everything the 3D view waits for is in

    // ---- The route: points every STEP m with heights, grown as you ride.
    // raw: the line ridden (corners at the nodes), with distance along it.
    const raw = [];   // { lat, lon, d, level }
    const res = [];   // { d, lat, lon, ele } every STEP m
    const eleRaw = [];
    const level = [];
    const route = { name: s0.way.name ? `Anywhere: ${s0.way.name}` : 'Anywhere', res, climb: [0], total: 0, loop: false, ver: 0, changedFrom: 0 };
    // What is ahead: the last node taken and the one before it (the way in).
    let end = null, sel = 0, opts = [];
    const segs = []; // the road under each stretch: { d0, a, b } (a behind, b ahead)

    const push = (p, lvl) => {
      const last = raw[raw.length - 1];
      const d = last ? last.d + metres(last, p) : 0;
      if (last && d - last.d < 0.05) return;
      raw.push({ lat: p.lat, lon: p.lon, d, level: lvl || '' });
    };
    // Sample the line every STEP m from where the points stop, then heights.
    function resample(fromRes) {
      res.length = fromRes; eleRaw.length = fromRes; level.length = fromRes;
      let j = 0;
      const total = raw[raw.length - 1].d;
      for (let k = fromRes; k * STEP <= total; k++) {
        const d = k * STEP;
        while (j < raw.length - 2 && raw[j + 1].d < d) j++;
        if (raw[j].d > d) j = Math.max(0, raw.findIndex(r => r.d > d) - 1);
        const a = raw[j], b = raw[Math.min(j + 1, raw.length - 1)], f = Math.min(1, Math.max(0, (d - a.d) / ((b.d - a.d) || 1)));
        const p = { d, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, ele: 0 };
        res.push(p); eleRaw.push(dem(p.lat, p.lon)); level.push(b.level);
      }
      // Bridges and tunnels: straight across from one end to the other, not
      // down into the valley or up over the hill the terrain has there.
      for (let i = Math.max(0, fromRes - 60); i < res.length; i++) {
        if (!level[i]) continue;
        let e = i; while (e < res.length && level[e]) e++;
        const a = Math.max(0, i - 1), b = Math.min(res.length - 1, e);
        for (let q = i; q < e; q++) eleRaw[q] = eleRaw[a] + ((eleRaw[b] - eleRaw[a]) * (q - a)) / ((b - a) || 1);
        i = e;
      }
      for (let i = 0; i < res.length; i++) if (!Number.isFinite(eleRaw[i])) eleRaw[i] = i ? eleRaw[i - 1] : 0;
      // Smooth over about 100 m, as a GPX route is.
      const from = Math.max(0, fromRes - 6);
      for (let i = from; i < res.length; i++) {
        let s = 0, n = 0;
        for (let k = Math.max(0, i - 5); k <= Math.min(res.length - 1, i + 5); k++) { s += eleRaw[k]; n++; }
        res[i].ele = s / n;
      }
      route.climb.length = Math.max(1, from);
      for (let i = Math.max(1, from); i < res.length; i++) route.climb.push(route.climb[i - 1] + Math.max(0, res[i].ele - res[i - 1].ele));
      route.total = res[res.length - 1].d;
      route.changedFrom = Math.min(route.changedFrom, from);
      route.ver++;
    }

    // The ways on from the node ahead, left to right, and which one is picked.
    function options() {
      if (!end) return [];
      const inB = bearing(end.from, end.node);
      const out = end.node.adj.filter(e => e.to !== end.from).map(e => ({ ...e, turn: turnOf(inB, bearing(end.node, along(end.node, e.to, 25))) }));
      out.sort((p, q) => p.turn - q.turn);
      return out;
    }
    function straightest(list, wayIn) {
      let best = 0, score = Infinity;
      list.forEach((o, k) => { const s = Math.abs(o.turn) - (wayIn && o.way.name && o.way.name === wayIn.name ? 25 : 0); if (s < score) { score = s; best = k; } });
      return best;
    }
    // Take road from the node ahead: the picked way, then on through every
    // node with no choice until the next junction (or AHEAD m, or the edge
    // of the map loaded so far).
    function take(choice) {
      let wayIn = end.way, taken = 0;
      for (let first = true; ; first = false) {
        if (!net.inside(end.node)) return false; // its roads are not all here yet
        const list = options();
        let o;
        if (!list.length) o = end.node.adj.find(e => e.to === end.from) || end.node.adj[0]; // a dead end: back the way you came
        else if (list.length === 1) o = list[0];
        else if (first && choice) o = choice;
        else return true; // a junction: wait for the rider's pick
        if (!o) return false;
        segs.push({ d0: raw[raw.length - 1].d, a: end.node, b: o.to });
        push(o.to, o.way.level);
        taken += metres(end.node, o.to);
        end = { node: o.to, from: end.node, way: o.way };
        wayIn = o.way;
        if (taken > AHEAD) return true;
      }
    }
    // The first stretch: from the spot on the road, along it whichever way
    // it runs on further before a junction.
    push({ lat: s0.lat, lon: s0.lon }, s0.way.level);
    segs.push({ d0: 0, a: s0.a, b: s0.b });
    end = { node: s0.b, from: s0.a, way: s0.way };
    take(null);
    if (raw.length < 2) { push(s0.a); end = { node: s0.a, from: s0.b, way: s0.way }; take(null); }
    resample(0);
    refreshOptions();

    function refreshOptions() {
      opts = options();
      sel = opts.length > 1 ? straightest(opts, end.way) : 0;
    }

    // Called as you ride: loads the next square of map when you near the edge
    // of this one, and takes the way you picked as a junction comes close.
    function update(dist) {
      const here = res[Math.min(res.length - 1, Math.floor(dist / STEP))];
      if (!loading && centre && metres(here, centre) > MOVE) {
        loading = loadSquare(here.lat, here.lon).then(() => { if (opts.length < 2) grow(); }, e => { rec.loadErr = e.message || String(e); }).finally(() => { loading = null; });
      }
      if (route.total - dist < COMMIT || (opts.length < 2 && route.total - dist < AHEAD / 2)) grow();
    }
    function grow() {
      const before = res.length, n0 = raw.length;
      take(opts.length > 1 ? opts[sel] : null);
      if (raw.length === n0) return;
      resample(Math.max(0, before - 1));
      refreshOptions();
    }

    // Turn round where you are: the route stops here and goes back along the
    // road you are on, to the node behind you.
    function uTurn(dist) {
      dist = Math.max(0, Math.min(route.total, dist));
      let s = segs[0];
      for (const q of segs) if (q.d0 <= dist) s = q;
      const p = res[Math.min(res.length - 1, Math.round(dist / STEP))];
      const keep = raw.filter(r => r.d < p.d - 0.5);
      raw.length = 0; raw.push(...keep);
      push(p);
      while (segs.length && segs[segs.length - 1].d0 >= p.d) segs.pop();
      // Back towards the node behind (a), as if arriving from the one ahead (b).
      segs.push({ d0: raw[raw.length - 1].d, a: s.b, b: s.a });
      push(s.a);
      end = { node: s.a, from: s.b, way: s.a.adj.find(e => e.to === s.b)?.way || end.way };
      take(null);
      resample(Math.max(0, Math.floor(p.d / STEP)));
      refreshOptions();
    }

    // The junction ahead, for the view: how far, the ways on and which is picked.
    function next(dist) {
      if (opts.length < 2) return null;
      return { dist: route.total - dist, sel, options: opts.map(o => ({ turn: o.turn, name: o.way.name })) };
    }
    const pick = k => { if (opts.length > 1) sel = Math.max(0, Math.min(opts.length - 1, k)); };

    route.roam = {
      rec, net, update, uTurn, next,
      left() { pick(sel - 1); }, right() { pick(sel + 1); },
      straight() { if (opts.length > 1) sel = straightest(opts, end.way); },
      choose(k) { pick(k); },
      // Roads near a spot, for drawing beside the route.
      roadsNear: (la, lo, r) => net.linesNear(la, lo, r),
      get loading() { return !!loading; },
    };
    return route;
  }

  // Two squares' maps as one (the newer first). A wood or lake on both is in
  // both; drawn twice it comes out the same.
  function mergeOsm(list) {
    const out = { roads: [], water: [], rivers: [], woods: [], towns: [], fields: [], rock: [], glacier: [], buildings: [], places: [], passes: [], countries: {}, borders: [], start: list[list.length - 1]?.start ?? null };
    const once = new Set();
    for (const m of list) {
      for (const k of ['water', 'rivers', 'woods', 'towns', 'fields', 'rock', 'glacier', 'borders']) out[k].push(...m[k]);
      for (const b of m.buildings) { const key = b.ring[0].join(); if (!once.has(key)) { once.add(key); out.buildings.push(b); } }
      for (const p of m.places.concat(m.passes)) { const key = `${p.name}${p.lat}`; if (once.has(key)) continue; once.add(key); (p.kind ? out.places : out.passes).push(p); }
      Object.assign(out.countries, m.countries);
    }
    return out;
  }

  window.IW_ROAM = { start, rideable, STEP };
})();
