import ClerkKit
import SwiftUI

@main
struct ClerkCorpusIOSApp: App {
    init() {
        AuthenticationService.start()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(Clerk.shared)
        }
    }
}
