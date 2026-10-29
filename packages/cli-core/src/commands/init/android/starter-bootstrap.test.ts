import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ERROR_CODE } from "../../../lib/errors.ts";
import * as prompts from "../../../lib/prompts.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { StarterInputRequired } from "../native/starter-input.ts";
import {
  defaultApplicationId,
  promptAndroidStarter,
  type AndroidStarterOptions,
} from "./starter-bootstrap.ts";

useCaptureLog();
let tmp: string;
const spies: { mockRestore(): void }[] = [];
const run = (options: Partial<AndroidStarterOptions>) =>
  promptAndroidStarter(tmp, { skipConfirm: true, ...options });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "clerk-android-starter-"));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

describe("promptAndroidStarter", () => {
  test("writes the project with the flags' answers", async () => {
    const result = await run({ name: "MyApp", applicationId: "com.acme.myapp" });
    expect(result).toEqual({
      projectDir: join(tmp, "MyApp"),
      projectName: "MyApp",
      android: { applicationId: "com.acme.myapp" },
    });
    expect(await Bun.file(join(tmp, "MyApp/app/build.gradle.kts")).text()).toContain(
      'applicationId = "com.acme.myapp"',
    );
  });

  test("defaults the name and Android Studio's applicationId when it isn't asked", async () => {
    const result = await run({});
    expect(result.projectName).toBe("MyClerkApp");
    expect(result.android.applicationId).toBe("com.example.myclerkapp");
    expect(defaultApplicationId("My_App")).toBe("com.example.my_app");
  });

  test("skips a default name that's taken", async () => {
    mkdirSync(join(tmp, "MyClerkApp"));
    expect((await run({})).projectName).toBe("MyClerkApp2");
  });

  test("asks at a terminal, with the defaults offered", async () => {
    const text = spyOn(prompts, "text")
      .mockResolvedValueOnce("Demo")
      .mockResolvedValueOnce("org.example.demo");
    spies.push(text);
    const result = await run({ skipConfirm: false });
    expect(text.mock.calls.map((call) => call[0].default)).toEqual([
      "MyClerkApp",
      "com.example.demo",
    ]);
    expect(result).toMatchObject({
      projectName: "Demo",
      android: { applicationId: "org.example.demo" },
    });
  });

  test.each([
    [{ name: "2fast" }, "name", "start with a letter"],
    [{ name: "class" }, "name", "Kotlin keyword"],
    [{ name: "MyApp", applicationId: "myapp" }, "androidPackage", "reverse-DNS"],
    [{ name: "MyApp", applicationId: "com.example.object" }, "androidPackage", "Kotlin keyword"],
  ])("refuses %j before writing anything", async (options, field, message) => {
    const error = await run(options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StarterInputRequired);
    expect((error as StarterInputRequired).describe()).toMatchObject({
      field,
      issue: expect.stringContaining(message),
    });
    expect((error as StarterInputRequired).describe().flag).toBe(
      field === "name" ? "--name" : "--android-package",
    );
    expect(await Bun.file(join(tmp, "MyApp/settings.gradle.kts")).exists()).toBe(false);
  });

  test("with --json, a missing --name is asked for with a suggestion", async () => {
    const error = await run({ requireName: true }).catch((e: unknown) => e);
    expect((error as StarterInputRequired).describe()).toMatchObject({
      field: "name",
      suggestion: "MyClerkApp",
    });
  });

  test("refuses a name whose directory exists", async () => {
    mkdirSync(join(tmp, "Taken"));
    const error = await run({ name: "Taken" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StarterInputRequired);
    expect((error as StarterInputRequired).code).toBe(ERROR_CODE.PROJECT_DIR_EXISTS);
  });

  test("runs beforeWrite once the answers are settled, and writes nothing when it throws", async () => {
    const seen: string[] = [];
    await expect(
      run({
        name: "MyApp",
        beforeWrite: async (dir) => {
          seen.push(dir);
          throw new Error("linked elsewhere");
        },
      }),
    ).rejects.toThrow("linked elsewhere");
    expect(seen).toEqual([join(tmp, "MyApp")]);
    expect(await Bun.file(join(tmp, "MyApp/settings.gradle.kts")).exists()).toBe(false);
  });
});
