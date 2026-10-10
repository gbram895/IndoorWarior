// IndoorWarior: the real place a GPX route runs through, for the 3D view.
// A classic script (window.IW_PLACES), so it also works from a file.
//
// Four free sources, fetched straight from the browser when a route opens:
// - the land's height from AWS Terrain Tiles (Mapzen "terrarium" PNGs, no key);
// - what the land looks like from above: EOX's Sentinel-2 cloudless mosaic
//   (Copernicus satellite photos at 10 m, CC BY-NC-SA 4.0, no key);
// - lakes, rivers, woods, buildings, towns, cols and country borders from
//   OpenStreetMap through the Overpass API;
// - the weather there now from Open-Meteo.
// Everything comes back in latitude and longitude; world3d.js turns it into
// its own metres.
(function () {
  const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const SAT_URL = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`;
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const M_PER_DEG = 111320;

  // Web-mercator pixel position of a latitude/longitude at a zoom level (256 px tiles).
  function merc(lat, lon, z) {
    const n = 256 * 2 ** z, s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }
  // An image, or null if it would not load. Kept (most recent few hundred) so
  // opening the same route again does not fetch it twice.
  const images = new Map();
  function image(url) {
    if (images.has(url)) { const p = images.get(url); images.delete(url); images.set(url, p); return p; }
    const p = new Promise(ok => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => ok(img); img.onerror = () => ok(null);
      img.src = url;
    });
    images.set(url, p);
    if (images.size > 400) images.delete(images.keys().next().value);
    return p;
  }

  // The tiles at zoom z within `reach` metres of any of the points.
  function tilesNear(pts, reach, z) {
    const keys = new Map(), every = Math.max(1, Math.floor(pts.length / 4000));
    const n = Math.max(1, Math.ceil(reach / 1500)); // offsets on a grid finer than a tile
    for (let i = 0; i < pts.length; i += every) {
      const [lat, lon] = pts[i], k = Math.cos((lat * Math.PI) / 180);
      for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
        const dy = (a / n) * reach, dx = (b / n) * reach;
        const [px, py] = merc(lat + dy / 110540, lon + dx / (M_PER_DEG * k), z), tx = Math.floor(px / 256), ty = Math.floor(py / 256);
        keys.set(`${tx},${ty}`, [tx, ty]);
      }
    }
    return [...keys.values()];
  }

  // The height of the land (m above sea) round the points, out to `reach`
  // metres, at the finest zoom (from `zooms`, best first) that needs no more
  // than `most` tiles. Resolves to a function (lat, lon) => metres, NaN off
  // the tiles; fails when a quarter or more of the tiles would not load.
  async function terrain(pts, reach, zooms, most) {
    let z, list;
    for (z of zooms) { list = tilesNear(pts, reach, z); if (list.length <= most) break; }
    const tiles = new Map(), canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    let failed = 0;
    for (let k = 0; k < list.length; k += 8) {
      const batch = list.slice(k, k + 8), imgs = await Promise.all(batch.map(([x, y]) => image(DEM_URL(z, x, y))));
      imgs.forEach((img, m) => {
        if (!img) { failed++; return; }
        cx.drawImage(img, 0, 0);
        const px = cx.getImageData(0, 0, 256, 256).data, h = new Float32Array(256 * 256);
        for (let q = 0; q < h.length; q++) h[q] = px[q * 4] * 256 + px[q * 4 + 1] + px[q * 4 + 2] / 256 - 32768;
        tiles.set(`${batch[m][0]},${batch[m][1]}`, h);
      });
    }
    if (failed >= Math.max(1, list.length * 0.25)) throw new Error(`${failed} of ${list.length} height tiles would not load`);
    const at = (ix, iy) => { const h = tiles.get(`${ix >> 8},${iy >> 8}`); return h ? h[(iy & 255) * 256 + (ix & 255)] : NaN; };
    const fn = (lat, lon) => {
      const [px, py] = merc(lat, lon, z), fx = px - 0.5, fy = py - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy;
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
      return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    };
    fn.zoom = z; fn.tiles = list.length;
    return fn;
  }

  // The satellite photo round the points, as terrain() does the heights.
  // Resolves to a function (lat, lon, out) that fills out with r, g, b
  // (0 to 1) and returns true, or returns false where there is no photo
  // (off the tiles, or a black no-data patch).
  async function imagery(pts, reach, zooms, most) {
    let z, list;
    for (z of zooms) { list = tilesNear(pts, reach, z); if (list.length <= most) break; }
    const tiles = new Map(), canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    let failed = 0;
    for (let k = 0; k < list.length; k += 8) {
      const batch = list.slice(k, k + 8), imgs = await Promise.all(batch.map(([x, y]) => image(SAT_URL(z, x, y))));
      imgs.forEach((img, m) => {
        if (!img) { failed++; return; }
        cx.drawImage(img, 0, 0, 256, 256);
        const px = cx.getImageData(0, 0, 256, 256).data, c = new Uint8Array(256 * 256 * 3);
        for (let q = 0; q < 256 * 256; q++) { c[q * 3] = px[q * 4]; c[q * 3 + 1] = px[q * 4 + 1]; c[q * 3 + 2] = px[q * 4 + 2]; }
        tiles.set(`${batch[m][0]},${batch[m][1]}`, c);
      });
    }
    if (failed >= Math.max(1, list.length * 0.25)) throw new Error(`${failed} of ${list.length} satellite tiles would not load`);
    const corner = [0, 0, 0, 0].map(() => [0, 0, 0]);
    const at = (ix, iy, o) => {
      const c = tiles.get(`${ix >> 8},${iy >> 8}`);
      if (!c) return false;
      const q = ((iy & 255) * 256 + (ix & 255)) * 3;
      o[0] = c[q]; o[1] = c[q + 1]; o[2] = c[q + 2];
      return o[0] + o[1] + o[2] > 6;
    };
    const fn = (lat, lon, out) => {
      const [px, py] = merc(lat, lon, z), fx = px - 0.5, fy = py - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy;
      if (!(at(ix, iy, corner[0]) && at(ix + 1, iy, corner[1]) && at(ix, iy + 1, corner[2]) && at(ix + 1, iy + 1, corner[3]))) return false;
      for (let m = 0; m < 3; m++) out[m] = ((corner[0][m] * (1 - u) + corner[1][m] * u) * (1 - v) + (corner[2][m] * (1 - u) + corner[3][m] * u) * v) / 255;
      return true;
    };
    fn.zoom = z; fn.tiles = list.length;
    return fn;
  }

  // ---- OpenStreetMap. One Overpass query for everything along the route.
  // Points every 250 m or so make the line it searches round.
  function line(pts) {
    const out = [];
    let last = null;
    for (const p of pts) {
      if (last && Math.hypot((p[0] - last[0]) * 110540, (p[1] - last[1]) * M_PER_DEG * Math.cos((p[0] * Math.PI) / 180)) < 250) continue;
      out.push(p); last = p;
    }
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out.map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(',');
  }
  function query(pts) {
    const L = line(pts), [lat0, lon0] = pts[0];
    const near = r => `(around:${r},${L})`;
    return `[out:json][timeout:120][maxsize:268435456];
(
  way["natural"="water"]${near(900)};
  relation["natural"="water"]${near(900)};
  way["landuse"="reservoir"]${near(900)};
  way["waterway"="riverbank"]${near(900)};
  way["waterway"~"^(river|stream|canal)$"]${near(700)};
  way["landuse"="forest"]${near(800)};
  way["natural"="wood"]${near(800)};
  relation["landuse"="forest"]${near(800)};
  relation["natural"="wood"]${near(800)};
  way["landuse"~"^(residential|vineyard|orchard|meadow|farmland)$"]${near(800)};
  way["natural"~"^(bare_rock|scree|glacier|grassland)$"]${near(800)};
  way["building"]${near(250)};
);
out geom qt;
node["place"~"^(city|town|village|hamlet|suburb)$"]["name"]${near(2000)};
out qt;
(
  node["mountain_pass"="yes"]["name"]${near(200)};
  node["natural"="saddle"]["name"]${near(200)};
);
out qt;
relation["boundary"="administrative"]["admin_level"="2"]${near(40)}->.c;
.c out body qt;
way(r.c)${near(40)};
out geom qt;
is_in(${lat0.toFixed(5)},${lon0.toFixed(5)})->.s;
area.s["admin_level"="2"]["boundary"="administrative"];
out tags qt;`;
  }

  // Ways of a multipolygon joined into closed rings, as lists of [lat, lon].
  function rings(ways) {
    const open = ways.map(w => w.map(p => [p.lat, p.lon])).filter(w => w.length > 1), out = [];
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    while (open.length) {
      let ring = open.shift();
      for (let grew = true; grew && !same(ring[0], ring[ring.length - 1]);) {
        grew = false;
        for (let k = 0; k < open.length; k++) {
          const w = open[k], end = ring[ring.length - 1];
          if (same(w[0], end)) ring = ring.concat(w.slice(1));
          else if (same(w[w.length - 1], end)) ring = ring.concat(w.slice(0, -1).reverse());
          else continue;
          open.splice(k, 1); grew = true; break;
        }
      }
      if (ring.length > 3) out.push(ring);
    }
    return out;
  }
  const country = t => ({ name: t.name || t['name:en'] || '', en: t['name:en'] || t.name || '', code: (t['ISO3166-1:alpha2'] || t['ISO3166-1'] || t['country_code'] || '').toUpperCase() });

  // Sorts the Overpass answer into what the 3D view draws.
  function sort(json) {
    const out = { water: [], rivers: [], woods: [], towns: [], fields: [], rock: [], glacier: [], buildings: [], places: [], passes: [], countries: {}, borders: [], start: null };
    const borderIds = new Map(); // way id -> the countries it divides
    const pts = g => (g || []).map(p => [p.lat, p.lon]);
    for (const e of json.elements || []) {
      const t = e.tags || {};
      if (e.type === 'relation' && t.boundary === 'administrative' && t.admin_level === '2') {
        out.countries[e.id] = country(t);
        for (const m of e.members || []) if (m.type === 'way') borderIds.get(m.ref)?.push(e.id) || borderIds.set(m.ref, [e.id]);
      }
    }
    for (const e of json.elements || []) {
      const t = e.tags || {};
      if (e.type === 'area') { const id = e.id - 3600000000; out.countries[id] = out.countries[id] || country(t); out.start = id; continue; }
      if (e.type === 'node') {
        if (t.place) out.places.push({ name: t.name, kind: t.place, lat: e.lat, lon: e.lon });
        else out.passes.push({ name: t.name, ele: parseFloat(t.ele) || null, lat: e.lat, lon: e.lon });
        continue;
      }
      if (e.type === 'way' && borderIds.has(e.id)) { out.borders.push({ line: pts(e.geometry), between: borderIds.get(e.id) }); continue; }
      let shape;
      if (e.type === 'way') {
        if (t.waterway && t.waterway !== 'riverbank') { out.rivers.push({ kind: t.waterway, line: pts(e.geometry), width: parseFloat(t.width) || 0 }); continue; }
        shape = { outer: [pts(e.geometry)], inner: [] };
        if (shape.outer[0].length < 4) continue;
      } else if (e.type === 'relation') {
        const outer = (e.members || []).filter(m => m.type === 'way' && m.role !== 'inner').map(m => m.geometry || []);
        const inner = (e.members || []).filter(m => m.type === 'way' && m.role === 'inner').map(m => m.geometry || []);
        shape = { outer: rings(outer), inner: rings(inner) };
        if (!shape.outer.length) continue;
      } else continue;
      if (t.building) {
        out.buildings.push({ ring: shape.outer[0], levels: parseFloat(t['building:levels']) || 0, height: parseFloat(t.height) || 0, kind: t.building, roof: t['roof:shape'] || '' });
      } else if (t.natural === 'water' || t.landuse === 'reservoir' || t.waterway === 'riverbank') out.water.push(shape);
      else if (t.landuse === 'forest' || t.natural === 'wood') out.woods.push(shape);
      else if (t.landuse === 'residential') out.towns.push(shape);
      else if (t.natural === 'glacier') out.glacier.push(shape);
      else if (t.natural === 'bare_rock' || t.natural === 'scree') out.rock.push(shape);
      else out.fields.push({ kind: t.landuse || t.natural, shape });
    }
    return out;
  }

  // The map along a route. Cached by the browser (where it can) so opening the
  // same route again is instant and spares the free servers.
  async function osm(pts) {
    const q = query(pts);
    let key = 0;
    for (let i = 0; i < q.length; i++) key = (Math.imul(key, 31) + q.charCodeAt(i)) | 0;
    const cacheUrl = `https://indoorwarior.invalid/osm/v1/${(key >>> 0).toString(36)}`;
    let cache = null;
    try { cache = window.caches && (await caches.open('iw-places')); } catch {}
    try { const hit = cache && (await cache.match(cacheUrl)); if (hit) return sort(await hit.json()); } catch {}
    let last = null;
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }) });
        if (!r.ok) throw new Error(`the map server said ${r.status}`);
        const text = await r.text(), json = JSON.parse(text);
        if (json.remark && /error|timed out|runtime/i.test(json.remark)) throw new Error('the map server ran out of time');
        try { await cache?.put(cacheUrl, new Response(text, { headers: { 'content-type': 'application/json' } })); } catch {}
        return sort(json);
      } catch (e) { last = e; }
    }
    throw last || new Error('no map server answered');
  }

  // ---- The weather there now, as one of the 3D view's weathers.
  // WMO weather codes: 0-1 clear, 2-3 cloud, 45/48 fog, drizzle/rain/showers/
  // thunder, snow and snow showers.
  function weatherKind(code, cloud) {
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
    if (code >= 2 || cloud > 60) return 'cloudy';
    return 'clear';
  }
  async function weather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`the weather service said ${r.status}`);
    const c = (await r.json()).current;
    if (!c) throw new Error('no weather came back');
    return { kind: weatherKind(c.weather_code, c.cloud_cover), temp: c.temperature_2m, wind: c.wind_speed_10m, code: c.weather_code };
  }

  window.IW_PLACES = { terrain, imagery, osm, weather, merc, weatherKind, sort };
})();
