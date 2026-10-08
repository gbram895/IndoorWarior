# IndoorWarior

Indoor training app for iPhone. Native Swift, because Safari on iOS has no
Web Bluetooth, so a web page cannot talk to a smart trainer.

## Current state: trainer connection spike

`IndoorWarior.swiftpm` is a small app that:

- scans for trainers advertising the standard **Cycling Power** (0x1818) or
  **Fitness Machine / FTMS** (0x1826) Bluetooth services,
- connects and shows live power (big number plus 3 s average), cadence and
  speed, and which service each power reading came from,
- reads what the trainer supports: make, model, firmware, the FTMS feature
  bits (power target = ERG, resistance, simulation, spin-down), the supported
  power range, whether the FTMS control point exists, and any proprietary
  Wahoo or Tacx control channel,
- has a **Copy trainer report** button that puts all of that on the clipboard.

ERG control is not built yet; the report says whether the trainer can do it
through standard FTMS.

## Running it

Bluetooth does not work in the iOS Simulator, so this has to run on a real
iPhone or iPad.

**With a Mac (Xcode 15 or later):** double-click `IndoorWarior.swiftpm`, pick
your iPhone as the run destination, set your Apple ID team under Signing &
Capabilities, and press Run. On the phone, allow Bluetooth when asked.

**Without a Mac:** open `IndoorWarior.swiftpm` in Swift Playgrounds on an iPad
and run it there.

Then: close Zwift or any other app connected to the trainer (most trainers
accept only one or two Bluetooth connections), pedal to wake the trainer, tap
**Scan for trainers**, and tap yours.

## Layout

| File | What it does |
| --- | --- |
| `Package.swift` | App package definition, including the Bluetooth permission text |
| `Sources/BLEParsing.swift` | Byte parsers for Cycling Power Measurement, Indoor Bike Data, FTMS features and power range |
| `Sources/TrainerConnection.swift` | CoreBluetooth scanning, connecting, subscribing, and the trainer report |
| `Sources/ContentView.swift` | Trainer list and the live power screen |
