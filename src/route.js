// A route is a path through the world, resampled every few metres with smoothed
// elevation and gradient so the game and the trainer get a steady signal.

export const EARTH_RADIUS = 6371008.8;
export const SAMPLE_SPACING = 5; // metres between resampled points
const SMOOTH_RADIUS = 25; // metres either side used to smooth elevation
const GRADE_SPAN = 10; // metres either side used to measure gradient
const MAX_GRADE = 0.25;

export class Route {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {{x:number, z:number, ele:number}[]} opts.points  local metres, -z is north
   * @param {boolean} [opts.loop]
   * @param {{lat:number, lon:number}|null} [opts.origin]  set for real-world routes
   * @param {'fictional'|'real'} [opts.kind]
   */
  constructor({ name, points, loop = false, origin = null, kind = 'fictional' }) {
    this.name = name;
    this.loop = loop;
    this.origin = origin;
    this.kind = kind;
    this._build(points);
  }

  _build(input) {
    const pts = [];
    for (const p of input) {
      const prev = pts[pts.length - 1];
      if (!prev || Math.hypot(p.x - prev.x, p.z - prev.z) >= 0.5) {
        pts.push({ x: p.x, z: p.z, ele: Number.isFinite(p.ele) ? p.ele : 0 });
      }
    }
    if (pts.length < 2) throw new Error('A route needs at least two distinct points.');
    if (this.loop) {
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (Math.hypot(first.x - last.x, first.z - last.z) >= 0.5) pts.push({ ...first });
      else pts[pts.length - 1] = { ...first };
    }

    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    }
    const length = cum[cum.length - 1];
    const n = Math.max(2, Math.round(length / SAMPLE_SPACING) + 1);
    const step = length / (n - 1);

    const xs = new Float64Array(n);
    const zs = new Float64Array(n);
    const raw = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const s = i === n - 1 ? length : i * step;
      while (j < pts.length - 2 && cum[j + 1] < s) j++;
      const seg = cum[j + 1] - cum[j];
      const t = seg > 0 ? (s - cum[j]) / seg : 0;
      xs[i] = pts[j].x + (pts[j + 1].x - pts[j].x) * t;
      zs[i] = pts[j].z + (pts[j + 1].z - pts[j].z) * t;
      raw[i] = pts[j].ele + (pts[j + 1].ele - pts[j].ele) * t;
    }

    const unique = this.loop ? n - 1 : n;
    const idx = this.loop
      ? (i) => ((i % unique) + unique) % unique
      : (i) => Math.min(Math.max(i, 0), n - 1);

    const k = Math.max(1, Math.round(SMOOTH_RADIUS / step));
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let o = -k; o <= k; o++) sum += raw[idx(i + o)];
      ys[i] = sum / (2 * k + 1);
    }
    if (this.loop) ys[n - 1] = ys[0];

    const g = Math.max(1, Math.round(GRADE_SPAN / step));
    const grades = new Float64Array(n);
    const dirX = new Float64Array(n);
    const dirZ = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let i0 = i - g;
      let i1 = i + g;
      if (!this.loop) {
        i0 = Math.max(0, i0);
        i1 = Math.min(n - 1, i1);
      }
      const grade = (ys[idx(i1)] - ys[idx(i0)]) / ((i1 - i0) * step);
      grades[i] = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, grade));

      const a = this.loop ? idx(i - 1) : Math.max(0, i - 1);
      const b = this.loop ? idx(i + 1) : Math.min(n - 1, i + 1);
      const dx = xs[b] - xs[a];
      const dz = zs[b] - zs[a];
      const len = Math.hypot(dx, dz) || 1;
      dirX[i] = dx / len;
      dirZ[i] = dz / len;
    }

    let ascent = 0;
    let minEle = Infinity;
    let maxEle = -Infinity;
    for (let i = 0; i < n; i++) {
      if (i > 0 && ys[i] > ys[i - 1]) ascent += ys[i] - ys[i - 1];
      minEle = Math.min(minEle, ys[i]);
      maxEle = Math.max(maxEle, ys[i]);
    }

    Object.assign(this, { length, count: n, step, xs, zs, ys, grades, dirX, dirZ, ascent, minEle, maxEle });
  }

  /** Position, elevation, gradient and heading at `distance` metres along the route. */
  sample(distance) {
    const L = this.length;
    const s = this.loop ? ((distance % L) + L) % L : Math.min(Math.max(distance, 0), L);
    const f = s / this.step;
    const i = Math.min(Math.floor(f), this.count - 2);
    const t = f - i;
    const lerp = (arr) => arr[i] + (arr[i + 1] - arr[i]) * t;
    let dx = lerp(this.dirX);
    let dz = lerp(this.dirZ);
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const out = {
      distance: s,
      x: lerp(this.xs),
      y: lerp(this.ys),
      z: lerp(this.zs),
      grade: lerp(this.grades),
      dirX: dx,
      dirZ: dz,
    };
    if (this.origin) Object.assign(out, this.toLatLon(out.x, out.z));
    return out;
  }

  toLatLon(x, z) {
    const { lat, lon } = this.origin;
    const rad = Math.PI / 180;
    return {
      lat: lat - z / EARTH_RADIUS / rad,
      lon: lon + x / (EARTH_RADIUS * Math.cos(lat * rad)) / rad,
    };
  }

  /** Real-world route from GPS points [{lat, lon, ele}]. */
  static fromLatLon(name, points) {
    if (points.length < 2) throw new Error('The GPX file needs at least two track points.');
    const rad = Math.PI / 180;
    const origin = { lat: points[0].lat, lon: points[0].lon };
    const cosLat = Math.cos(origin.lat * rad);
    const local = points.map((p) => ({
      x: (p.lon - origin.lon) * rad * EARTH_RADIUS * cosLat,
      z: -(p.lat - origin.lat) * rad * EARTH_RADIUS,
      ele: p.ele,
    }));
    let length = 0;
    for (let i = 1; i < local.length; i++) {
      length += Math.hypot(local[i].x - local[i - 1].x, local[i].z - local[i - 1].z);
    }
    const first = local[0];
    const last = local[local.length - 1];
    const loop = length > 1000 && Math.hypot(first.x - last.x, first.z - last.z) < 50;
    return new Route({ name, points: local, loop, origin, kind: 'real' });
  }

  static fromGpx(text, fallbackName = 'Imported route') {
    const { name, points } = parseGpx(text);
    return Route.fromLatLon(name || fallbackName, points);
  }
}

/** Minimal GPX reader: track points (or route points) with optional elevation. */
export function parseGpx(text) {
  const points = [];
  const re = /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(text))) {
    const lat = parseFloat(/\blat\s*=\s*["']([^"']+)["']/.exec(m[2])?.[1]);
    const lon = parseFloat(/\blon\s*=\s*["']([^"']+)["']/.exec(m[2])?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = parseFloat(/<ele>\s*([^<]+?)\s*<\/ele>/.exec(m[3] ?? '')?.[1]);
    points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : NaN });
  }
  // Fill missing elevations from neighbours so the route stays rideable.
  let lastEle = points.find((p) => Number.isFinite(p.ele))?.ele ?? 0;
  for (const p of points) {
    if (Number.isFinite(p.ele)) lastEle = p.ele;
    else p.ele = lastEle;
  }
  const name = /<name>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/name>/.exec(text)?.[1]?.trim() ?? '';
  return { name, points };
}
