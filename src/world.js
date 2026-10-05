// The 3D world: terrain, road, trees, water, and the riders.

import * as THREE from 'three';
import { createHeightField } from './terrain.js';

const SKY = 0xa8d8f0;
const ROAD_HALF_WIDTH = 3.5;
const UP = new THREE.Vector3(0, 1, 0);

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 150, 1400);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 6000);

    this.scene.add(new THREE.HemisphereLight(0xe8f6ff, 0x5a6b3a, 1.4));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(-0.5, 1, 0.35);
    this.scene.add(sun);

    this.routeGroup = new THREE.Group();
    this.scene.add(this.routeGroup);
    this.player = makeRider(0xd62828);
    this.scene.add(this.player.group);
    this.bots = [];
    this.route = null;
    this.snapCamera = true;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setBots(colors) {
    for (const b of this.bots) this.scene.remove(b.group);
    this.bots = colors.map((c) => {
      const r = makeRider(c);
      this.scene.add(r.group);
      return r;
    });
  }

  setRoute(route) {
    this.route = route;
    for (const child of [...this.routeGroup.children]) {
      this.routeGroup.remove(child);
      child.geometry?.dispose();
      if (child.material) [].concat(child.material).forEach((m) => (m.map?.dispose(), m.dispose()));
    }
    const field = createHeightField(route);
    this.routeGroup.add(buildRoad(route));
    const { terrain, trees } = buildTerrain(route, field);
    this.routeGroup.add(terrain, ...trees);

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshPhongMaterial({ color: 0x2f86c0, shininess: 80, specular: 0x88bbdd }),
    );
    const box = new THREE.Box3().setFromObject(terrain);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    water.scale.set(size.x + 6000, size.z + 6000, 1);
    water.rotation.x = -Math.PI / 2;
    water.position.set(center.x, field.waterLevel, center.z);
    this.routeGroup.add(water);
    this.snapCamera = true;
  }

  /**
   * @param {number} dt seconds
   * @param {{distance:number, speed:number, cadence:number}} player
   * @param {{distance:number, speed:number, cadence:number}[]} bots
   */
  update(dt, player, bots = []) {
    if (!this.route) return;
    const p = this._place(this.player, player, 1.2, dt);
    bots.forEach((b, i) => this.bots[i] && this._place(this.bots[i], b, [-1.4, 2.4, -2.6][i % 3], dt));

    const fwd = new THREE.Vector3(p.dirX, 0, p.dirZ);
    const target = new THREE.Vector3(p.x, p.y, p.z);
    const desired = target.clone().addScaledVector(fwd, -7).add(new THREE.Vector3(0, 2.8, 0));
    if (this.snapCamera) {
      this.camera.position.copy(desired);
      this.snapCamera = false;
    } else {
      this.camera.position.lerp(desired, 1 - Math.exp(-dt * 4));
    }
    this.camera.lookAt(target.addScaledVector(fwd, 5).add(new THREE.Vector3(0, 1, 0)));
    this.renderer.render(this.scene, this.camera);
  }

  _place(rider, state, lateral, dt) {
    const s = this.route.sample(state.distance);
    const rx = -s.dirZ;
    const rz = s.dirX;
    const pos = new THREE.Vector3(s.x + rx * lateral, s.y + 0.15, s.z + rz * lateral);
    rider.group.position.copy(pos);
    rider.group.lookAt(pos.x + s.dirX, pos.y + s.grade, pos.z + s.dirZ);
    rider.animate(dt, state.speed, state.cadence);
    return { ...s, x: pos.x, y: pos.y, z: pos.z };
  }
}

function roadTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3c3e42';
  g.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 900; i++) {
    const v = 50 + Math.random() * 30;
    g.fillStyle = `rgb(${v},${v},${v + 4})`;
    g.fillRect(Math.random() * 128, Math.random() * 256, 1.5, 1.5);
  }
  g.fillStyle = '#e8e8e8';
  g.fillRect(6, 0, 5, 256);
  g.fillRect(117, 0, 5, 256);
  g.fillStyle = '#f2c230';
  g.fillRect(62, 0, 4, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function buildRoad(route) {
  const n = route.count;
  const pos = new Float32Array(n * 6);
  const uv = new Float32Array(n * 4);
  const index = [];
  for (let i = 0; i < n; i++) {
    const rx = -route.dirZ[i];
    const rz = route.dirX[i];
    const x = route.xs[i];
    const z = route.zs[i];
    const y = route.ys[i] + 0.12;
    pos.set([x - rx * ROAD_HALF_WIDTH, y, z - rz * ROAD_HALF_WIDTH, x + rx * ROAD_HALF_WIDTH, y, z + rz * ROAD_HALF_WIDTH], i * 6);
    const v = (i * route.step) / 12;
    uv.set([0, v, 1, v], i * 4);
    if (i < n - 1) {
      const a = i * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({
    map: roadTexture(),
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return new THREE.Mesh(geo, mat);
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTerrain(route, field) {
  const TILE = 400;
  const SEG = 24;
  const reach = route.length > 40000 ? 1 : 2;
  const tiles = new Set();
  for (let s = 0; s <= route.length; s += 50) {
    const p = route.sample(s);
    const tx = Math.floor(p.x / TILE);
    const tz = Math.floor(p.z / TILE);
    for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) tiles.add(`${tx + dx},${tz + dz}`);
  }

  const vpt = (SEG + 1) ** 2;
  const pos = new Float32Array(tiles.size * vpt * 3);
  const col = new Float32Array(tiles.size * vpt * 3);
  const index = new Uint32Array(tiles.size * SEG * SEG * 6);
  const color = new THREE.Color();
  const rand = mulberry32(1234);
  const treeSpots = [];
  let t = 0;
  let k = 0;
  for (const key of tiles) {
    const [tx, tz] = key.split(',').map(Number);
    const base = t * vpt;
    for (let iz = 0; iz <= SEG; iz++) {
      for (let ix = 0; ix <= SEG; ix++) {
        const x = tx * TILE + (ix * TILE) / SEG;
        const z = tz * TILE + (iz * TILE) / SEG;
        const { h, rel } = field.at(x, z);
        const v = base + iz * (SEG + 1) + ix;
        pos.set([x, h, z], v * 3);
        const n = Math.sin(x * 0.013) * Math.cos(z * 0.011) * 0.5 + 0.5;
        if (h < field.waterLevel + 1.5) color.setRGB(0.76, 0.7, 0.5, THREE.SRGBColorSpace);
        else if (rel > 115) color.setRGB(0.95, 0.96, 0.98, THREE.SRGBColorSpace);
        else if (rel > 70) color.setHSL(0.08, 0.08, 0.38 + n * 0.1, THREE.SRGBColorSpace);
        else color.setHSL(0.24 + n * 0.06, 0.48, 0.3 + n * 0.08, THREE.SRGBColorSpace);
        col.set([color.r, color.g, color.b], v * 3);
      }
    }
    for (let iz = 0; iz < SEG; iz++) {
      for (let ix = 0; ix < SEG; ix++) {
        const a = base + iz * (SEG + 1) + ix;
        const b = a + 1;
        const c = a + SEG + 1;
        const d = c + 1;
        index.set([a, c, b, b, c, d], k);
        k += 6;
      }
    }
    for (let i = 0; i < 10; i++) {
      const x = (tx + rand()) * TILE;
      const z = (tz + rand()) * TILE;
      const { h, d, rel } = field.at(x, z);
      if (d > 14 && h > field.waterLevel + 1.5 && rel < 65) treeSpots.push([x, h, z, 0.7 + rand() * 0.8, rand() * Math.PI]);
    }
    t++;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));

  const crown = new THREE.InstancedMesh(
    new THREE.ConeGeometry(2.4, 7, 7).translate(0, 6, 0),
    new THREE.MeshLambertMaterial({ color: 0x2f6b34 }),
    treeSpots.length,
  );
  const trunk = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.3, 0.4, 3, 6).translate(0, 1.5, 0),
    new THREE.MeshLambertMaterial({ color: 0x6b4a2b }),
    treeSpots.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const tint = new THREE.Color();
  treeSpots.forEach(([x, y, z, s, r], i) => {
    m.compose(new THREE.Vector3(x, y - 0.3, z), q.setFromAxisAngle(UP, r), new THREE.Vector3(s, s, s));
    crown.setMatrixAt(i, m);
    trunk.setMatrixAt(i, m);
    crown.setColorAt(i, tint.setHSL(0.3 + (i % 7) * 0.012, 0.45, 0.22 + (i % 5) * 0.02, THREE.SRGBColorSpace));
  });
  return { terrain, trees: [crown, trunk] };
}

function bar(a, b, radius, material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 8), material);
  setBetween(mesh, a, b);
  return mesh;
}

function setBetween(mesh, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.scale.set(1, Math.max(len, 1e-3), 1);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
}

/** Low-poly cyclist. Local +z is forward. */
function makeRider(jerseyColor) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const group = new THREE.Group();
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const tyreMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
  const jersey = new THREE.MeshLambertMaterial({ color: jerseyColor });
  const skin = new THREE.MeshLambertMaterial({ color: 0xe0b18f });
  const shorts = new THREE.MeshLambertMaterial({ color: 0x1b1b1f });

  const wheels = [-0.5, 0.52].map((z) => {
    const w = new THREE.Group();
    w.position.set(0, 0.34, z);
    const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.025, 8, 24), tyreMat);
    tyre.rotation.y = Math.PI / 2;
    const spokes = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.64, 0.02), frameMat);
    w.add(tyre, spokes);
    group.add(w);
    return w;
  });

  const rear = V(0, 0.34, -0.5);
  const front = V(0, 0.34, 0.52);
  const bb = V(0, 0.3, 0);
  const seat = V(0, 0.82, -0.14);
  const head = V(0, 0.8, 0.4);
  for (const [a, b] of [[rear, bb], [bb, seat], [seat, head], [bb, head], [head, front], [rear, seat]]) {
    group.add(bar(a, b, 0.018, frameMat));
  }
  group.add(bar(V(-0.2, 0.92, 0.46), V(0.2, 0.92, 0.46), 0.015, frameMat));
  group.add(bar(head, V(0, 0.92, 0.46), 0.016, frameMat));

  const hip = V(0, 0.9, -0.12);
  const shoulder = V(0, 1.3, 0.3);
  group.add(bar(hip, shoulder, 0.15, jersey));
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), skin);
  headMesh.position.set(0, 1.45, 0.4);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), jersey);
  helmet.position.copy(headMesh.position).add(V(0, 0.02, -0.01));
  helmet.rotation.x = 0.4;
  group.add(headMesh, helmet);
  for (const sx of [-1, 1]) group.add(bar(V(0.17 * sx, 1.28, 0.3), V(0.2 * sx, 0.93, 0.46), 0.04, jersey));

  const legs = [-1, 1].map((sx) => {
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 1, 8), shorts);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1, 8), skin);
    group.add(thigh, shin);
    return { sx, thigh, shin };
  });

  let crank = 0;
  const L = 0.46;
  const animate = (dt, speed, cadence) => {
    for (const w of wheels) w.rotation.x += (speed * dt) / 0.34;
    crank += ((cadence || 0) / 60) * Math.PI * 2 * dt;
    for (const leg of legs) {
      const a = crank + (leg.sx > 0 ? 0 : Math.PI);
      const hipP = V(0.1 * leg.sx, hip.y, hip.z);
      const pedal = V(0.13 * leg.sx, bb.y - 0.17 * Math.cos(a), bb.z + 0.17 * Math.sin(a));
      const d = Math.min(pedal.distanceTo(hipP), 2 * L - 0.001);
      const mid = hipP.clone().lerp(pedal, 0.5);
      const along = pedal.clone().sub(hipP);
      const perp = V(0, -along.z, along.y).normalize();
      if (perp.z < 0) perp.negate();
      const knee = mid.addScaledVector(perp, Math.sqrt(L * L - (d / 2) ** 2));
      setBetween(leg.thigh, hipP, knee);
      setBetween(leg.shin, knee, pedal);
    }
  };
  animate(0, 0, 0);
  return { group, animate };
}
