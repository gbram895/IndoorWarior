import SwiftUI
import UIKit

struct ContentView: View {
    @EnvironmentObject private var trainer: TrainerConnection

    var body: some View {
        NavigationStack {
            Group {
                if case .connected(let name) = trainer.phase {
                    LiveView(name: name)
                } else {
                    PickerView()
                }
            }
            .navigationTitle("IndoorWarior")
        }
        .onChange(of: trainer.phase) { _, phase in
            // Keep the screen on while riding.
            if case .connected = phase {
                UIApplication.shared.isIdleTimerDisabled = true
            } else {
                UIApplication.shared.isIdleTimerDisabled = false
            }
        }
    }
}

private struct PickerView: View {
    @EnvironmentObject private var trainer: TrainerConnection

    var body: some View {
        List {
            Section {
                switch trainer.phase {
                case .unavailable(let why):
                    Text(why).foregroundStyle(.red)
                case .scanning:
                    HStack {
                        ProgressView()
                        Text("Looking for trainers. Pedal to wake yours up.")
                    }
                case .connecting(let name):
                    HStack {
                        ProgressView()
                        Text("Connecting to \(name)…")
                    }
                case .disconnected(let why):
                    Text(why).foregroundStyle(.secondary)
                case .idle, .connected:
                    Text("Close Zwift or any other app using the trainer, then scan.")
                        .foregroundStyle(.secondary)
                }
                if trainer.phase == .scanning {
                    Button("Stop scanning") { trainer.stopScan() }
                } else {
                    Button("Scan for trainers") { trainer.startScan() }
                }
            }

            if !trainer.found.isEmpty {
                Section("Found") {
                    ForEach(trainer.found) { item in
                        Button {
                            trainer.connect(item)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name).font(.headline)
                                Text(item.advertises.isEmpty ? "Signal \(item.rssi) dBm" : "\(item.advertises) · \(item.rssi) dBm")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct LiveView: View {
    @EnvironmentObject private var trainer: TrainerConnection
    let name: String
    @State private var copied = false

    var body: some View {
        List {
            Section {
                VStack(spacing: 4) {
                    Text(trainer.power.map { "\($0)" } ?? "--")
                        .font(.system(size: 96, weight: .bold, design: .rounded))
                        .monospacedDigit()
                    Text("watts").foregroundStyle(.secondary)
                    Text("3s average \(trainer.threeSecondPower.map { "\($0) W" } ?? "--")")
                        .font(.title3)
                        .monospacedDigit()
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical)

                LabeledContent("Cadence", value: trainer.cadence.map { "\(Int($0.rounded())) rpm" } ?? "--")
                LabeledContent("Speed", value: trainer.speedKmh.map { String(format: "%.1f km/h", $0) } ?? "--")
                if let hr = trainer.heartRate {
                    LabeledContent("Heart rate", value: "\(hr) bpm")
                }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(freshness(at: context.date))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text(name)
            }

            Section("Power by source") {
                LabeledContent("Cycling Power service", value: trainer.cyclingPowerWatts.map { "\($0) W" } ?? "not sending")
                LabeledContent("FTMS Indoor Bike Data", value: trainer.ftmsWatts.map { "\($0) W" } ?? "not sending")
            }

            Section("What this trainer supports") {
                LabeledContent("Trainer", value: [trainer.report.manufacturer, trainer.report.model]
                    .compactMap { $0 }.joined(separator: " ").nonEmpty ?? "reading…")
                Text("ERG: \(trainer.report.ergVerdict)")
                if let range = trainer.report.powerRange {
                    LabeledContent("Power range", value: "\(range.minimum)–\(range.maximum) W")
                }
                Button(copied ? "Copied" : "Copy trainer report") {
                    UIPasteboard.general.string = trainer.report.summary
                    copied = true
                }
            }

            Section {
                Button("Disconnect", role: .destructive) { trainer.disconnect() }
            }
        }
    }

    private func freshness(at now: Date) -> String {
        guard let last = trainer.lastPacket else { return "Waiting for the first reading…" }
        let age = now.timeIntervalSince(last)
        return age < 2 ? "Live" : "No data for \(Int(age)) s"
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
