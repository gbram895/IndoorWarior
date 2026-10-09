// Usage: node tools/kenney-pack.js <folder with the three KenneyNL starter kits cloned> web/vendor/kenney-models.js
// Packs Kenney CC0 models (single mesh, colormap texture) into one classic
// script: window.IW_MODELS = { textures: {kit: dataURL}, models: {name: {kit, pos, nor, uv, idx}} }
// Trees are cut out of the forest tiles as separate models.
const fs = require('fs'), path = require('path');
const DL = process.argv[2], OUT = process.argv[3];
function readGlb(f) {
  const b = fs.readFileSync(f), jl = b.readUInt32LE(12), j = JSON.parse(b.slice(20, 20 + jl).toString());
  const binStart = 20 + jl + 8, bin = b.slice(binStart);
  const acc = i => {
    const a = j.accessors[i], v = j.bufferViews[a.bufferView], n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const T = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array }[a.componentType];
    const off = (v.byteOffset || 0) + (a.byteOffset || 0), stride = v.byteStride || n * T.BYTES_PER_ELEMENT;
    const out = new (T === Float32Array ? Float32Array : Uint32Array)(a.count * n);
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
      const o = off + k * stride + c * T.BYTES_PER_ELEMENT;
      out[k * n + c] = T === Float32Array ? bin.readFloatLE(o) : T === Uint16Array ? bin.readUInt16LE(o) : T === Uint32Array ? bin.readUInt32LE(o) : bin.readUInt8(o);
    }
    return out;
  };
  const pos = [], nor = [], uv = [], idx = [];
  for (const node of j.nodes) {
    if (node.mesh == null) continue;
    if (node.translation || node.rotation || node.scale || node.matrix) throw new Error('node transform in ' + f);
    for (const p of j.meshes[node.mesh].primitives) {
      const base = pos.length / 3, P = acc(p.attributes.POSITION), N = acc(p.attributes.NORMAL), U = acc(p.attributes.TEXCOORD_0), I = acc(p.indices);
      pos.push(...P); nor.push(...N); uv.push(...U); for (const i of I) idx.push(i + base);
    }
  }
  return { pos, nor, uv, idx };
}
// Split a tile into objects standing on it: drop the ground plate, weld,
// join triangles that share points, then join pieces whose footprints overlap.
function splitTrees(m, plateTop) {
  const tri = m.idx.length / 3, parent = [...Array(tri).keys()];
  const find = a => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const keep = [], byPoint = new Map();
  for (let t = 0; t < tri; t++) {
    const ys = [0, 1, 2].map(k => m.pos[m.idx[t * 3 + k] * 3 + 1]);
    if (Math.max(...ys) <= plateTop + 1e-4) continue; // the plate
    keep.push(t);
    for (let k = 0; k < 3; k++) {
      const v = m.idx[t * 3 + k], key = [0, 1, 2].map(c => Math.round(m.pos[v * 3 + c] * 1000)).join(',');
      if (byPoint.has(key)) join(t, byPoint.get(key)); else byPoint.set(key, t);
    }
  }
  const groups = new Map();
  for (const t of keep) { const r = find(t); groups.get(r)?.push(t) || groups.set(r, [t]); }
  let parts = [...groups.values()].map(ts => {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const t of ts) for (let k = 0; k < 3; k++) { const v = m.idx[t * 3 + k]; const x = m.pos[v * 3], z = m.pos[v * 3 + 2]; box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], z); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], z); }
    return { ts, box };
  });
  // Merge parts whose footprints overlap (trunk under crown).
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
      const A = parts[a].box, B = parts[b].box;
      const cx = (B[0] + B[2]) / 2, cz = (B[1] + B[3]) / 2, ax = (A[0] + A[2]) / 2, az = (A[1] + A[3]) / 2;
      if (cx > A[0] && cx < A[2] && cz > A[1] && cz < A[3] || ax > B[0] && ax < B[2] && az > B[1] && az < B[3]) {
        parts[a] = { ts: parts[a].ts.concat(parts[b].ts), box: [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[2], B[2]), Math.max(A[3], B[3])] };
        parts.splice(b, 1); changed = true; break outer;
      }
    }
  }
  const height = ({ ts }) => { let lo = Infinity, hi = -Infinity; for (const t of ts) for (let k = 0; k < 3; k++) { const y = m.pos[m.idx[t * 3 + k] * 3 + 1]; lo = Math.min(lo, y); hi = Math.max(hi, y); } return hi - lo; };
  const tallest = Math.max(...parts.map(height));
  parts = parts.filter(p => height(p) > tallest * 0.4); // trees, not stones or grass
  return parts.map(({ ts, box }) => {
    const map = new Map(), out = { pos: [], nor: [], uv: [], idx: [] };
    const cx = (box[0] + box[2]) / 2, cz = (box[1] + box[3]) / 2;
    let ymin = Infinity; for (const t of ts) for (let k = 0; k < 3; k++) ymin = Math.min(ymin, m.pos[m.idx[t * 3 + k] * 3 + 1]);
    for (const t of ts) for (let k = 0; k < 3; k++) {
      const v = m.idx[t * 3 + k];
      if (!map.has(v)) {
        map.set(v, out.pos.length / 3);
        out.pos.push(m.pos[v * 3] - cx, m.pos[v * 3 + 1] - ymin, m.pos[v * 3 + 2] - cz);
        out.nor.push(m.nor[v * 3], m.nor[v * 3 + 1], m.nor[v * 3 + 2]); out.uv.push(m.uv[v * 2], m.uv[v * 2 + 1]);
      }
      out.idx.push(map.get(v));
    }
    return out;
  });
}
// The same model without the triangles lying flat on its ground plate.
function dropPlate(m, top) {
  const idx = [];
  for (let t = 0; t < m.idx.length / 3; t++) {
    const ys = [0, 1, 2].map(k => m.pos[m.idx[t * 3 + k] * 3 + 1]);
    if (Math.max(...ys) > top) idx.push(m.idx[t * 3], m.idx[t * 3 + 1], m.idx[t * 3 + 2]);
  }
  return { ...m, idx };
}
const b64f = a => Buffer.from(new Float32Array(a).buffer).toString('base64');
const b64i = a => Buffer.from(new Uint16Array(a).buffer).toString('base64');
const pack = (kit, m) => ({ kit, pos: b64f(m.pos), nor: b64f(m.nor), uv: b64f(m.uv), idx: b64i(m.idx) });
const kits = { city: 'Starter-Kit-City-Builder/models', racing: 'Starter-Kit-Racing/models', plat: 'Starter-Kit-3D-Platformer/models' };
const out = { textures: {}, models: {} };
for (const [k, dir] of Object.entries(kits)) out.textures[k] = 'data:image/png;base64,' + fs.readFileSync(path.join(DL, dir, 'Textures/colormap.png')).toString('base64');
const whole = {
  'house-a': ['city', 'building-small-a'], 'house-b': ['city', 'building-small-b'], 'house-c': ['city', 'building-small-c'],
  'house-d': ['city', 'building-small-d'], garage: ['city', 'building-garage'], fountain: ['city', 'pavement-fountain'],
  tents: ['racing', 'decoration-tents'],
  cloud: ['plat', 'cloud'], flag: ['plat', 'flag'], tuft: ['plat', 'grass'], 'tuft-small': ['plat', 'grass-small'],
};
for (const [name, [kit, file]] of Object.entries(whole)) out.models[name] = pack(kit, readGlb(path.join(DL, kits[kit], file + '.glb')));
out.models.arch = pack('racing', dropPlate(readGlb(path.join(DL, kits.racing, 'track-finish.glb')), 0.8));
let n = 0;
for (const [kit, file, plate] of [['racing', 'decoration-forest', 0.06], ['city', 'grass-trees-tall', 0.061], ['city', 'grass-trees', 0.061]]) {
  const trees = splitTrees(readGlb(path.join(DL, kits[kit], file + '.glb')), plate);
  console.log(file, trees.length, 'pieces', trees.map(t => t.idx.length / 3 + 'tri').join(' '));
  for (const t of trees) {
    // Skip trees that kept a patch of ground round their foot (wider than tall).
    let w = 0, h = 0; for (let i = 0; i < t.pos.length; i += 3) { w = Math.max(w, Math.abs(t.pos[i]), Math.abs(t.pos[i + 2])); h = Math.max(h, t.pos[i + 1]); }
    if (w * 2 < h * 0.7) out.models[`tree-${n++}`] = pack(kit, t);
  }
}
fs.writeFileSync(OUT, '// Kenney 3D models (CC0, www.kenney.nl), packed by a build script: see vendor/kenney-LICENSE.txt.\nwindow.IW_MODELS = ' + JSON.stringify(out) + ';\n');
console.log('bytes', fs.statSync(OUT).size);
