import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as listage from "../../../lib/listage.ts";
import { throwUserAbort } from "../../../lib/errors.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { applyIOSLocalSetup } from "./apply.ts";
import { inspectIOSProject } from "./inspect.ts";
import { pickAppleNativeTarget } from "./target-picker.ts";
import {
  createIOSFixture,
  createIOSJSONFixture,
  addNestedSharedEntryToIOSJSONFixture,
  convertIOSFixtureToMultiplatform,
  IOS_FIXTURE_IDS,
  treeDigest,
} from "./test-helpers.ts";

useCaptureLog();
const directories: string[] = [];
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
let picker: ReturnType<typeof spyOn<typeof listage, "select">>;

beforeEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  picker = spyOn(listage, "select").mockResolvedValue(IOS_FIXTURE_IDS.appTarget);
});

afterEach(async () => {
  picker.mockRestore();
  for (const [stream, descriptor] of [
    [process.stdin, stdinTTY],
    [process.stdout, stdoutTTY],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  secondTarget: boolean | "watchos" = true,
  platform: "ios" | "macos" = "ios",
) {
  const root = await mkdtemp(join(tmpdir(), "clerk-target-picker-"));
  directories.push(root);
  await createIOSFixture(root, { complete: true, secondTarget, platform });
  return root;
}

test("offers app names, platform, and project, selecting the chosen ID without writing", async () => {
  const root = await fixture();
  const before = await treeDigest(root);
  const target = await pickAppleNativeTarget({ root, interactive: true });

  expect(target).toBe(IOS_FIXTURE_IDS.appTarget);
  expect(picker.mock.calls[0]?.[0].choices).toEqual([
    expect.objectContaining({
      value: IOS_FIXTURE_IDS.secondTarget,
      name: "AdminApp — iOS — MyApp.xcodeproj",
      disabled: false,
    }),
    expect.objectContaining({
      value: IOS_FIXTURE_IDS.appTarget,
      name: "MyApp — iOS — MyApp.xcodeproj",
      disabled: false,
    }),
  ]);
  expect((await inspectIOSProject(root, { target })).selection).toMatchObject({
    state: "selected",
    targetId: IOS_FIXTURE_IDS.appTarget,
  });
  expect(await treeDigest(root)).toEqual(before);
});

test("selects JSON project targets through the same read-only picker", async () => {
  const root = await mkdtemp(join(tmpdir(), "clerk-json-target-picker-"));
  directories.push(root);
  await createIOSJSONFixture(root);
  const { secondaryTargetId } = await addNestedSharedEntryToIOSJSONFixture(root);
  const before = await treeDigest(root);
  picker.mockResolvedValue(secondaryTargetId);

  const target = await pickAppleNativeTarget({ root, interactive: true });

  expect(picker.mock.calls[0]?.[0].choices).toContainEqual(
    expect.objectContaining({
      name: "SharedTarget — iOS — MyApp.xcodeproj",
      value: secondaryTargetId,
    }),
  );
  expect((await inspectIOSProject(root, { target })).selection).toMatchObject({
    state: "selected",
    targetId: secondaryTargetId,
  });
  expect(await treeDigest(root)).toEqual(before);
});

test.each(["macos", "shared"] as const)(
  "labels %s targets from their inspected platforms",
  async (platform) => {
    const root = await fixture(true, platform === "macos" ? "macos" : "ios");
    if (platform === "shared") await convertIOSFixtureToMultiplatform(root);

    await pickAppleNativeTarget({ root, interactive: true });

    expect(picker.mock.calls[0]?.[0].choices).toContainEqual(
      expect.objectContaining({
        value: IOS_FIXTURE_IDS.appTarget,
        name: `MyApp — ${platform === "macos" ? "macOS" : "iOS + macOS"} — MyApp.xcodeproj`,
      }),
    );
  },
);

test.each([false, "watchos"] as const)(
  "keeps automatic selection for one eligible app (%s)",
  async (secondTarget) => {
    const root = await fixture(secondTarget);
    expect(await pickAppleNativeTarget({ root, interactive: true })).toBeUndefined();
    expect(picker).not.toHaveBeenCalled();
    expect((await inspectIOSProject(root)).selection.state).toBe("selected");
  },
);

test.each([
  { target: "MyApp", interactive: true, stdin: true, stdout: true },
  { target: undefined, interactive: false, stdin: true, stdout: true },
  { target: undefined, interactive: true, stdin: false, stdout: true },
  { target: undefined, interactive: true, stdin: true, stdout: false },
])(
  "does not prompt outside interactive implicit selection: %j",
  async ({ target, interactive, stdin, stdout }) => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdin });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdout });
    expect(await pickAppleNativeTarget({ root: await fixture(), target, interactive })).toBe(
      target,
    );
    expect(picker).not.toHaveBeenCalled();
  },
);

test("distinguishes identically named apps in different projects", async () => {
  const root = await fixture(false);
  const nested = join(root, "Other");
  await createIOSFixture(nested, { complete: true });
  const project = join(nested, "MyApp.xcodeproj/project.pbxproj");
  await Bun.write(
    project,
    (await Bun.file(project).text()).replaceAll(
      IOS_FIXTURE_IDS.appTarget,
      IOS_FIXTURE_IDS.secondTarget,
    ),
  );
  picker.mockResolvedValue(IOS_FIXTURE_IDS.secondTarget);

  const target = await pickAppleNativeTarget({ root, interactive: true });
  expect(picker.mock.calls[0]?.[0].choices).toEqual([
    expect.objectContaining({ name: "MyApp — iOS — MyApp.xcodeproj" }),
    expect.objectContaining({ name: "MyApp — iOS — Other/MyApp.xcodeproj" }),
  ]);
  expect((await inspectIOSProject(root, { target })).selection).toMatchObject({
    state: "selected",
    projectPath: "Other/MyApp.xcodeproj",
  });
});

test("retains the refusal for copied projects with indistinguishable IDs", async () => {
  const root = await fixture(false);
  await createIOSFixture(join(root, "Other"), { complete: true });
  const before = await treeDigest(root);
  const target = await pickAppleNativeTarget({ root, interactive: true });
  expect(picker).not.toHaveBeenCalled();
  await expect(
    applyIOSLocalSetup({ root, target, yes: true, agent: true, allowDirty: false }),
  ).rejects.toThrow("if IDs collide across copied projects");
  expect(await treeDigest(root)).toEqual(before);
});

test("does not offer a partial target inventory", async () => {
  const root = await fixture();
  await mkdir(join(root, ...Array.from({ length: 25 }, (_, i) => `Level${i}`)), {
    recursive: true,
  });
  expect(await pickAppleNativeTarget({ root, interactive: true })).toBeUndefined();
  expect(picker).not.toHaveBeenCalled();
});

test("cancellation stops selection without writing", async () => {
  const root = await fixture();
  const before = await treeDigest(root);
  picker.mockImplementation(async () => throwUserAbort());
  await expect(pickAppleNativeTarget({ root, interactive: true })).rejects.toMatchObject({
    name: "UserAbortError",
  });
  expect(await treeDigest(root)).toEqual(before);
});

test("planning rechecks the target after the user responds", async () => {
  const root = await fixture();
  picker.mockImplementation(async () => {
    const project = join(root, "MyApp.xcodeproj/project.pbxproj");
    await Bun.write(
      project,
      (await Bun.file(project).text()).replaceAll(
        IOS_FIXTURE_IDS.appTarget,
        "999999999999999999999999",
      ),
    );
    return IOS_FIXTURE_IDS.appTarget as never;
  });
  const target = await pickAppleNativeTarget({ root, interactive: true });
  const afterUserEdit = await treeDigest(root);
  await expect(
    applyIOSLocalSetup({ root, target, yes: true, agent: true, allowDirty: false }),
  ).rejects.toThrow("was not found. Available targets:");
  expect(await treeDigest(root)).toEqual(afterUserEdit);
});
