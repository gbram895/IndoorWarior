import CoreBluetooth
import Foundation

enum GATT {
    static let cyclingPower = CBUUID(string: "1818")
    static let fitnessMachine = CBUUID(string: "1826")

    static let cyclingPowerMeasurement = CBUUID(string: "2A63")
    static let cyclingPowerFeature = CBUUID(string: "2A65")
    static let indoorBikeData = CBUUID(string: "2AD2")
    static let fitnessMachineFeature = CBUUID(string: "2ACC")
    static let supportedPowerRange = CBUUID(string: "2AD8")
    static let fitnessMachineControlPoint = CBUUID(string: "2AD9")

    static let manufacturerName = CBUUID(string: "2A29")
    static let modelNumber = CBUUID(string: "2A24")
    static let firmwareRevision = CBUUID(string: "2A26")

    /// Names for the services and characteristics worth recognising in the
    /// trainer report. Anything else is listed by UUID.
    static let names: [CBUUID: String] = [
        CBUUID(string: "1818"): "Cycling Power",
        CBUUID(string: "1826"): "Fitness Machine (FTMS)",
        CBUUID(string: "1816"): "Cycling Speed and Cadence",
        CBUUID(string: "180D"): "Heart Rate",
        CBUUID(string: "180A"): "Device Information",
        CBUUID(string: "180F"): "Battery",
        CBUUID(string: "2A63"): "Cycling Power Measurement",
        CBUUID(string: "2A65"): "Cycling Power Feature",
        CBUUID(string: "2A66"): "Cycling Power Control Point",
        CBUUID(string: "2AD2"): "Indoor Bike Data",
        CBUUID(string: "2ACC"): "Fitness Machine Feature",
        CBUUID(string: "2AD3"): "Training Status",
        CBUUID(string: "2AD6"): "Supported Resistance Range",
        CBUUID(string: "2AD8"): "Supported Power Range",
        CBUUID(string: "2AD9"): "Fitness Machine Control Point",
        CBUUID(string: "2ADA"): "Fitness Machine Status",
        // Proprietary trainer control, for trainers without FTMS control.
        CBUUID(string: "A026E005-0A7D-4AB3-97FA-F1500F9FEB8B"): "Wahoo trainer control (proprietary)",
        CBUUID(string: "6E40FEC1-B5A3-F393-E0A9-E50E24DCCA9E"): "Tacx FE-C over BLE (proprietary)",
    ]

    static func name(_ uuid: CBUUID) -> String {
        names[uuid] ?? uuid.uuidString
    }
}

/// What the connected trainer says about itself. Shown in the app and
/// copyable as text, so it can be pasted back when planning ERG control.
struct TrainerReport {
    var manufacturer: String?
    var model: String?
    var firmware: String?
    var services: [String] = []
    var characteristics: [String] = []
    var features: FitnessMachineFeatures?
    var powerRange: SupportedPowerRange?
    var hasControlPoint = false
    var cyclingPowerFeatureBits: UInt32?
    var errors: [String] = []

    var ergVerdict: String {
        if let features {
            if features.supportsPowerTarget && hasControlPoint {
                return "Yes. FTMS power target is supported, so ERG can use the standard control point."
            }
            if hasControlPoint {
                return "Not through FTMS power targets. The control point exists but power target is not advertised."
            }
            return "FTMS features are readable, but no control point was found."
        }
        if characteristics.contains(where: { $0.hasPrefix("Wahoo") || $0.hasPrefix("Tacx") }) {
            return "No FTMS, but a proprietary control channel is present (see below)."
        }
        return "Unknown. The trainer does not expose FTMS."
    }

    var summary: String {
        var lines: [String] = []
        lines.append("Trainer: \(manufacturer ?? "?") \(model ?? "?") (firmware \(firmware ?? "?"))")
        lines.append("ERG: \(ergVerdict)")
        if let f = features {
            lines.append("FTMS targets: power \(f.supportsPowerTarget), resistance \(f.supportsResistanceTarget), simulation \(f.supportsSimulation), spin-down \(f.supportsSpinDown)")
            lines.append("FTMS reports: power \(f.reportsPower), cadence \(f.reportsCadence), heart rate \(f.reportsHeartRate)")
            lines.append(String(format: "FTMS feature raw: machine 0x%08X, targets 0x%08X", f.machine, f.targets))
        }
        if let r = powerRange {
            lines.append("Power range: \(r.minimum)-\(r.maximum) W in \(r.increment) W steps")
        }
        if let bits = cyclingPowerFeatureBits {
            lines.append(String(format: "Cycling Power feature raw: 0x%08X", bits))
        }
        lines.append("Services: " + services.joined(separator: ", "))
        lines.append("Characteristics: " + characteristics.joined(separator: ", "))
        if !errors.isEmpty { lines.append("Errors: " + errors.joined(separator: "; ")) }
        return lines.joined(separator: "\n")
    }
}

final class TrainerConnection: NSObject, ObservableObject {
    struct FoundTrainer: Identifiable {
        let id: UUID
        let peripheral: CBPeripheral
        var name: String
        var rssi: Int
        var advertises: String
    }

    enum Phase: Equatable {
        case unavailable(String)
        case idle
        case scanning
        case connecting(String)
        case connected(String)
        case disconnected(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var found: [FoundTrainer] = []

    @Published private(set) var power: Int?
    @Published private(set) var threeSecondPower: Int?
    @Published private(set) var cyclingPowerWatts: Int?
    @Published private(set) var ftmsWatts: Int?
    @Published private(set) var cadence: Double?
    @Published private(set) var speedKmh: Double?
    @Published private(set) var heartRate: Int?
    @Published private(set) var lastPacket: Date?
    @Published private(set) var report = TrainerReport()

    private var central: CBCentralManager!
    private var trainer: CBPeripheral?
    private var wantsScan = false
    private var crank = CrankCadence()
    private var powerSamples: [(at: Date, watts: Int)] = []

    override init() {
        super.init()
        // nil queue: delegate callbacks arrive on the main queue, which is
        // where @Published changes need to happen.
        central = CBCentralManager(delegate: self, queue: nil)
    }

    func startScan() {
        wantsScan = true
        found = []
        guard central.state == .poweredOn else { return }
        phase = .scanning
        central.scanForPeripherals(
            withServices: [GATT.cyclingPower, GATT.fitnessMachine],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
    }

    func stopScan() {
        wantsScan = false
        central.stopScan()
        if phase == .scanning { phase = .idle }
    }

    func connect(_ item: FoundTrainer) {
        stopScan()
        resetReadings()
        trainer = item.peripheral
        phase = .connecting(item.name)
        central.connect(item.peripheral)
    }

    func disconnect() {
        if let trainer { central.cancelPeripheralConnection(trainer) }
    }

    private func resetReadings() {
        power = nil
        threeSecondPower = nil
        cyclingPowerWatts = nil
        ftmsWatts = nil
        cadence = nil
        speedKmh = nil
        heartRate = nil
        lastPacket = nil
        report = TrainerReport()
        crank = CrankCadence()
        powerSamples = []
    }

    private func record(watts: Int) {
        let now = Date()
        power = watts
        lastPacket = now
        powerSamples.append((at: now, watts: watts))
        powerSamples.removeAll { now.timeIntervalSince($0.at) > 3 }
        threeSecondPower = powerSamples.map(\.watts).reduce(0, +) / max(powerSamples.count, 1)
    }
}

extension TrainerConnection: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if case .unavailable = phase { phase = .idle }
            if wantsScan { startScan() }
        case .unauthorized:
            phase = .unavailable("Bluetooth permission is off. Turn it on in Settings › IndoorWarior.")
        case .poweredOff:
            phase = .unavailable("Bluetooth is off.")
        case .unsupported:
            phase = .unavailable("This device has no Bluetooth LE. The Simulator cannot use Bluetooth; run on an iPhone.")
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = peripheral.name
            ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String
            ?? "Unnamed trainer"
        let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let advertises = services.map(GATT.name).joined(separator: ", ")
        if let i = found.firstIndex(where: { $0.id == peripheral.identifier }) {
            found[i].rssi = RSSI.intValue
        } else {
            found.append(FoundTrainer(id: peripheral.identifier, peripheral: peripheral,
                                      name: name, rssi: RSSI.intValue, advertises: advertises))
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        phase = .connected(peripheral.name ?? "Trainer")
        peripheral.delegate = self
        // Discover everything, not just the two cycling services, so the
        // report shows proprietary control channels too.
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        phase = .disconnected("Could not connect: \(error?.localizedDescription ?? "unknown error")")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        phase = .disconnected(error.map { "Connection lost: \($0.localizedDescription)" } ?? "Disconnected.")
        trainer = nil
    }
}

extension TrainerConnection: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { report.errors.append("services: \(error.localizedDescription)") }
        for service in peripheral.services ?? [] {
            report.services.append(GATT.name(service.uuid))
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error { report.errors.append("characteristics of \(GATT.name(service.uuid)): \(error.localizedDescription)") }
        for c in service.characteristics ?? [] {
            report.characteristics.append(GATT.name(c.uuid))
            switch c.uuid {
            case GATT.cyclingPowerMeasurement, GATT.indoorBikeData:
                peripheral.setNotifyValue(true, for: c)
            case GATT.fitnessMachineFeature, GATT.supportedPowerRange, GATT.cyclingPowerFeature,
                 GATT.manufacturerName, GATT.modelNumber, GATT.firmwareRevision:
                peripheral.readValue(for: c)
            case GATT.fitnessMachineControlPoint:
                // Present is all the spike checks. ERG would write Request
                // Control (0x00) then Set Target Power (0x05) here.
                report.hasControlPoint = true
            default:
                break
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if let error { report.errors.append("subscribe \(GATT.name(characteristic.uuid)): \(error.localizedDescription)") }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error {
            report.errors.append("read \(GATT.name(characteristic.uuid)): \(error.localizedDescription)")
            return
        }
        guard let data = characteristic.value else { return }

        switch characteristic.uuid {
        case GATT.cyclingPowerMeasurement:
            guard let m = CyclingPowerMeasurement(data) else { return }
            cyclingPowerWatts = m.power
            record(watts: m.power)
            if let revs = m.crankRevolutions, let time = m.lastCrankEventTime,
               let rpm = crank.update(revolutions: revs, eventTime: time) {
                cadence = rpm
            }

        case GATT.indoorBikeData:
            guard let d = IndoorBikeData(data) else { return }
            if let w = d.power {
                ftmsWatts = w
                record(watts: w)
            }
            if let rpm = d.cadenceRpm { cadence = rpm }
            if let s = d.speedKmh { speedKmh = s }
            if let hr = d.heartRate, hr > 0 { heartRate = hr }
            lastPacket = Date()

        case GATT.fitnessMachineFeature:
            report.features = FitnessMachineFeatures(data)
        case GATT.supportedPowerRange:
            report.powerRange = SupportedPowerRange(data)
        case GATT.cyclingPowerFeature:
            var r = ByteReader(data)
            report.cyclingPowerFeatureBits = r.uint32()
        case GATT.manufacturerName:
            report.manufacturer = String(decoding: data, as: UTF8.self)
        case GATT.modelNumber:
            report.model = String(decoding: data, as: UTF8.self)
        case GATT.firmwareRevision:
            report.firmware = String(decoding: data, as: UTF8.self)
        default:
            break
        }
    }
}
