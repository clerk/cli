import ClerkKit
import Foundation

enum AuthenticationService {
    static func start() {
        Clerk.configure(publishableKey: AppConfiguration.publishableKey)
    }
}

enum AppConfiguration {
    static var publishableKey: String {
        guard let key = Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as? String else {
            fatalError("Provide ClerkPublishableKey through the app's build configuration.")
        }
        return key
    }
}
