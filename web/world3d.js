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
  const FOG_NEAR = 160, FOG_FAR = 650;
  const SKY = 0xbcd3e6;
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
    return { n, xz, y, side };
  }

  function groundY(g, i, o) {
    const x = g.xz[i][0] + g.side[i][0] * o, z = g.xz[i][1] + g.side[i][1] * o;
    return { x, z, y: g.y[i] - 0.12 + hillWeight(o) * hills(x, z) };
  }

  // A strip along the route between two side offsets, one quad per route point.
  // Points s..e (inclusive), so neighbouring pieces share their seam point.
  function ribbon(g, s, e, from, to, lift, keep) {
    const pos = [], idx = [];
    for (let i = s; i <= e; i++) {
      for (const o of [from, to]) pos.push(g.xz[i][0] + g.side[i][0] * o, g.y[i] + lift, g.xz[i][1] + g.side[i][1] * o);
      if (i > s && (!keep || keep(i))) { const a = (i - s - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } // counter-clockwise from above
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // Land either side for points s..e. Rows every second point; s and e are even
  // (or the last point), so pieces meet on the same row.
  function terrain(g, s, e, mat) {
    const OFF = [-700, -380, -200, -110, -60, -30, -14, -6, -3.2, 3.2, 6, 14, 30, 60, 110, 200, 380, 700];
    const rowsAt = [];
    for (let i = s; i < e; i += 2) rowsAt.push(i);
    rowsAt.push(e);
    const pos = [], col = [], idx = [], c = new T.Color();
    for (let r = 0; r < rowsAt.length; r++) {
      const i = rowsAt[r];
      for (const o of OFF) {
        const p = groundY(g, i, o);
        pos.push(p.x, p.y, p.z);
        // Greens that vary across the land, a little drier on high ground.
        const t = noise(p.x / 90, p.z / 90), dry = smooth(10, 40, p.y - g.y[i]);
        c.setRGB(0.24 + 0.1 * t + 0.12 * dry, 0.42 + 0.1 * t - 0.04 * dry, 0.2 + 0.04 * t);
        if (Math.abs(o) < 7) c.setRGB(0.36, 0.44, 0.26); // verge
        col.push(c.r, c.g, c.b);
      }
      if (r) {
        const w = OFF.length, a = (r - 1) * w, b = r * w;
        for (let j = 0; j < w - 1; j++) idx.push(a + j, a + j + 1, b + j, a + j + 1, b + j + 1, b + j);
      }
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return new T.Mesh(geo, mat);
  }

  // Trees either side of points s..e-1, thicker away from the road, never on it at a bend.
  function trees(g, s, e, seed, kit) {
    const rand = rng(seed), spots = [];
    for (let i = s; i < e; i++) {
      for (const s of [-1, 1]) {
        if (rand() > 0.55) continue;
        const o = s * (10 + rand() ** 1.6 * 230);
        const p = groundY(g, i, o);
        let clear = true;
        for (let j = Math.max(0, i - 40); j <= Math.min(g.n - 1, i + 40) && clear; j++) {
          if (Math.hypot(g.xz[j][0] - p.x, g.xz[j][1] - p.z) < ROAD_HALF + 5) clear = false;
        }
        if (clear) spots.push([p.x, p.y, p.z, 0.7 + rand() * 0.7, rand() * Math.PI]);
      }
    }
    if (!spots.length) return [];
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
    return [trunk, crown];
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

  // A simple low-poly rider: wheels, frame, body and pedalling legs.
  function rider() {
    const root = new T.Group();
    const dark = new T.MeshLambertMaterial({ color: 0x22252b });
    const jersey = new T.MeshLambertMaterial({ color: 0xff7a1a });
    const skin = new T.MeshLambertMaterial({ color: 0xe0b38f });
    const wheels = [];
    for (const z of [-0.52, 0.52]) {
      const w = new T.Mesh(new T.TorusGeometry(0.34, 0.035, 6, 20), dark);
      w.rotation.y = Math.PI / 2; w.position.set(0, 0.34, z);
      root.add(w); wheels.push(w);
    }
    const bar = (len, x, y, z, rx) => { const b = new T.Mesh(new T.BoxGeometry(0.04, 0.04, len), dark); b.position.set(x, y, z); b.rotation.x = rx; root.add(b); };
    bar(1.0, 0, 0.62, 0, -0.12);  // top tube
    bar(0.7, 0, 0.48, 0.12, 0.85); // down tube
    const torso = new T.Mesh(new T.BoxGeometry(0.36, 0.22, 0.62), jersey);
    torso.position.set(0, 1.12, -0.05); torso.rotation.x = -0.55; root.add(torso);
    const head = new T.Mesh(new T.SphereGeometry(0.13, 10, 8), skin);
    head.position.set(0, 1.32, -0.42); root.add(head);
    const helmet = new T.Mesh(new T.SphereGeometry(0.145, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), jersey);
    helmet.position.copy(head.position); helmet.position.y += 0.02; root.add(helmet);
    const legs = [];
    for (const x of [-0.11, 0.11]) {
      const leg = new T.Group();
      const thigh = new T.Mesh(new T.BoxGeometry(0.11, 0.48, 0.12), dark);
      thigh.position.y = -0.24; leg.add(thigh);
      leg.position.set(x, 0.92, 0.18);
      root.add(leg); legs.push(leg);
    }
    return { root, wheels, legs, torso, head, helmet };
  }

  function mount(container, getState) {
    let renderer;
    try { renderer = new T.WebGLRenderer({ antialias: true }); }
    catch (e) { throw new Error('This browser cannot draw 3D here (WebGL is off).'); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    container.prepend(renderer.domElement);
    const scene = new T.Scene();
    scene.background = new T.Color(SKY);
    scene.fog = new T.Fog(SKY, FOG_NEAR, FOG_FAR);
    scene.add(new T.HemisphereLight(0xdfeeff, 0x4a6b3a, 0.85));
    const sun = new T.DirectionalLight(0xfff4e0, 0.75); sun.position.set(-300, 500, 200); scene.add(sun);
    const camera = new T.PerspectiveCamera(62, 1, 0.2, FOG_FAR + 50);
    const bike = rider(); scene.add(bike.root);

    let built = null, world = null, disp = 0, last = performance.now(), pedal = 0, raf = 0, running = false, climb = 0;
    const camPos = new T.Vector3(), camLook = new T.Vector3(), tmp = new T.Vector3(), ahead = new T.Vector3();

    function setRoute(route) {
      if (world) { scene.remove(world); world.traverse(o => { o.geometry?.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m?.map?.dispose(); m?.dispose(); }); }); }
      built = route;
      world = new T.Group();
      if (!route) return;
      const g = geometryOf(route);
      world.userData.g = g;
      // Built in pieces of CHUNK points (600 m) so the ones behind the rider
      // or past the fog are skipped instead of drawn every frame.
      const asphalt = new T.MeshLambertMaterial({ color: 0x3b3e44 });
      const paint = new T.MeshBasicMaterial({ color: 0xe9ecef });
      const land = new T.MeshLambertMaterial({ vertexColors: true });
      const kit = {
        trunk: new T.CylinderGeometry(0.18, 0.25, 2.2, 5), crown: new T.ConeGeometry(1.7, 5.5, 7),
        bark: new T.MeshLambertMaterial({ color: 0x5b4632 }), leaf: new T.MeshLambertMaterial({ color: 0x2f5a2e }),
      };
      const seed = Math.round(route.total) + route.res.length;
      for (let s = 0; s < g.n - 1; s += CHUNK) {
        const e = Math.min(g.n - 1, s + CHUNK);
        world.add(new T.Mesh(ribbon(g, s, e, -ROAD_HALF, ROAD_HALF, 0.02), asphalt));
        world.add(new T.Mesh(ribbon(g, s, e, -ROAD_HALF + 0.25, -ROAD_HALF + 0.4, 0.04), paint));
        world.add(new T.Mesh(ribbon(g, s, e, ROAD_HALF - 0.4, ROAD_HALF - 0.25, 0.04), paint));
        world.add(new T.Mesh(ribbon(g, s, e, -0.07, 0.07, 0.04, i => i % 2 === 0), paint)); // dashed centre line
        world.add(terrain(g, s, e, land));
        world.add(...trees(g, s, e, seed + s, kit));
      }
      kit.trunk.dispose(); kit.crown.dispose();
      world.add(kmSigns(g, route.total));
      scene.add(world);
      disp = getState().dist;
      camPos.set(0, 0, 0); camLook.set(0, 0, 0);
    }

    // A point on the road at a distance, with its height.
    function at(d, out) {
      const g = world.userData.g, f = Math.min(g.n - 1.001, Math.max(0, d / STEP)), i = Math.floor(f), t = f - i;
      const a = g.xz[i], b = g.xz[i + 1];
      return out.set(a[0] + (b[0] - a[0]) * t, g.y[i] + (g.y[i + 1] - g.y[i]) * t, a[1] + (b[1] - a[1]) * t);
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
      bike.torso.position.set(0, 1.12 + 0.2 * climb, -0.05 - 0.12 * climb); bike.torso.rotation.x = -0.55 - 0.25 * climb;
      bike.head.position.set(0, 1.32 + 0.16 * climb, -0.42 - 0.08 * climb);
      bike.helmet.position.copy(bike.head.position); bike.helmet.position.y += 0.02;
      for (const l of bike.legs) l.position.y = 0.92 + 0.16 * climb;
      for (const w of bike.wheels) w.rotation.x -= (s.speed / 0.34) * dt;
      bike.legs[0].rotation.x = Math.sin(pedal) * 0.6; bike.legs[1].rotation.x = Math.sin(pedal + Math.PI) * 0.6;
      // Chase camera: behind and above, looking down the road. It only tilts a
      // third of the way with the road, so a climb rises up the screen ahead of
      // the rider (and a descent drops away) instead of the horizon tilting with it.
      const back = at(disp - 7, new T.Vector3()), look = at(disp + 14, new T.Vector3());
      const lookY = back.y + 1.1 + (look.y - back.y) / 3;
      const wantPos = back.add(right).add(new T.Vector3(0, 2.6, 0)), wantLook = look.add(right).setY(lookY);
      const k = camPos.lengthSq() ? Math.min(1, dt * 4) : 1;
      camPos.lerp(wantPos, k); camLook.lerp(wantLook, k);
      camera.position.copy(camPos); camera.lookAt(camLook);
      renderer.render(scene, camera);
    }

    return {
      start() { if (running) return; running = true; last = performance.now(); resize(); raf = requestAnimationFrame(frame); },
      stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
      get canvas() { return renderer.domElement; },
      get info() { return renderer.info.render; },
    };
  }

  window.World3D = { mount };
})();
