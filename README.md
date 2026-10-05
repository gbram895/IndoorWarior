# Indoor Warrior

An indoor cycling game that runs in your browser. Pedal on your smart trainer:
it reports your power, the game turns that into speed through a 3D world, and
it tells the trainer to raise or lower resistance as the road climbs and descends.

## Quick start

```bash
npm start            # serves the game at http://localhost:8080
# or: python3 -m http.server 8080
```

Open **http://localhost:8080** in **Chrome or Edge** (desktop or Android).
Web Bluetooth only works in Chromium browsers and only on `https://` or
`localhost`. On iPhone/iPad, use the Bluefy browser.

1. Pick a world: Meadow Spin, Warrior Coast Loop or Volcano Ascent. Or import a
   **GPX file** of a real-world route (export one from Strava, Komoot, RideWithGPS…).
2. Click **Connect Bluetooth trainer**, pedal to wake the trainer and pick it.
   No trainer handy? Use **Use simulated trainer** and set power with the slider or ↑/↓.
3. Set your weight and trainer difficulty, then **Start ride**.
4. When you're done, click **Finish** and download a **TCX** file to upload to Strava.

## Van Rysel D100 notes

The D100 speaks Bluetooth **FTMS**, which this game uses for both reading
power/cadence and setting resistance.

- A trainer only accepts **one Bluetooth controller at a time**. Close the
  Decathlon app, Zwift and similar apps (on every phone/tablet/PC) first. If the
  status says *"control not permitted"*, another app is still holding it.
- Pedal a few turns before connecting; the trainer goes to sleep when idle.
- Run a calibration/spindown in the Decathlon app occasionally for accurate power.
- **Difficulty** works like Zwift's "trainer difficulty": at 50% a 10% climb feels
  like 5% on the trainer. Your in-game speed always uses the real gradient.

## How it works

| File | Purpose |
|---|---|
| `src/ftms.js` | Web Bluetooth: FTMS data + control point (gradient simulation), Cycling Power fallback, heart-rate strap |
| `src/physics.js` | Power → speed model (gravity, rolling resistance, aero drag) |
| `src/route.js` | Route resampling, smoothed elevation/gradient, GPX import |
| `src/routes.js` | Built-in fictional worlds |
| `src/terrain.js` | Procedural terrain that hugs the road |
| `src/world.js` | Three.js scene: road, terrain, trees, water, animated riders, chase camera |
| `src/main.js` | Game loop, HUD, rivals, recording |
| `src/tcx.js` | Ride export |

The game samples the gradient about one second ahead of you and sends it to
the trainer at most once per second, so the resistance changes as you reach a slope.

Three rivals ride at a fixed 2.0, 2.8 and 3.6 W/kg so you have someone to chase.

## Tests

```bash
npm test
```

Covers the physics, FTMS byte parsing/encoding, route/GPX handling, terrain and TCX export.

## Ideas for next steps

- ERG mode and structured workouts (FTMS "set target power", op `0x05`)
- Online multiplayer (WebSocket server broadcasting rider positions)
- Real-world 3D terrain from map elevation tiles for GPX routes
- FIT export and direct Strava upload
- Avatar customisation, achievements, unlockable worlds
