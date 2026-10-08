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

ERG control is not built yet; the report says whether the trainer can do it
through standard FTMS.

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
