# IndoorWarior

Indoor training app that runs in Chrome or Edge on a Windows laptop and talks
to a smart trainer over Bluetooth (Web Bluetooth). No install and no build
step.

## Current state: trainer connection spike

`web/index.html` is one self-contained page that:

- connects to a trainer advertising the standard **Cycling Power** (0x1818)
  or **Fitness Machine / FTMS** (0x1826) Bluetooth services,
- shows live power (big number plus 3 s average), cadence and speed, and
  which service each power reading came from,
- reads what the trainer supports: make, model, firmware, the FTMS feature
  bits (power target = ERG, resistance, simulation, spin-down), the supported
  power range, whether the FTMS control point exists, and any proprietary
  Wahoo or Tacx control channel,
- has a **Copy trainer report** button that puts all of that on the clipboard.

## ERG

The ERG panel has an on/off switch and a target (buttons, slider, or keys:
E toggles, arrow keys change by 5 W, Shift+arrows by 25 W). On sends FTMS
Request Control, Start and Set Target Power to the control point (0x2AD9),
one command at a time, each waiting for the trainer's answer. Off switches the
trainer to flat-road simulation (grade 0 %) instead of leaving the last
target, or sends Reset on trainers without simulation. If another app takes
control, ERG turns itself off without grabbing control back.

If the trainer's Bluetooth drops, the page reconnects by itself (up to five
tries) and puts ERG back as it was; during a workout the current step's
target is sent again. **Disconnect** does not reconnect.

## Calibration

On a trainer that supports it (Bram's does), the Calibration panel runs the
trainer's own FTMS spin-down: it names a speed, you ride above it, then stop
pedalling and let it coast; the trainer sets its power reading from how it
slows down. The page shows your speed and what to do at each stage, says when
it is done or failed, and remembers when you last calibrated. ERG is switched
off for it, and it is not available during a ride. Best done warm, after
about 10 minutes of riding.

## Riding today's plan

The Ride panel signs in to Gradient once (only the token is stored, in the
browser), loads today's planned ride from `/api/training-plan/today` and your
FTP from `/api/settings/thresholds`, and plays it step by step: ERG is set to
FTP × the step's % for each step, free steps (and steps aimed at heart rate or
pace) switch ERG off, and −5% / +5% scales the whole workout. Pause turns ERG
off so it never holds watts while you are not pedalling. Without a plan,
**Start free ride** just records.

Every ride is recorded once a second (power, cadence, speed, heart rate) and
kept in the browser until it is saved or discarded, so a closed tab does not
lose it. **Save .fit** downloads a standard FIT activity (indoor cycling) to
upload to Strava or Garmin Connect, which Gradient already syncs from.
Each workout step is saved as its own lap, so Strava and Gradient show the
intervals; riding on after the workout ends is one more lap.

When you are signed in to Gradient, **Finish** also uploads the ride to
Strava through Gradient's existing Strava connection (`POST
/api/health/strava/upload` on Gradient). The first time, Strava has to grant
Gradient upload permission; the page shows an **Allow uploads to Strava**
button for that. Uploads use a fixed external id per ride, so a retry cannot
create a duplicate.

**Choose from library** lists every ride in your Dropbox workout library, as
Gradient parses it (`GET /api/workout-library`, bike workouts with steps
only). Search by name, filter by Endurance, Tempo, Threshold or VO2max, or
sort shortest first; each row shows the length and a small profile. Picking
one loads it exactly like today's plan.

**My workouts** is a workout builder for your own sessions. The profile is
the main control: grab anywhere in a block's column and drag up or down to
change its power (5% steps, Shift for 1%) or sideways to change its length;
the first few pixels of movement decide which. Press and hold a block to lift
it and drag it to a new place. Power resists past its 20% and 300% limits and
eases back on release. The profile labels its FTP line and time grid, and a
dashed orange line shows where the next block will go (after the selected
one; Esc to add at the end). Below it, preset chips (warm-up, endurance,
tempo, sweet spot, threshold, VO2max, 30/30s, sprints, cool-down) add a
block, and each block is also a row of numbers: steps (duration and % of
FTP, empty to ride it free) and intervals (repeats of an effort and a
recovery), with watts at your FTP. Arrow keys nudge a field (Shift for
bigger steps), Alt+arrows move the block; blocks can be duplicated and
removed, and Undo (or Ctrl+Z) takes back the last change. Unsaved changes
are kept: Cancel offers an Undo, and after closing the tab My workouts
offers to resume them. Deleting a saved workout offers an Undo instead of a
confirm box. Durations are minutes (`45`), minutes and
seconds (`4:30`) or hours too (`1:05:00`). Workouts are kept in this browser;
**Load** rides one exactly like a library workout, at your FTP from Gradient,
or at the FTP set in the builder when you are not signed in.

During a ride a live chart shows the last 4 minutes of power (3 s smoothed),
heart rate and the ERG target, with the workout's next 6 minutes drawn ahead
of the "now" line as coloured blocks with their watts. On a free ride it shows
the last 10 minutes.

In the last 5 seconds of each workout step a big countdown shows the next
target, with a short beep at 3, 2 and 1 and a long one as the step changes
(turn the beeps off under the workout).

Under a finished ride, **How hard did it feel?** takes an RPE from 1 to 10
and optional notes. Once the ride is on Strava they are saved on its Gradient
workout (`POST /api/health/strava/ride-feedback`), where the next day's plan
reads the RPE. Gradient syncs Strava first if it has not picked the ride up.

Keep the page in front while riding: Chrome slows timers in background tabs,
which would delay step changes.

## Heart rate strap and power meter

Under the trainer button are **Connect** buttons for a heart rate strap
(Heart Rate service 0x180D) and a power meter (Cycling Power 0x1818). Each is
its own Bluetooth connection. While the power meter is sending, its power and
crank cadence are shown and recorded instead of the trainer's; the strap's
heart rate likewise wins over any the trainer relays. If either drops out the
page tries to reconnect three times, and falls back to the trainer's values
meanwhile.

**Power match** (on by default, a tick box in the ERG panel while a power
meter is connected): ERG holds the target on the power meter rather than the
trainer. The page keeps a slow average (about 20 s) of trainer watts ÷ power
meter watts while you pedal, within ±15%, and sends the trainer target × that
factor, so a 200 W target reads 200 W on the power meter even if the trainer
reads high or low. It resends at most every 5 s. If the power meter goes quiet
for 10 s, ERG falls back to the trainer's own reading and says so.

## Route

Load a GPX file (Strava or Komoot route export) in the Route panel. It draws
the route as a map and an elevation profile coloured by gradient. During a
ride your position moves at a road speed worked out from your power (rider +
bike mass, rolling resistance, air drag, gradient, with inertia). While ERG is
off, the trainer gets the gradient under you through FTMS Indoor Bike
Simulation, scaled by **Trainer difficulty** (50% by default, like Zwift);
while ERG is on, ERG wins. Rides on a route are saved with position and
elevation as a virtual ride, so Strava shows the map.

### 3D view

With a route loaded, the Route panel shows it in 3D by default (switch with
**3D / Map**; the choice is remembered). The road follows the GPX's real
shape and climbs. The land around it is made up from a fixed seed, so a route
always looks the same: it sits at the road's average height over 1.2 km rather
than copying the road, so a climb starts in a cutting and ends on a shoulder,
and on a climb the land rises on one side and falls away on the other.
The land is one height map for the whole area
(a strip that follows the road up close, 200 m tiles further out, built a
few tiles per frame nearest first), so it never folds over itself on a bend.
Mountains stand on a level horizon, there is a sky, textured asphalt and
grass, and the sun casts shadows near the rider.

Heights are drawn 1.6x steeper than they are, because a real 8% looks flat
from a chase camera; gradient, speed and the trainer use the real figures.

The rider and bike are built in code. The legs follow the pedals at your
cadence (two-bone IK from the hip to the pedal), the arms reach the hoods,
and on a real gradient above 6% the rider gets out of the saddle and rocks
the bike. **Camera** switches between behind, close behind and the roadside;
**Weather** between clear, cloudy, rain (falling rain, a wet road), fog and
snow (falling snow, snow lying on the land), or **real**: the weather at the
route's start right now, from [Open-Meteo](https://open-meteo.com);
**Full screen** fills the screen with the view, power, speed, gradient and
distance on top.

**Screenshot** and **Record** (bottom right of the view) capture the 3D view
with the place name and your power, speed, gradient, distance and heart rate
drawn in. A recording stops by itself after three minutes. During a ride they
wait in the browser until Gradient has them; when the ride ends Gradient
emails them to you (a long recording comes as a download link) and keeps them
on the workout as downloads. Without a ride running they go straight to the
Downloads folder. The email needs `RESEND_API_KEY` set on Gradient.

It uses three.js r149 (`web/vendor/three.min.js`, MIT, loaded only when the 3D
view is first shown) and `web/world3d.js`. Both are classic scripts so the
3D view also works when `index.html` is opened as a file. The world is built
once per route in 600 m pieces, so only the pieces near the rider are drawn.
If the browser has WebGL switched off, it falls back to the map.

#### The real place

For a GPX route the 3D view shows the place the route really runs through
(**World: real**, the default; **World: made up** goes back to the made-up
land). When the route opens, `web/places.js` fetches, straight from the
browser and free of any key:

- the land's height from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (about 13 m detail within a kilometre of the road, coarser out to 40 km);
- what the land looks like from above: EOX's
  [Sentinel-2 cloudless](https://s2maps.eu) satellite mosaic (Copernicus
  Sentinel data 2020, CC BY-NC-SA 4.0), at 10 m near the road and coarser on
  the far mountains. Close to the road it blends into the painted fields,
  which have the crop rows a 10 m photo can't show;
- lakes, rivers and streams, woods, built-up areas, buildings, vineyards,
  bare rock, glaciers, place names, named cols and country borders from
  [OpenStreetMap](https://www.openstreetmap.org/copyright) through the
  Overpass API (kept in the browser's cache, so a route opened again is
  instant).

The picture goes through a camera-like grade: highlights roll off instead of
clipping, a gentle S-curve gives the land depth, and the blacks lift slightly.
The road shows wear: darker wheel tracks in each lane, dusty cracked edges,
the odd sealed crack and patched rectangles. The rider wears a printed jersey,
a vented helmet and wraparound glasses; the bike has deep carbon rims and a
bottle.

**Look: video** (top right, on by default) films the view through a camera
instead of drawing it straight to the screen. The road and the land smear as
they would at a 1/50 s shutter while the rider stays sharp, bright sky and wet
road glow, the lens bends and fringes slightly toward its edges and darkens
its corners, and the picture has a fine grain. The camera drifts and sways a
little, as one on a following motorbike does, and buzzes with the road at
speed. **Look: plain** turns all of that off, if a slower laptop needs the
frames back. Needs WebGL 2; without it the button is hidden and the view is
plain.

The world shows made-up land until the heights are in, then is built again on
the real land, and again when the map arrives. A line under the view says
what is loading or what failed (and falls back to made-up land or made-up
woods), and carries the credits.

On the real land: the mountains on the horizon are the real ones out to
40 km, with snow above this month's snow line; lakes lie flat in their basins,
rivers run under the road, the sea reaches the coast. Woods stand where the
map has woods, spruce and larch from about 1,000 m up and none above the tree
line; farmland lies low down, meadows higher, then yellow alpine grass, scree
and bare rock on steep or high ground. Each building on the map near the road
stands as a house in the style of where it is: brick with dark roofs in the
north, stucco with terracotta and green shutters in the south, white and
timber with wide low roofs in the mountains. In Haute-Provence a third of the
fields are lavender. Hedges grow only in the lowland north.

Signs stand where they would: each town's name on the way in, crossed out on
the way out, in the country's colours; the col's name and height at its top
(with flags); the blue EU sign where the route crosses a border. The name
also shows over the view: the town, the col with the distance to its top
while climbing, and "Welcome to Italy" over a border.

#### IndoorWarior Island

**Ride IndoorWarior Island** (next to Load GPX) loads the built-in course
without a GPX: a 12.6 km loop with 183 m of climbing. A flat start through
farmland, a 2.4 km climb through woods at about 6% with a steeper kick near the
top, flags on an open summit, a long descent and a flat run home. It is defined
in `web/course.js` as points placed in the North Sea, so it rides, records and
uploads like any GPX route and its Strava map lands over open water rather
than someone's real roads. A loop (the course, or a GPX that ends where it
starts) keeps going round lap after lap.

All the scenery is built in code, on the course and on any GPX: farmland cut
into fields (pasture, meadow, wheat, young crops in rows, ploughed land, maize)
with grass margins and hedges on some edges, woods of spruce and broadleaf
trees, bushes on the verge, white marker posts and a gantry at the start and
finish. The ground's colours are painted into a texture per piece of land,
finer the closer it is, a few rows per frame; photographed grass and soil laid
on by position keep it crisp at the wheels, and the road is photographed grit.
The sky is a photograph with the sun where the shadows say it is. Grass blades
that sway in the wind grow along the verge for the stretch round the rider,
and trees and hedges carry see-through leaf and needle cards for a ragged
outline. Trees and hedges are grouped in 250 m squares, and squares past the
haze are skipped.

The photographs are in `web/vendor/photos.js` (loaded with the 3D view; without
it the land is painted plain): grass, soil and road grit from the
[Babylon.js assets](https://github.com/BabylonJS/Assets) (CC BY 4.0), and the
sky from Poly Haven's "Immenstadter Horn" (CC0).

## Di2 gears (experimental)

Shimano does not publish how Di2 reports gears over Bluetooth, so the gear
display is worked out from logs of a GRX RD-RX827. **Connect Di2** pairs with
the derailleur and shows the rear gear as Shimano numbers it (e.g. 11 of 12),
also as a tile next to cadence while a trainer is connected. It comes from
message type 0x00 on Shimano service 18ef, characteristic 2ac1: byte 5 is the
rear position and byte 6 the number of rear gears. Bytes 3-4 are 0xff on a 1x
bike and are read as the front position and count otherwise, which no 2x bike
has confirmed yet.

The page leaves Shimano's setup and pairing services (18fe, 18ff) alone:
reading them fails authentication and the derailleur drops the connection. If
the Di2 drops anyway, the page reconnects up to three times. A log of
everything the Di2 sends sits under **Di2 log** for troubleshooting. Close
E-TUBE first; Di2 accepts one app at a time.

## Riding with another tab in front

Browsers treat a background tab as low priority: its timers slow to once a
second (once a minute after about five minutes), and Bluetooth readings can
reach it in bunches a few seconds apart. Two things keep a ride live:

- The ride clock (workout steps and their ERG targets, route gradient, power
  match, recording) also beats from a small worker, whose timers are not
  slowed.
- **Mini window**: a small always-on-top window (Chrome or Edge 116+) with
  power, heart rate, cadence, the step target and time left. It opens when
  you press Start ride (untick "Open a mini window when I start" to stop
  that) or from the Mini window button mid-ride. While it is open the page
  counts as visible, so it is not treated as a background tab.

If heart rate still goes missing, the line under the live chart says why
(no skin contact, or nothing sent) and the longest wait between strap and
trainer messages with the tab in front and behind. The screen lock is dropped
while the tab is hidden and taken again when you come back, so check that
Windows is not set to sleep within the length of a ride.

## The app

`web/` is published to GitHub Pages by `.github/workflows/pages.yml`
whenever `main` changes. Open https://gbram895.github.io/IndoorWarior/ in
Chrome or Edge and use it as a page, or press **Install app** (or the
install icon in the address bar) to get it as a program with its own window
and Start menu entry. It loads without internet once opened, and a new
version shows up the next time it is opened. Double-clicking
`web/index.html` still works, for trying a change before it goes live.

Settings, workouts and the Gradient sign-in are kept per browser address, so
the app and the HTML file each have their own. **Your settings and
workouts** at the bottom of the page saves them to a file and loads them on
the other side.

## Running it

1. Make sure the laptop's Bluetooth is on (Windows 10 or 11).
2. Close Zwift or any other app connected to the trainer. Most trainers
   accept only one or two Bluetooth connections.
3. Double-click `web/index.html`, opening it in **Chrome or Edge**. Firefox
   has no Web Bluetooth.
4. Pedal to wake the trainer, press **Connect trainer**, and pick it in the
   browser's pop-up.

## Simulator

**Test without hardware** (top right, or open the page with `#sim` on the
end) swaps Web Bluetooth for virtual devices that speak the same services as
the real ones, so the whole page runs unchanged:

- a trainer copying Bram's (FTMS power, resistance, simulation and spin-down
  targets, 50-600 W, power and speed only) that answers ERG, gradient and
  reset commands on the control point,
- a power meter with crank cadence, a heart rate strap whose heart rate
  follows power with a lag, and a 12-speed Di2 broadcasting gear the way an
  RD-RX827 does.

The Simulator panel sets cadence, the rider's power while ERG is off, how far
the trainer reads above or below the power meter (to exercise power match),
and heart rate fitness. The virtual trainer also answers a spin-down
(20-30 km/h), and the virtual rider sprints and coasts as told. It can shift the Di2, drop any device to test
reconnects, and have "another app" take the trainer. Gradient sign-in stays
real; a finished simulator ride is not uploaded to Strava unless Upload is
pressed. **Connect everything** connects all four virtual devices at once, and
a ride started in the simulator with nothing connected does that by itself.
**Leave simulator** switches back.

## Testing without a trainer

The parsers sit in the `BLE` object at the top of the page script. They
were checked against hand-built packets, and the whole connect flow against a
mocked trainer, in headless Chromium.
