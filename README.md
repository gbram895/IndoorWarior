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

When you are signed in to Gradient, **Finish** also uploads the ride to
Strava through Gradient's existing Strava connection (`POST
/api/health/strava/upload` on Gradient). The first time, Strava has to grant
Gradient upload permission; the page shows an **Allow uploads to Strava**
button for that. Uploads use a fixed external id per ride, so a retry cannot
create a duplicate.

Keep the page in front while riding: Chrome slows timers in background tabs,
which would delay step changes.

## Running it

1. Make sure the laptop's Bluetooth is on (Windows 10 or 11).
2. Close Zwift or any other app connected to the trainer. Most trainers
   accept only one or two Bluetooth connections.
3. Double-click `web/index.html`, opening it in **Chrome or Edge**. Firefox
   has no Web Bluetooth.
4. Pedal to wake the trainer, press **Connect trainer**, and pick it in the
   browser's pop-up.

## Testing without a trainer

The parsers sit in the `BLE` object at the top of the page script. They
were checked against hand-built packets, and the whole connect flow against a
mocked trainer, in headless Chromium.
