import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AndroidApplication, InstanceConfigSchema } from "../../../lib/plapi.ts";
import { PlapiError } from "../../../lib/errors.ts";
import type { NativeAPI } from "./remote.ts";
import type { GoogleAPI } from "./native-google.ts";
import type { DebugKeystore } from "./identity.ts";

export const FIXTURE_KEY = `pk_test_${btoa("fixture.clerk.accounts.dev$")}`;
export const DEBUG_FINGERPRINT = Array(32).fill("AB").join(":");
export const RELEASE_FINGERPRINT = Array(32).fill("CD").join(":");
export const DEBUG_SHA1 = Array(20).fill("1A").join(":");

export interface AndroidFixtureOptions {
  /** Build script dialect. */
  groovy?: boolean;
  /** Write gradle/libs.versions.toml and use its aliases in the module. */
  catalog?: boolean;
  /** The Kotlin version to declare, or none. */
  kotlin?: string | false;
  /** The AGP version to declare. */
  agp?: string;
  minSdk?: number | "catalog";
  applicationId?: string | false;
  debugSuffix?: string;
  /** A Clerk SDK dependency to declare (literal or catalog). */
  clerk?: { product: "core" | "ui"; version: string } | false;
  /** An Application subclass registered in the manifest. */
  application?: "custom" | "custom-initialized" | "unsupported" | "java";
  internetPermission?: boolean;
  /** A `clerk.xml` written by an earlier run, with this key. */
  keyResource?: string;
  /** Put the module at the root instead of `app/`. */
  rootModule?: boolean;
}

export async function createAndroidFixture(
  options: AndroidFixtureOptions = {},
  root?: string,
): Promise<string> {
  root ??= await realpath(await mkdtemp(join(tmpdir(), "clerk-android-")));
  const module = options.rootModule ? "." : "app";
  const kts = !options.groovy;
  const q = (value: string) => (kts ? `"${value}"` : `'${value}'`);
  const eq = kts ? " = " : " ";
  const catalog = options.catalog ?? false;
  const kotlin = options.kotlin === undefined ? "2.3.21" : options.kotlin;
  const agp = options.agp ?? "9.2.1";
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root!, path)), { recursive: true });
    await writeFile(join(root!, path), content);
  };
  const at = (path: string) => (module === "." ? path : join(module, path));
  const clerkCoordinate = options.clerk
    ? `com.clerk:clerk-android-${options.clerk.product === "ui" ? "ui" : "api"}:${options.clerk.version}`
    : "";
  if (catalog) {
    await write(
      "gradle/libs.versions.toml",
      [
        "[versions]",
        `agp = "${agp}"`,
        ...(kotlin ? [`kotlin = "${kotlin}"`] : []),
        'coreKtx = "1.18.0"',
        ...(options.minSdk === "catalog" ? ['minSdk = "23"'] : []),
        ...(options.clerk ? [`clerk = "${options.clerk.version}"`] : []),
        "",
        "[libraries]",
        'androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }',
        ...(options.clerk
          ? [
              `clerk-android-${options.clerk.product === "ui" ? "ui" : "api"} = { module = "com.clerk:clerk-android-${options.clerk.product === "ui" ? "ui" : "api"}", version.ref = "clerk" }`,
            ]
          : []),
        "",
        "[plugins]",
        'android-application = { id = "com.android.application", version.ref = "agp" }',
        ...(kotlin
          ? [
              'kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }',
            ]
          : []),
        "",
      ].join("\n"),
    );
  }
  const plugins = catalog
    ? [
        "alias(libs.plugins.android.application)",
        ...(kotlin ? ["alias(libs.plugins.kotlin.compose)"] : []),
      ]
    : [
        `id(${q("com.android.application")})${module === "." ? ` version ${q(agp)}` : ""}`,
        ...(kotlin ? [`id(${q("org.jetbrains.kotlin.android")}) version ${q(kotlin)}`] : []),
      ];
  const minSdk =
    options.minSdk === "catalog"
      ? "libs.versions.minSdk.get().toInt()"
      : String(options.minSdk ?? 24);
  const applicationId =
    options.applicationId === false
      ? 'providers.gradleProperty("appId").get()'
      : q(options.applicationId ?? "com.example.myapp");
  const dependencies = [
    catalog
      ? "implementation(libs.androidx.core.ktx)"
      : `implementation(${q("androidx.core:core-ktx:1.18.0")})`,
    ...(options.clerk
      ? [
          catalog
            ? `implementation(libs.clerk.android.${options.clerk.product === "ui" ? "ui" : "api"})`
            : `implementation(${q(clerkCoordinate)})`,
        ]
      : []),
  ];
  await write(
    at(kts ? "build.gradle.kts" : "build.gradle"),
    [
      "plugins {",
      ...plugins.map((line) => `    ${line}`),
      "}",
      "",
      "android {",
      `    namespace${eq}${q("com.example.myapp")}`,
      `    compileSdk${eq}36`,
      "    defaultConfig {",
      `        applicationId${eq}${applicationId}`,
      `        minSdk${eq}${minSdk}`,
      `        targetSdk${eq}36`,
      "    }",
      ...(options.debugSuffix
        ? [
            "    buildTypes {",
            "        debug {",
            `            applicationIdSuffix${eq}${q(options.debugSuffix)}`,
            "        }",
            "    }",
          ]
        : []),
      "}",
      "",
      "dependencies {",
      ...dependencies.map((line) => `    ${line}`),
      "}",
      "",
    ].join("\n"),
  );
  if (module !== ".")
    await write(
      "build.gradle.kts",
      catalog
        ? "plugins {\n    alias(libs.plugins.android.application) apply false\n}\n"
        : `plugins {\n    id("com.android.application") version "${agp}" apply false\n}\n`,
    );
  const applicationName =
    options.application === "java" ? ".JavaApp" : options.application ? ".CustomApp" : undefined;
  await write(
    at("src/main/AndroidManifest.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n${options.internetPermission ? '    <uses-permission android:name="android.permission.INTERNET" />\n' : ""}    <!-- android:name=".Commented" -->\n    <application${applicationName ? `\n        android:name="${applicationName}"` : ""}\n        android:label="My App">\n        <activity android:name=".MainActivity" android:exported="true" />\n    </application>\n</manifest>\n`,
  );
  if (options.application === "custom")
    await write(
      at("src/main/java/com/example/myapp/CustomApp.kt"),
      "package com.example.myapp\n\nimport android.app.Application\n\nclass CustomApp : Application() {\n    override fun onCreate() {\n        super.onCreate() // keep\n        startExistingService()\n    }\n\n    private fun startExistingService() {}\n}\n",
    );
  if (options.application === "custom-initialized")
    await write(
      at("src/main/java/com/example/myapp/CustomApp.kt"),
      `package com.example.myapp\n\nimport android.app.Application\nimport com.clerk.api.Clerk\n\nclass CustomApp : Application() {\n    override fun onCreate() {\n        super.onCreate()\n        Clerk.initialize(this, publishableKey = "${FIXTURE_KEY}")\n    }\n}\n`,
    );
  if (options.application === "unsupported")
    await write(
      at("src/main/java/com/example/myapp/CustomApp.kt"),
      "package com.example.myapp\n\nimport android.app.Application\n\nclass CustomApp : Application() {\n    override fun onCreate() {\n        if (BuildConfig.DEBUG) super.onCreate() else super.onCreate()\n    }\n}\n",
    );
  if (options.application === "java")
    await write(
      at("src/main/java/com/example/myapp/JavaApp.java"),
      "package com.example.myapp;\n\npublic class JavaApp extends android.app.Application {}\n",
    );
  if (options.keyResource)
    await write(
      at("src/main/res/values/clerk.xml"),
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <!-- Generated by Clerk CLI -->\n    <string name="clerk_publishable_key" translatable="false">${options.keyResource}</string>\n</resources>\n`,
    );
  return root;
}

/** An in-memory Platform API for the native Android endpoints. */
export function fakeNativeAPI() {
  const state = {
    enabled: false,
    registrations: [] as AndroidApplication[],
    events: [] as string[],
    keys: [] as string[],
    createError: undefined as unknown,
    lostCreate: false,
    listFails: false,
    failEnable: false,
    production: false,
    wrongApp: false,
    changedKey: false,
  };
  const api: NativeAPI = {
    async fetchApplication(id, options) {
      if (options?.includeSecretKeys !== false)
        throw new Error("Secret keys must not be requested");
      return {
        application_id: state.wrongApp ? "app_wrong" : id,
        instances: [
          {
            instance_id: "ins_test",
            environment_type: state.production ? "production" : "development",
            publishable_key: state.changedKey
              ? `pk_test_${btoa("changed.clerk.accounts.dev$")}`
              : FIXTURE_KEY,
          },
        ],
      } as never;
    },
    async getNativeSettings() {
      return { object: "native_settings", api_enabled: state.enabled };
    },
    async listAndroidApplications() {
      if (state.listFails) throw new Error("Registrations unavailable");
      return [...state.registrations];
    },
    async createAndroidApplication(_app, _instance, params, idempotencyKey) {
      state.events.push("register");
      state.keys.push(idempotencyKey);
      if (state.createError) throw state.createError;
      const created: AndroidApplication = {
        object: "android_application",
        id: `androidapp_${state.registrations.length + 1}`,
        ...params,
      };
      state.registrations.push(created);
      if (state.lostCreate) throw new TypeError("fetch failed");
      return created;
    },
    async enableNativeApi() {
      state.events.push("enable-native");
      if (state.failEnable) throw new PlapiError(500, "{}", "native_settings");
      state.enabled = true;
      return { object: "native_settings", api_enabled: true };
    },
  };
  return { api, state };
}

export function keystore(status: DebugKeystore["status"] = "found"): () => Promise<DebugKeystore> {
  return async () => ({
    status,
    keystore: "/Users/test/.android/debug.keystore",
    keytool: status === "no-keytool" ? undefined : "/usr/bin/keytool",
    fingerprint: status === "found" ? DEBUG_FINGERPRINT : undefined,
    sha1: status === "found" ? DEBUG_SHA1 : undefined,
  });
}

export const FAKE_GOOGLE_CLIENT_ID = "123456789012-fakefakefakefake.apps.googleusercontent.com";
export const FAKE_GOOGLE_CLIENT_SECRET = "GOCSPX-FAKE_SECRET_MUST_NOT_ESCAPE";

/** An in-memory Platform API config endpoint for the Google connection. */
export function fakeGoogleAPI(initial: Record<string, unknown> = { enabled: false }) {
  const state = {
    connection: { ...initial } as Record<string, unknown>,
    configVersion: "v1_1234abcd",
    events: [] as string[],
    patches: [] as Record<string, unknown>[],
    schemaMissing: false,
    noVersion: false,
    failPatch: false,
  };
  const api: GoogleAPI = {
    async fetchInstanceConfig(_app, _instance, keys) {
      if (!keys?.includes("connection_oauth_google")) throw new Error("Unexpected keys");
      return {
        ...(state.noVersion ? {} : { config_version: state.configVersion }),
        connection_oauth_google: { ...state.connection },
      };
    },
    async fetchInstanceConfigSchema(): Promise<InstanceConfigSchema> {
      return state.schemaMissing
        ? { properties: {} }
        : {
            properties: {
              connection_oauth_google: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                  authenticatable: { type: "boolean" },
                  client_id: { type: "string" },
                  client_secret: { type: "string", "x-clerk-sensitive": true },
                },
              },
            },
          };
    },
    async patchInstanceConfig(_app, _instance, config, options) {
      state.events.push(options.dryRun ? "google-dry-run" : "google-apply");
      if (options.ifMatch !== state.configVersion) throw new Error("If-Match mismatch");
      if (state.failPatch) throw new Error("Patch refused");
      const patch = config.connection_oauth_google as Record<string, unknown>;
      const before = { ...state.connection };
      const after = { ...before, ...patch };
      if (!options.dryRun) {
        state.connection = after;
        state.configVersion = "v1_9876fedc";
        state.patches.push(patch);
      }
      return {
        dry_run: options.dryRun,
        before: { connection_oauth_google: before },
        after: { connection_oauth_google: after },
      };
    },
  };
  return { api, state };
}
