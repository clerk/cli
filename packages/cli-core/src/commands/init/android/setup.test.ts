import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubFetch, useCaptureLog } from "../../../test/lib/stubs.ts";
import * as prompts from "../../../lib/prompts.ts";
import { inspectAndroidProject } from "./project.ts";
import { setupAndroid } from "./setup.ts";

let root: string;
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const key = "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk";
const fingerprint = Array(32).fill("AB").join(":");
const logs = useCaptureLog();
let apps: {
  object: string;
  id: string;
  namespace: string;
  package_name: string;
  fingerprints: string[];
}[];
let enabled: boolean;
let requests: { method: string; path: string; body: unknown; headers: Headers }[];
let failPost: boolean;
let lostPost: boolean;
let malformed: boolean;
let permissionDenied: boolean;
let prodOnly: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clerk-android-setup-"));
  process.env.CLERK_PLATFORM_API_KEY = "ak_test";
  process.env.CLERK_TELEMETRY_DISABLED = "1";
  apps = [];
  enabled = false;
  requests = [];
  failPost = false;
  lostPost = false;
  malformed = false;
  permissionDenied = false;
  prodOnly = false;
  await Bun.write(
    join(root, "app/build.gradle.kts"),
    'plugins { id("org.jetbrains.kotlin.android") version "2.4.20" }\nandroid {\n namespace = "com.example.app"\n defaultConfig {\n applicationId = "com.example.app"\n minSdk = 24\n }\n}\n',
  );
  await Bun.write(
    join(root, "app/src/main/AndroidManifest.xml"),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>',
  );
  stubFetch(async (input, init) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({
      method,
      path: url.pathname + url.search,
      body,
      headers: new Headers(init?.headers),
    });
    if (permissionDenied)
      return Response.json({ errors: [{ message: "Forbidden" }] }, { status: 403 });
    if (url.pathname === "/v1/platform/applications/app_test") {
      return Response.json({
        application_id: "app_test",
        instances: [
          {
            instance_id: "ins_dev",
            environment_type: prodOnly ? "production" : "development",
            publishable_key: key,
          },
        ],
      });
    }
    if (url.pathname.endsWith("/native_settings")) {
      if (method === "PATCH") enabled = true;
      return Response.json(malformed ? {} : { object: "native_settings", api_enabled: enabled });
    }
    if (url.pathname.endsWith("/native_applications/android")) {
      if (method === "GET") return Response.json(apps);
      if (failPost) return Response.json({ errors: [{ message: "Unavailable" }] }, { status: 500 });
      const app = { object: "android_application", id: "android_1", ...body };
      apps.push(app);
      if (lostPost) throw new TypeError("Connection lost after commit");
      return Response.json(app, { status: 201 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  await rm(root, { recursive: true, force: true });
});

const inspect = async () => inspectAndroidProject(root, { androidFingerprint: [fingerprint] });
const options = { app: "app_test", skipConfirm: true };
const resource = async () => Bun.file(join(root, "app/src/main/res/values/clerk.xml")).exists();

test("enables native API, registers the installed package and writes only the public key", async () => {
  await setupAndroid(await inspect(), options);
  expect(enabled).toBe(true);
  expect(apps).toHaveLength(1);
  expect(apps[0]?.fingerprints).toEqual([fingerprint]);
  expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ api_enabled: true });
  const post = requests.find((r) => r.method === "POST")!;
  expect(post.body).toEqual({
    namespace: "android_app",
    package_name: "com.example.app",
    fingerprints: [fingerprint],
  });
  expect(post.headers.get("idempotency-key")).toMatch(/^android-init-[a-f0-9]{64}$/);
  expect(post.headers.get("authorization")).toBe("Bearer ak_test");
  expect(requests[0]?.path).toContain("include_secret_keys=false");
  expect(await resource()).toBe(true);
  expect(logs.out + logs.err).not.toContain(key);
  expect(await Bun.file(join(root, ".env")).exists()).toBe(false);
});

test("rerunning reuses the registration and makes no API mutations", async () => {
  await setupAndroid(await inspect(), options);
  requests = [];
  await setupAndroid(await inspect(), options);
  expect(requests.every((r) => r.method === "GET")).toBe(true);
  expect(apps).toHaveLength(1);
  expect(logs.out + logs.err).toContain("already set up");
});

test("missing fingerprints on an existing registration block before enabling or local writes", async () => {
  apps = [
    {
      object: "android_application",
      id: "android_1",
      namespace: "android_app",
      package_name: "com.example.app",
      fingerprints: [],
    },
  ];
  await expect(setupAndroid(await inspect(), options)).rejects.toThrow(
    "missing requested signing fingerprints",
  );
  expect(enabled).toBe(false);
  expect(await resource()).toBe(false);
  expect(requests.every((r) => r.method === "GET")).toBe(true);
});

test("existing registration can have additional signing certificates", async () => {
  apps = [
    {
      object: "android_application",
      id: "android_1",
      namespace: "android_app",
      package_name: "com.example.app",
      fingerprints: [fingerprint, "CD".repeat(32)],
    },
  ];
  await setupAndroid(await inspect(), options);
  expect(requests.some((r) => r.method === "POST")).toBe(false);
});

test("failed registration preserves project files and retries with the same idempotency key", async () => {
  failPost = true;
  await expect(setupAndroid(await inspect(), options)).rejects.toThrow();
  expect(await resource()).toBe(false);
  const firstKey = requests.find((r) => r.method === "POST")!.headers.get("idempotency-key");
  requests = [];
  failPost = false;
  await setupAndroid(await inspect(), options);
  expect(requests.find((r) => r.method === "POST")!.headers.get("idempotency-key")).toBe(firstKey);
});

test("recovers a committed registration after a lost response", async () => {
  lostPost = true;
  await setupAndroid(await inspect(), options);
  expect(apps).toHaveLength(1);
  expect(await resource()).toBe(true);
});

test("rejects malformed native settings without mutations", async () => {
  malformed = true;
  await expect(setupAndroid(await inspect(), options)).rejects.toThrow(
    "Unexpected Native API settings",
  );
  expect(requests.every((r) => r.method === "GET")).toBe(true);
  expect(await resource()).toBe(false);
});

test("does not fall back to production", async () => {
  prodOnly = true;
  await expect(setupAndroid(await inspect(), options)).rejects.toThrow("development instance");
  expect(requests).toHaveLength(1);
  expect(await resource()).toBe(false);
});

test("permission failure leaves the project unchanged", async () => {
  permissionDenied = true;
  await expect(setupAndroid(await inspect(), options)).rejects.toThrow();
  expect(await resource()).toBe(false);
});

test("cancelled confirmation makes no remote or local mutations", async () => {
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
  try {
    await expect(
      setupAndroid(await inspect(), { ...options, skipConfirm: false }),
    ).rejects.toThrow();
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(await resource()).toBe(false);
  } finally {
    confirm.mockRestore();
  }
});

test("a stale local plan blocks remote writes", async () => {
  const project = await inspect();
  await Bun.write(join(root, "app/build.gradle.kts"), "// changed by user");
  await expect(setupAndroid(project, options)).rejects.toThrow("changed after inspection");
  expect(requests.every((r) => r.method === "GET")).toBe(true);
});
