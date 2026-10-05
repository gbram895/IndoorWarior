// Terrain heights around a route: flush with the road near it, rising into
// procedural hills further away. Pure maths, no rendering, so it can be tested.

const CELL = 100; // spatial hash cell size (m)
const MAX_RINGS = 8;

function hash2(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function valueNoise(x, z, seed = 1) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x, z, seed = 1, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, z * f, seed + i) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createHeightField(route, { seed = 7 } = {}) {
  const buckets = new Map();
  const key = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);
  for (let i = 0; i < route.count; i += 2) {
    const k = key(Math.floor(route.xs[i] / CELL), Math.floor(route.zs[i] / CELL));
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(i);
  }

  function nearest(x, z) {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = Infinity;
    let bi = -1;
    const visit = (ix, iz) => {
      const arr = buckets.get(key(ix, iz));
      if (!arr) return;
      for (const i of arr) {
        const dx = route.xs[i] - x;
        const dz = route.zs[i] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) {
          best = d2;
          bi = i;
        }
      }
    };
    for (let r = 0; r <= MAX_RINGS; r++) {
      if (r === 0) visit(cx, cz);
      else {
        for (let i = -r; i <= r; i++) {
          visit(cx + i, cz - r);
          visit(cx + i, cz + r);
        }
        for (let i = -r + 1; i <= r - 1; i++) {
          visit(cx - r, cz + i);
          visit(cx + r, cz + i);
        }
      }
      if (bi >= 0 && Math.sqrt(best) <= r * CELL) break;
    }
    return { d: Math.sqrt(best), i: bi };
  }

  /** Height at (x, z), its distance to the road, and height relative to the nearest road point. */
  function at(x, z) {
    const { d, i } = nearest(x, z);
    const roadY = i >= 0 ? route.ys[i] : route.minEle;
    const hills = (fbm(x * 0.0022, z * 0.0022, seed) - 0.42) * 240 * Math.min(1, d / 600);
    const t = smoothstep(12, 220, d);
    const h = roadY - 0.6 + t * (hills + 0.6);
    return { h, d, rel: h - roadY };
  }

  return { at, nearest, waterLevel: route.minEle - 4 };
}
