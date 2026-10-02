import SwiftUI

struct ContentView: View {
    var body: some View {
        NavigationStack {
            List {
                Section("Workspace") {
                    NavigationLink("Projects") {
                        Text("Your projects")
                            .navigationTitle("Projects")
                    }
                    NavigationLink("Account settings") {
                        Text("Manage your account")
                            .navigationTitle("Account settings")
                    }
                }
            }
            .navigationTitle("Workspace")
        }
    }
}
