// swift-tools-version: 5.9

// An app package: open this folder (IndoorWarior.swiftpm) in Xcode, or in
// Swift Playgrounds on an iPad or Mac, and run it on a real device.
// CoreBluetooth does not work in the iOS Simulator.

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "IndoorWarior",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .iOSApplication(
            name: "IndoorWarior",
            targets: ["AppModule"],
            bundleIdentifier: "com.gbram895.IndoorWarior",
            displayVersion: "0.1",
            bundleVersion: "1",
            supportedDeviceFamilies: [
                .phone,
                .pad
            ],
            supportedInterfaceOrientations: [
                .portrait
            ],
            capabilities: [
                .bluetoothAlways(purposeString: "IndoorWarior connects to your smart trainer to show live power.")
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "Sources"
        )
    ]
)
