import SwiftUI

@main
struct IndoorWariorApp: App {
    @StateObject private var trainer = TrainerConnection()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(trainer)
        }
    }
}
