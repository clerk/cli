import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectSwiftSources,
  sanitizeSwiftSource,
  sanitizeSwiftSourceWithStatus,
} from "./swift.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("sanitizeSwiftSource", () => {
  test("removes nested comments and standard, multiline, and raw strings", () => {
    const source = `
      // Clerk.configure(publishableKey: "fake")
      /* outer /* @main */ AuthView() */
      let standard = "Clerk.configure()"
      let multiline = """.environment(Clerk.shared)"""
      let raw = ##"AuthView()"##
      @main struct RealApp: App {}
    `;

    const sanitized = sanitizeSwiftSource(source);
    expect(sanitized).not.toContain("Clerk.configure");
    expect(sanitized).not.toContain("AuthView");
    expect(sanitized).not.toContain(".environment");
    expect(sanitized).toContain("@main struct RealApp");
  });

  test("removes bare, extended, multi-hash, and multiline regex literals", () => {
    const source = [
      "let bare = /Clerk.shared.auth.signInWithApple()/",
      "let extended = #/AuthView()/#",
      "let internalSlash = #/path/to/Clerk.shared.auth.startHostedAuth()/#",
      "let escapedDelimiter = #/prefix\\/#Clerk.shared.auth.signUp()/#",
      "let multiHash = ###/Clerk.shared.handle(url)/###",
      "let multiline = ##/",
      "  Clerk.shared.auth.signInWithPassword()",
      "/##",
      "let compactDivision = numerator/denominator/divisor",
      "let spacedDivision = numerator / denominator / divisor",
    ].join("\n");

    const result = sanitizeSwiftSourceWithStatus(source);

    expect(result.complete).toBe(true);
    expect(result.sanitizedSource).not.toContain("Clerk.shared");
    expect(result.sanitizedSource).not.toContain("AuthView");
    expect(result.sanitizedSource).toContain("let compactDivision = numerator/denominator/divisor");
    expect(result.sanitizedSource).toContain(
      "let spacedDivision = numerator / denominator / divisor",
    );
    expect(result.sanitizedSource.length).toBe(source.length);
    expect([...result.sanitizedSource.matchAll(/\n/g)].map((match) => match.index)).toEqual(
      [...source.matchAll(/\n/g)].map((match) => match.index),
    );
  });

  test("reports malformed and interpolation-like regex literals as incomplete", () => {
    const malformed = sanitizeSwiftSourceWithStatus(
      "let matcher = /Clerk.shared.auth.signInWithApple()\n@main struct RealApp: App {}",
    );
    expect(malformed.complete).toBe(false);
    expect(malformed.sanitizedSource).not.toContain("Clerk.shared");
    expect(malformed.sanitizedSource).toContain("@main struct RealApp");

    const interpolated = sanitizeSwiftSourceWithStatus(
      "let matcher = #/prefix\\#(value)Clerk.shared.auth.signInWithApple()/#",
    );
    expect(interpolated.complete).toBe(false);
    expect(interpolated.sanitizedSource).not.toContain("Clerk.shared");
  });

  test("keeps ordinary string interpolation complete without hiding later Clerk calls", () => {
    const source = String.raw`let message = "Hello \(user.name): \(format(value))"
Clerk.configure(publishableKey: key)`;

    const result = sanitizeSwiftSourceWithStatus(source);

    expect(result.complete).toBe(true);
    expect(result.sanitizedSource).not.toContain("user.name");
    expect(result.sanitizedSource).not.toContain("format");
    expect(result.sanitizedSource).toContain("Clerk.configure(publishableKey: key)");
  });

  test("keeps later Clerk calls visible after nested interpolation strings", () => {
    const source = String.raw`let message = "Hello \("name)" + user.name)"
Clerk.configure(publishableKey: key)
let escaped = "say \"hello\""`;

    const result = sanitizeSwiftSourceWithStatus(source);

    expect(result.complete).toBe(true);
    expect(result.sanitizedSource).toContain("Clerk.configure");
  });

  test("marks interpolation that contains executable Clerk evidence incomplete", () => {
    const configure = sanitizeSwiftSourceWithStatus(
      String.raw`let message = "configured: \(Clerk.configure(publishableKey: "pk_test_hidden"))"`,
    );
    const auth = sanitizeSwiftSourceWithStatus(
      String.raw`let message = #"signed in: \#(try await Clerk.shared.auth.signInWithApple())"#`,
    );

    expect(configure.complete).toBe(false);
    expect(configure.sanitizedSource).not.toContain("Clerk.configure");
    expect(auth.complete).toBe(false);
    expect(auth.sanitizedSource).not.toContain("Clerk.shared");
  });
});

describe("inspectSwiftSources", () => {
  test("fails Clerk evidence closed when a configure call is hidden in interpolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "App.swift");
    await Bun.write(
      path,
      String.raw`import ClerkKit
       @main struct AppMain: App {
         let diagnostic = "\(Clerk.configure(publishableKey: "pk_test_hidden"))"
         var body: some Scene { WindowGroup { ContentView() } }
       }`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "App.swift" },
    ]);

    expect(inspection.evidenceComplete).toBe(false);
    expect(inspection.entryPoints).toEqual([{ path: "App.swift" }]);
    expect(inspection.configureCalls).toEqual([]);
  });

  test("keeps ordinary interpolation complete while detecting a real configure call", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "App.swift");
    await Bun.write(
      path,
      String.raw`import ClerkKit
       @main struct AppMain: App {
         init() {
           let diagnostic = "Hello \(user.name): \(format(value))"
           Clerk.configure(publishableKey: key)
         }
       }`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "App.swift" },
    ]);

    expect(inspection.evidenceComplete).toBe(true);
    expect(inspection.configureCalls).toEqual([
      {
        path: "App.swift",
        publishableKeyWiring: "custom",
        startupBinding: "app-init",
      },
    ]);
  });

  test("ignores authentication symbols inside Swift regex literals", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "Patterns.swift");
    await Bun.write(
      path,
      `import ClerkKit
       import ClerkKitUI
       let native = #/Clerk.shared.auth.signInWithApple()/#
       let prebuilt = /AuthView()/`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "Patterns.swift" },
    ]);

    expect(inspection.evidenceComplete).toBe(true);
    expect(inspection.authFlowReferences).toEqual([]);
  });

  test("still records a real authentication call adjacent to a regex literal", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "Authentication.swift");
    await Bun.write(
      path,
      `import ClerkKit
       let matcher = #/Clerk.shared.auth.signInWithApple()/#
       func authenticate() async throws {
         try await Clerk.shared.auth.signInWithApple()
       }`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "Authentication.swift" },
    ]);

    expect(inspection.evidenceComplete).toBe(true);
    expect(inspection.authFlowReferences).toEqual([{ path: "Authentication.swift" }]);
  });

  test("marks source evidence incomplete for an unclosed regex literal", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "Patterns.swift");
    await Bun.write(
      path,
      `import ClerkKit
       let matcher = /Clerk.shared.auth.signInWithApple()
       struct ContentView {}`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "Patterns.swift" },
    ]);

    expect(inspection.evidenceComplete).toBe(false);
    expect(inspection.authFlowReferences).toEqual([]);
  });

  test("records real Clerk evidence without retaining key expressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "App.swift");
    await Bun.write(
      path,
      `import ClerkKit
       import ClerkKitUI
       @main struct AppMain: App {
         init() { Clerk.configure(publishableKey: "pk_test_must-not-leak") }
         var body: some Scene {
           WindowGroup {
             AuthView()
               .environment(Clerk.shared)
               .onOpenURL { url in
                 Task { try await Clerk.shared.handle(url) }
               }
           }
         }
       }`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "App.swift" },
    ]);

    expect(inspection.status).toBe("complete");
    expect(inspection.configureCalls).toEqual([
      {
        path: "App.swift",
        publishableKeyWiring: "inline-literal",
        inlinePublishableKey: { state: "invalid" },
        startupBinding: "app-init",
      },
    ]);
    expect(inspection.environmentInjections).toEqual([{ path: "App.swift" }]);
    expect(inspection.authFlowReferences).toEqual([{ path: "App.swift" }]);
    expect(inspection.openURLHandlers).toEqual([{ path: "App.swift" }]);
    expect(JSON.stringify(inspection)).not.toContain("must-not-leak");
  });

  test("retains only decoded metadata for a valid inline publishable key", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "App.swift");
    const publishableKey = `pk_test_${Buffer.from("inline.clerk.example$").toString("base64")}`;
    await Bun.write(
      path,
      `import ClerkKit
       @main struct AppMain: App {
         init() { Clerk.configure(publishableKey: "${publishableKey}") }
       }`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "App.swift" },
    ]);

    expect(inspection.configureCalls).toEqual([
      {
        path: "App.swift",
        publishableKeyWiring: "inline-literal",
        inlinePublishableKey: {
          state: "valid",
          frontendApiHost: "inline.clerk.example",
          instanceType: "development",
        },
        startupBinding: "app-init",
      },
    ]);
    expect(JSON.stringify(inspection)).not.toContain(publishableKey);
  });

  test("recognizes selective ClerkKit and ClerkKitUI imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const corePath = join(root, "Core.swift");
    const uiPath = join(root, "UI.swift");
    await Bun.write(corePath, "import class ClerkKit.Clerk\n");
    await Bun.write(uiPath, "import struct ClerkKitUI.AuthView\n");

    const inspection = await inspectSwiftSources([
      { absolutePath: corePath, relativePath: "Core.swift" },
      { absolutePath: uiPath, relativePath: "UI.swift" },
    ]);

    expect(inspection.importsClerkKit).toEqual([{ path: "Core.swift" }]);
    expect(inspection.importsClerkKitUI).toEqual([{ path: "UI.swift" }]);
    expect(inspection.status).toBe("partial");
  });

  test("classifies runtime key wiring without retaining expressions or values", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "Configuration.swift");
    await Bun.write(
      path,
      `import ClerkKit
       func configureFromLoad() {
         Clerk.configure(publishableKey: QuickstartLocalSecrets.load().publishableKey ?? "pk_test_loader-secret")
       }
       func configureFromProperty() {
         Clerk.configure(publishableKey: LocalSecrets.key)
       }
       func configureFromEnvironment() {
         Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["CLERK_PUBLISHABLE_KEY"] ?? "pk_test_environment-secret")
       }
       func configureFromUnrelatedEnvironment() {
         Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["ANALYTICS_KEY"] ?? "not-a-clerk-key")
       }
       func configureFromUnknownSource() {
         Clerk.configure(publishableKey: ApplicationSecrets.clerkKey)
       }
       func configureAfterUnicode() {
         let note = "🔐"
         Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["CLERK_PUBLISHABLE_KEY"])
       }
       func configureWithUnrelatedLaterArgument() {
         Clerk.configure(publishableKey: ApplicationSecrets.clerkKey, cache: LocalSecrets.key)
       }`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "Configuration.swift" },
    ]);

    expect(inspection.configureCalls).toEqual([
      {
        path: "Configuration.swift",
        publishableKeyWiring: "custom",
        startupBinding: "unproven",
      },
      {
        path: "Configuration.swift",
        publishableKeyWiring: "custom",
        startupBinding: "unproven",
      },
      {
        path: "Configuration.swift",
        publishableKeyWiring: "custom",
        startupBinding: "unproven",
      },
      {
        path: "Configuration.swift",
        publishableKeyWiring: "custom",
        startupBinding: "unproven",
      },
      {
        path: "Configuration.swift",
        publishableKeyWiring: "custom",
        startupBinding: "unproven",
      },
      {
        path: "Configuration.swift",
        publishableKeyWiring: "custom",
        startupBinding: "unproven",
      },
      {
        path: "Configuration.swift",
        publishableKeyWiring: "custom",
        startupBinding: "unproven",
      },
    ]);
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain("QuickstartLocalSecrets");
    expect(serialized).not.toContain("ProcessInfo");
    expect(serialized).not.toContain("loader-secret");
    expect(serialized).not.toContain("environment-secret");
    expect(serialized).not.toContain("ANALYTICS_KEY");
  });

  test("proves only a direct call in the @main type's init as startup-bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "App.swift");
    await Bun.write(
      path,
      `import ClerkKit
       @main struct AppMain: App {
         init() {
           Clerk.configure(publishableKey: ApplicationSecrets.direct)
           let deferredConfiguration = {
             Clerk.configure(publishableKey: ApplicationSecrets.nestedClosure)
           }
           #if DEBUG
           Clerk.configure(publishableKey: ApplicationSecrets.conditional)
           #endif
           _ = deferredConfiguration
         }

         func unusedHelper() {
           Clerk.configure(publishableKey: ApplicationSecrets.helper)
         }
       }`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "App.swift" },
    ]);

    expect(inspection.configureCalls.map((call) => call.startupBinding)).toEqual([
      "app-init",
      "unproven",
      "unproven",
      "unproven",
    ]);
  });

  test("only records an open URL handler when its closure forwards to Clerk", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const unrelatedPath = join(root, "Unrelated.swift");
    const clerkPath = join(root, "ClerkCallback.swift");
    await Bun.write(
      unrelatedPath,
      `import ClerkKit
       struct Unrelated: View {
         var body: some View {
           Text("Hello")
             .onOpenURL { url in Analytics.shared.track(url) }
         }
         func handleElsewhere(_ url: URL) async throws {
           try await Clerk.shared.handle(url)
         }
       }`,
    );
    await Bun.write(
      clerkPath,
      `import ClerkKit
       struct Callback: View {
         @Environment(Clerk.self) private var clerk
         var body: some View {
           Text("Hello")
             .onOpenURL { url in
               Task { try await clerk.handle(url) }
             }
         }
       }`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: unrelatedPath, relativePath: "Unrelated.swift" },
      { absolutePath: clerkPath, relativePath: "ClerkCallback.swift" },
    ]);

    expect(inspection.openURLHandlers).toEqual([{ path: "ClerkCallback.swift" }]);
  });

  test("recognizes native Clerk auth calls without matching unrelated sign-in APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const emailCodePath = join(root, "EmailCode.swift");
    const passwordPath = join(root, "Password.swift");
    const signUpPath = join(root, "SignUp.swift");
    const hostedAuthPath = join(root, "HostedAuth.swift");
    const unrelatedPath = join(root, "UnrelatedFlow.swift");
    await Bun.write(
      emailCodePath,
      `import ClerkKit
       struct EmailCodeFlow {
         @Environment(Clerk.self) private var clerk
         func run() async throws {
           try await clerk.auth.signInWithEmailCode(emailAddress: "person@example.com")
         }
       }`,
    );
    await Bun.write(
      passwordPath,
      `import ClerkKit
       struct PasswordFlow {
         func run() async throws {
           try await Clerk.shared.auth.signInWithPassword(identifier: "person@example.com", password: "secret")
         }
       }`,
    );
    await Bun.write(
      signUpPath,
      `import ClerkKit
       struct SignUpFlow {
         @Environment(Clerk.self) private var clerk
         func run() async throws {
           _ = try await clerk.auth.signUp(emailAddress: "person@example.com")
         }
       }`,
    );
    await Bun.write(
      hostedAuthPath,
      `import ClerkKit
       struct HostedAuthFlow {
         @Environment(Clerk.self) private var clerk
         func run() async throws {
           _ = try await clerk.auth.startHostedAuth()
         }
       }`,
    );
    await Bun.write(
      unrelatedPath,
      `struct UnrelatedFlow {
         func run() {
           _ = AuthView()
           clerk.auth.signUp()
           analytics.auth.signInWithPassword()
           signIn.create()
           signUp.prepare()
         }
       }`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: emailCodePath, relativePath: "EmailCode.swift" },
      { absolutePath: passwordPath, relativePath: "Password.swift" },
      { absolutePath: signUpPath, relativePath: "SignUp.swift" },
      { absolutePath: hostedAuthPath, relativePath: "HostedAuth.swift" },
      { absolutePath: unrelatedPath, relativePath: "UnrelatedFlow.swift" },
    ]);

    expect(inspection.authFlowReferences).toEqual([
      { path: "EmailCode.swift" },
      { path: "HostedAuth.swift" },
      { path: "Password.swift" },
      { path: "SignUp.swift" },
    ]);
  });

  test("marks multiple entry points as ambiguous", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const paths = [join(root, "One.swift"), join(root, "Two.swift")];
    await Promise.all(paths.map((path) => Bun.write(path, "@main struct Entry: App {}")));

    const inspection = await inspectSwiftSources(
      paths.map((absolutePath) => ({
        absolutePath,
        relativePath: absolutePath.endsWith("One.swift") ? "One.swift" : "Two.swift",
      })),
    );

    expect(inspection.status).toBe("ambiguous");
    expect(inspection.entryPoints).toHaveLength(2);
  });

  test("marks source evidence incomplete when a target member is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);

    const inspection = await inspectSwiftSources([
      { absolutePath: join(root, "Missing.swift"), relativePath: "Missing.swift" },
    ]);

    expect(inspection.evidenceComplete).toBe(false);
    expect(inspection.sourceFilesScanned).toBe(0);
  });

  test("marks source evidence incomplete when a target member exceeds the scan limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "Oversized.swift");
    await Bun.write(path, "x".repeat(1_000_001));

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "Oversized.swift" },
    ]);

    expect(inspection.evidenceComplete).toBe(false);
    expect(inspection.sourceFilesScanned).toBe(0);
  });

  test("does not treat preview-only Clerk UI as a shipping authentication flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-swift-"));
    temporaryDirectories.push(root);
    const path = join(root, "ContentView.swift");
    await Bun.write(
      path,
      `import ClerkKitUI
       import SwiftUI
       struct ContentView: View { var body: some View { Text("Hello") } }
       #Preview { AuthView() }
       struct LegacyPreview: PreviewProvider {
         static var previews: some View { SignInView() }
       }`,
    );

    const inspection = await inspectSwiftSources([
      { absolutePath: path, relativePath: "ContentView.swift" },
    ]);

    expect(inspection.authFlowReferences).toEqual([]);
  });
});
