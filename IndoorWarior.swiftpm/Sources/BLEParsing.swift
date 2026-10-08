import Foundation

// Parsers for the standard Bluetooth SIG cycling characteristics. Pure
// Foundation, no CoreBluetooth, so they can be unit tested on their own.
// All multi-byte fields are little-endian.

struct ByteReader {
    private let bytes: [UInt8]
    private(set) var offset = 0

    init(_ data: Data) { bytes = [UInt8](data) }

    var remaining: Int { bytes.count - offset }

    mutating func skip(_ count: Int) -> Bool {
        guard remaining >= count else { return false }
        offset += count
        return true
    }

    mutating func uint8() -> UInt8? {
        guard remaining >= 1 else { return nil }
        defer { offset += 1 }
        return bytes[offset]
    }

    mutating func uint16() -> UInt16? {
        guard remaining >= 2 else { return nil }
        defer { offset += 2 }
        return UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8
    }

    mutating func sint16() -> Int16? {
        uint16().map { Int16(bitPattern: $0) }
    }

    mutating func uint32() -> UInt32? {
        guard remaining >= 4 else { return nil }
        defer { offset += 4 }
        return UInt32(bytes[offset])
            | UInt32(bytes[offset + 1]) << 8
            | UInt32(bytes[offset + 2]) << 16
            | UInt32(bytes[offset + 3]) << 24
    }
}

/// Cycling Power Measurement (0x2A63), Cycling Power service (0x1818).
/// Flags (uint16), instantaneous power (sint16, W), then optional fields in
/// flag order. Only the fields up to crank revolution data are read.
struct CyclingPowerMeasurement: Equatable {
    var power: Int = 0
    var crankRevolutions: UInt16?
    /// Last crank event time, in 1/1024 s. Wraps at 65536.
    var lastCrankEventTime: UInt16?

    init?(_ data: Data) {
        var r = ByteReader(data)
        guard let flags = r.uint16(), let watts = r.sint16() else { return nil }
        power = Int(watts)
        if flags & 0x0001 != 0 { guard r.skip(1) else { return nil } } // pedal power balance
        if flags & 0x0004 != 0 { guard r.skip(2) else { return nil } } // accumulated torque
        if flags & 0x0010 != 0 { guard r.skip(6) else { return nil } } // wheel revolution data
        if flags & 0x0020 != 0 {                                         // crank revolution data
            guard let revs = r.uint16(), let time = r.uint16() else { return nil }
            crankRevolutions = revs
            lastCrankEventTime = time
        }
    }
}

/// Indoor Bike Data (0x2AD2), Fitness Machine service (0x1826).
/// Trainers may split a reading across several notifications, so every
/// field is optional and the caller merges what is present.
struct IndoorBikeData: Equatable {
    var speedKmh: Double?
    var cadenceRpm: Double?
    var resistanceLevel: Int?
    var power: Int?
    var heartRate: Int?

    init?(_ data: Data) {
        var r = ByteReader(data)
        guard let flags = r.uint16() else { return nil }
        func has(_ bit: UInt16) -> Bool { flags & (1 << bit) != 0 }

        // Bit 0 is "More Data": instantaneous speed is present when it is CLEAR.
        if !has(0) {
            guard let v = r.uint16() else { return nil }
            speedKmh = Double(v) / 100
        }
        if has(1) { guard r.skip(2) else { return nil } } // average speed
        if has(2) {
            guard let v = r.uint16() else { return nil }
            cadenceRpm = Double(v) / 2
        }
        if has(3) { guard r.skip(2) else { return nil } } // average cadence
        if has(4) { guard r.skip(3) else { return nil } } // total distance (uint24)
        if has(5) {
            guard let v = r.sint16() else { return nil }
            resistanceLevel = Int(v)
        }
        if has(6) {
            guard let v = r.sint16() else { return nil }
            power = Int(v)
        }
        if has(7) { guard r.skip(2) else { return nil } } // average power
        if has(8) { guard r.skip(5) else { return nil } } // expended energy
        if has(9) {
            guard let v = r.uint8() else { return nil }
            heartRate = Int(v)
        }
        // Metabolic equivalent, elapsed and remaining time are not needed.
    }
}

/// Fitness Machine Feature (0x2ACC): what the machine reports, and which
/// targets it accepts through the Fitness Machine Control Point (0x2AD9).
struct FitnessMachineFeatures: Equatable {
    let machine: UInt32
    let targets: UInt32

    init?(_ data: Data) {
        var r = ByteReader(data)
        guard let m = r.uint32(), let t = r.uint32() else { return nil }
        machine = m
        targets = t
    }

    /// ERG mode: the app sets a wattage and the trainer holds it.
    var supportsPowerTarget: Bool { targets & (1 << 3) != 0 }
    var supportsResistanceTarget: Bool { targets & (1 << 2) != 0 }
    /// Grade/wind/rolling resistance simulation (what Zwift's SIM mode uses).
    var supportsSimulation: Bool { targets & (1 << 13) != 0 }
    var supportsSpinDown: Bool { targets & (1 << 15) != 0 }

    var reportsCadence: Bool { machine & (1 << 1) != 0 }
    var reportsPower: Bool { machine & (1 << 14) != 0 }
    var reportsHeartRate: Bool { machine & (1 << 10) != 0 }
}

/// Supported Power Range (0x2AD8): sint16 min W, sint16 max W, uint16 step W.
struct SupportedPowerRange: Equatable {
    let minimum: Int
    let maximum: Int
    let increment: Int

    init?(_ data: Data) {
        var r = ByteReader(data)
        guard let lo = r.sint16(), let hi = r.sint16(), let step = r.uint16() else { return nil }
        minimum = Int(lo)
        maximum = Int(hi)
        increment = Int(step)
    }
}

/// Turns cumulative crank revolutions into cadence. The trainer repeats the
/// last event while you stop pedalling, so cadence drops to 0 after 3 s
/// without a new revolution.
struct CrankCadence {
    private var last: (revs: UInt16, time: UInt16)?
    private var lastAdvance = Date.distantPast
    private(set) var rpm: Double?

    mutating func update(revolutions: UInt16, eventTime: UInt16, now: Date = Date()) -> Double? {
        guard let prev = last else {
            last = (revolutions, eventTime)
            lastAdvance = now
            return nil
        }
        let dRevs = revolutions &- prev.revs
        let dTime = eventTime &- prev.time
        guard dRevs > 0, dTime > 0 else {
            if now.timeIntervalSince(lastAdvance) > 3 { rpm = 0 }
            return rpm
        }
        last = (revolutions, eventTime)
        lastAdvance = now
        let value = Double(dRevs) * 60 * 1024 / Double(dTime)
        if value < 250 { rpm = value }
        return rpm
    }
}
