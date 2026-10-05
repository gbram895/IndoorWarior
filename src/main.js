import { World } from './world.js';
import { BUILTIN_ROUTES } from './routes.js';
import { Route } from './route.js';
import { BleTrainer, HeartRateMonitor, bluetoothAvailability } from './ftms.js';
import { SimulatedTrainer } from './simTrainer.js';
import { DEFAULT_RIDER, stepSpeed } from './physics.js';
import { buildTcx } from './tcx.js';
import { ProfileView, formatDuration, formatKm, gradeColor } from './hud.js';

const $ = (id) => document.getElementById(id);
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

const PLAYER_COLOR = 0xd62828;
const BOTS = [
  { name: 'Rookie', wkg: 2.0, color: 0x2a9d8f },
  { name: 'Rouleur', wkg: 2.8, color: 0xe9c46a },
  { name: 'Climber', wkg: 3.6, color: 0x8338ec },
];
const BOT_RIDER = { ...DEFAULT_RIDER, riderKg: 72 };

// ---------- settings ----------
const SETTINGS_KEY = 'indoor-warrior-settings';
function loadSettings() {
  const defaults = { riderKg: 75, difficulty: 50 };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}
const settings = loadSettings();

// ---------- state ----------
const routes = BUILTIN_ROUTES.map((r) => {
  const route = r.build();
  return { id: r.id, blurb: r.blurb, route };
});
let selected = routes[0];
let trainer = null;
let hrm = null;
const live = { power: 0, cadence: 0, hr: null, lastDataAt: 0 };
let ride = newRide();

function newRide() {
  return {
    state: 'setup',
    distance: 0,
    speed: 0,
    elapsed: 0,
    ascent: 0,
    lastEle: null,
    startedAt: null,
    sampleClock: 0,
    samples: [],
    bots: BOTS.map((b) => ({ ...b, distance: 0, speed: 0, cadence: 88 })),
  };
}

const riderModel = () => ({ ...DEFAULT_RIDER, riderKg: settings.riderKg });

// ---------- world ----------
let world = null;
try {
  world = new World($('scene'));
  world.setBots(BOTS.map((b) => b.color));
} catch (err) {
  console.error(err);
  toast('3D graphics (WebGL) are unavailable in this browser.');
}
const profile = new ProfileView($('profile'));

function selectRoute(entry) {
  selected = entry;
  world?.setRoute(entry.route);
  profile.setRoute(entry.route);
}

// ---------- setup screen ----------
function renderRouteList() {
  const box = $('routes');
  box.innerHTML = '';
  for (const entry of routes) {
    const r = entry.route;
    const label = document.createElement('label');
    label.className = 'route';
    label.innerHTML = `
      <input type="radio" name="route" ${entry === selected ? 'checked' : ''} />
      <div><div><strong></strong></div><div class="meta"></div></div>
      <span class="tag"></span>`;
    label.querySelector('strong').textContent = r.name;
    label.querySelector('.meta').textContent =
      `${formatKm(r.length)} km${r.loop ? ' loop' : ''} · ${Math.round(r.ascent)} m climbing · ${entry.blurb}`;
    label.querySelector('.tag').textContent = r.kind === 'real' ? 'Real world' : 'Fictional';
    label.querySelector('input').addEventListener('change', () => selectRoute(entry));
    box.appendChild(label);
  }
}

$('gpx').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const route = Route.fromGpx(await file.text(), file.name.replace(/\.gpx$/i, ''));
    const entry = { id: `gpx-${Date.now()}`, blurb: 'Imported GPX', route };
    routes.push(entry);
    selectRoute(entry);
    renderRouteList();
  } catch (err) {
    toast(`Could not read that GPX file: ${err.message}`);
  }
  e.target.value = '';
});

function setTrainerStatus(text, cls = '') {
  const el = $('trainer-status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

function useTrainer(t) {
  trainer?.disconnect();
  trainer = t;
  t.addEventListener('data', (e) => {
    const d = e.detail;
    if (d.power != null) live.power = d.power;
    if (d.cadence != null) live.cadence = d.cadence;
    if (d.heartRate && !hrm) live.hr = d.heartRate;
    live.lastDataAt = performance.now();
  });
  t.addEventListener('disconnected', () => {
    if (trainer !== t) return;
    trainer = null;
    setTrainerStatus('Trainer disconnected.', 'warn');
    toast('Trainer disconnected. Pause, then reconnect from the menu.');
    updateStartButton();
  });
  const sim = t instanceof SimulatedTrainer;
  $('sim-controls').hidden = !sim;
  if (sim) setTrainerStatus('Simulated trainer ready. Set your power with the slider or the arrow keys.', 'ok');
  else if (t.canControl) setTrainerStatus(`${t.name} connected (${t.protocol}). The trainer will set resistance to match the hills.`, 'ok');
  else {
    setTrainerStatus(
      `${t.name} connected (${t.protocol}), but resistance control isn't available` +
        `${t.controlError ? `: ${t.controlError}` : ''}. Close other apps (Zwift, Decathlon) that may be holding the trainer.`,
      'warn',
    );
  }
  updateStartButton();
}

function updateStartButton() {
  $('start').disabled = !trainer;
}

$('connect-trainer').addEventListener('click', async () => {
  const problem = bluetoothAvailability();
  if (problem) return setTrainerStatus(problem, 'warn');
  setTrainerStatus('Searching… Pedal to wake the trainer, then pick it in the browser pop-up.');
  try {
    useTrainer(await BleTrainer.request());
  } catch (err) {
    setTrainerStatus(err.name === 'NotFoundError' ? 'No trainer selected.' : `Connection failed: ${err.message}`, 'warn');
  }
});

$('use-sim').addEventListener('click', () => useTrainer(new SimulatedTrainer()));

$('connect-hr').addEventListener('click', async () => {
  const problem = bluetoothAvailability();
  const status = $('hr-status');
  if (problem) return (status.textContent = problem);
  try {
    hrm?.disconnect();
    hrm = await HeartRateMonitor.request();
    hrm.addEventListener('hr', (e) => (live.hr = e.detail));
    hrm.addEventListener('disconnected', () => {
      hrm = null;
      live.hr = null;
      status.textContent = 'Heart-rate strap disconnected.';
    });
    status.textContent = `${hrm.name} connected.`;
    status.className = 'status ok';
  } catch (err) {
    status.textContent = err.name === 'NotFoundError' ? '' : `Heart-rate connection failed: ${err.message}`;
  }
});

$('weight').value = settings.riderKg;
$('weight').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (v >= 30 && v <= 200) settings.riderKg = v;
  e.target.value = settings.riderKg;
  saveSettings();
});
$('difficulty').value = settings.difficulty;
$('difficulty-value').textContent = `${settings.difficulty}%`;
$('difficulty').addEventListener('input', (e) => {
  settings.difficulty = Number(e.target.value);
  $('difficulty-value').textContent = `${settings.difficulty}%`;
  saveSettings();
});

// ---------- simulated power ----------
function setSimPower(w) {
  if (!(trainer instanceof SimulatedTrainer)) return;
  trainer.setPower(w);
  $('sim-power').value = trainer.power;
  $('sim-power-value').textContent = `${trainer.power} W`;
}
$('sim-power').addEventListener('input', (e) => setSimPower(Number(e.target.value)));

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (ride.state === 'setup' || ride.state === 'finished') return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const step = (e.shiftKey ? 50 : 10) * (e.key === 'ArrowUp' ? 1 : -1);
    if (trainer instanceof SimulatedTrainer) setSimPower(trainer.power + step);
  } else if (e.key === ' ') {
    e.preventDefault();
    togglePause();
  }
});

// ---------- ride lifecycle ----------
$('start').addEventListener('click', () => {
  ride = newRide();
  ride.state = 'riding';
  ride.startedAt = Date.now();
  ride.lastEle = selected.route.sample(0).y;
  $('setup').hidden = true;
  $('hud').hidden = false;
  $('paused').hidden = true;
  $('btn-pause').textContent = 'Pause';
  if (trainer instanceof SimulatedTrainer) setSimPower(trainer.power);
});

function togglePause() {
  if (ride.state === 'riding') {
    ride.state = 'paused';
    trainer?.setGrade(0);
  } else if (ride.state === 'paused') {
    ride.state = 'riding';
  }
  $('paused').hidden = ride.state !== 'paused';
  $('btn-pause').textContent = ride.state === 'paused' ? 'Resume' : 'Pause';
}
$('btn-pause').addEventListener('click', togglePause);
$('btn-finish').addEventListener('click', finishRide);

function finishRide() {
  if (ride.state !== 'riding' && ride.state !== 'paused') return;
  ride.state = 'finished';
  trainer?.setGrade(0);
  recordSample();
  const avgPower = ride.samples.length ? ride.samples.reduce((a, s) => a + s.power, 0) / ride.samples.length : 0;
  const avgSpeed = ride.elapsed > 0 ? (ride.distance / ride.elapsed) * 3.6 : 0;
  const stats = [
    ['Distance', `${formatKm(ride.distance)} km`],
    ['Time', formatDuration(ride.elapsed)],
    ['Avg power', `${Math.round(avgPower)} W`],
    ['Avg speed', `${avgSpeed.toFixed(1)} km/h`],
    ['Climbed', `${Math.round(ride.ascent)} m`],
    ['Route', selected.route.name],
  ];
  const dl = $('summary-stats');
  dl.innerHTML = '';
  for (const [k, v] of stats) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    div.append(dt, dd);
    dl.appendChild(div);
  }
  $('paused').hidden = true;
  $('summary').hidden = false;
}

$('btn-export').addEventListener('click', () => {
  const xml = buildTcx({ startTime: ride.startedAt, name: selected.route.name, samples: ride.samples });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([xml], { type: 'application/vnd.garmin.tcx+xml' }));
  const d = new Date(ride.startedAt);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  a.download = `indoor-warrior-${stamp}.tcx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('btn-again').addEventListener('click', () => {
  ride = newRide();
  $('summary').hidden = true;
  $('hud').hidden = true;
  $('setup').hidden = false;
});

window.addEventListener('beforeunload', (e) => {
  if (ride.state === 'riding' || ride.state === 'paused') e.preventDefault();
});

function recordSample() {
  const s = selected.route.sample(ride.distance);
  ride.samples.push({
    time: ride.startedAt + ride.elapsed * 1000,
    distance: ride.distance,
    speed: ride.speed,
    power: currentPower(),
    cadence: live.cadence,
    hr: live.hr,
    ele: s.y,
    lat: s.lat,
    lon: s.lon,
  });
}

// ---------- game loop ----------
const currentPower = () => (performance.now() - live.lastDataAt < 3000 ? live.power : 0);

function tick(dt) {
  const route = selected.route;
  const here = route.sample(ride.distance);
  ride.speed = stepSpeed(ride.speed, currentPower(), here.grade, dt, riderModel());
  ride.distance += ride.speed * dt;
  ride.elapsed += dt;

  for (const bot of ride.bots) {
    const g = route.sample(bot.distance).grade;
    bot.speed = stepSpeed(bot.speed, bot.wkg * BOT_RIDER.riderKg, g, dt, BOT_RIDER);
    bot.distance += bot.speed * dt;
    if (!route.loop) bot.distance = Math.min(bot.distance, route.length);
  }

  if (!route.loop && ride.distance >= route.length) {
    ride.distance = route.length;
    finishRide();
  }

  const ele = route.sample(ride.distance).y;
  if (ele > ride.lastEle) ride.ascent += ele - ride.lastEle;
  ride.lastEle = ele;

  // Look a second ahead so the trainer's resistance change lands as you reach the slope.
  const ahead = route.sample(ride.distance + ride.speed).grade;
  trainer?.setGrade(ahead * (settings.difficulty / 100));

  ride.sampleClock += dt;
  if (ride.sampleClock >= 1) {
    ride.sampleClock -= 1;
    recordSample();
  }
}

let hudClock = 0;
function updateHud() {
  const route = selected.route;
  const s = route.sample(ride.distance);
  const power = currentPower();
  $('m-power').textContent = power;
  $('m-wkg').textContent = (power / settings.riderKg).toFixed(1);
  $('m-cadence').textContent = performance.now() - live.lastDataAt < 3000 ? live.cadence : 0;
  $('m-speed').textContent = (ride.speed * 3.6).toFixed(1);
  $('m-hr').textContent = live.hr ?? '--';
  $('m-distance').textContent = formatKm(ride.distance);
  $('m-time').textContent = formatDuration(ride.elapsed);
  $('m-ascent').textContent = Math.round(ride.ascent);
  if (route.loop) {
    $('m-togo-label').textContent = 'Lap';
    $('m-togo').textContent = `${Math.floor(ride.distance / route.length) + 1}`;
    $('m-togo-unit').textContent = `· ${formatKm(route.length - s.distance)} km left`;
  } else {
    $('m-togo-label').textContent = 'To go';
    $('m-togo').textContent = formatKm(route.length - ride.distance);
    $('m-togo-unit').textContent = 'km';
  }
  const grade = $('grade');
  grade.textContent = `${(s.grade * 100).toFixed(1)}%`;
  grade.style.color = gradeColor(s.grade);

  const board = [{ name: 'You', distance: ride.distance, color: PLAYER_COLOR, me: true }, ...ride.bots].sort(
    (a, b) => b.distance - a.distance,
  );
  const list = $('leaderboard');
  list.innerHTML = '';
  for (const r of board) {
    const li = document.createElement('li');
    if (r.me) li.className = 'me';
    const gap = Math.round(r.distance - ride.distance);
    li.innerHTML = '<span class="dot"></span><span class="name"></span><span class="gap"></span>';
    li.querySelector('.dot').style.background = hex(r.color);
    li.querySelector('.name').textContent = r.me ? 'You' : `${r.name} (${r.wkg} W/kg)`;
    li.querySelector('.gap').textContent = r.me ? '' : `${gap > 0 ? '+' : ''}${gap} m`;
    list.appendChild(li);
  }

  profile.draw([
    ...ride.bots.map((b) => ({ distance: b.distance, color: hex(b.color), size: 3 })),
    { distance: ride.distance, color: '#ffffff', size: 5 },
  ]);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (ride.state === 'riding') tick(dt);
  const moving = ride.state === 'riding';
  world?.update(
    dt,
    { distance: ride.distance, speed: moving ? ride.speed : 0, cadence: moving ? live.cadence : 0 },
    ride.bots.map((b) => ({ distance: b.distance, speed: moving ? b.speed : 0, cadence: moving ? b.cadence : 0 })),
  );
  hudClock += dt;
  if (ride.state !== 'setup' && hudClock > 0.1) {
    hudClock = 0;
    updateHud();
  }
  requestAnimationFrame(frame);
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 5000);
}

renderRouteList();
selectRoute(selected);
updateStartButton();
requestAnimationFrame(frame);

// Handy for debugging from the console.
window.indoorWarrior = { get ride() { return ride; }, live, settings, get trainer() { return trainer; } };
