import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCaptureLog } from "../test/lib/stubs.ts";
import { classifyUnlinkedFolder, notLinkedMessage } from "./unlinked-advice.ts";

let folder = "";

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "clerk-unlinked-advice-test-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function writeInitBreadcrumb(dir: string): Promise<void> {
  await mkdir(join(dir, ".clerk"), { recursive: true });
  await Bun.write(
    join(dir, ".clerk", "keyless.json"),
    JSON.stringify({ claimToken: "tok_init", createdAt: "2026-11-02T00:00:00.000Z" }),
  );
}

const SDK_FILE = [".clerk", ".tmp", "keyless.json"] as const;

async function writeSdkKeylessFile(dir: string, content?: string): Promise<void> {
  await mkdir(join(dir, ".clerk", ".tmp"), { recursive: true });
  await Bun.write(
    join(dir, ...SDK_FILE),
    content ??
      JSON.stringify({
        claimUrl: "https://dashboard.clerk.com/apps/claim?token=tok_sdk",
        publishableKey: "pk_test_sdk",
        secretKey: "sk_test_sdk",
      }),
  );
}

describe("classifyUnlinkedFolder", () => {
  useCaptureLog();

  test("a folder with neither keyless file is plain", async () => {
    expect(await classifyUnlinkedFolder(folder)).toBe("plain");
  });

  test("a clerk init breadcrumb with a claim token is init_app", async () => {
    await writeInitBreadcrumb(folder);
    expect(await classifyUnlinkedFolder(folder)).toBe("init_app");
  });

  test("an SDK keyless file with an https claim link and no breadcrumb is sdk_app", async () => {
    await writeSdkKeylessFile(folder);
    expect(await classifyUnlinkedFolder(folder)).toBe("sdk_app");
  });

  test.each([
    ["no claim link", "{}"],
    ["a non-https claim link", JSON.stringify({ claimUrl: "javascript:alert(1)" })],
    ["malformed JSON", '{"claimUrl": "https://dash'],
  ])(
    "an SDK keyless file with %s is plain, because clerk open has nothing to open",
    async (_label, content) => {
      await writeSdkKeylessFile(folder, content);

      expect(await classifyUnlinkedFolder(folder)).toBe("plain");
      expect(await Bun.file(join(folder, ...SDK_FILE)).exists()).toBe(true);
    },
  );

  test("the breadcrumb wins when both files exist, because clerk link can claim it", async () => {
    await writeInitBreadcrumb(folder);
    await writeSdkKeylessFile(folder);
    expect(await classifyUnlinkedFolder(folder)).toBe("init_app");
  });

  test("a malformed breadcrumb is left on disk and does not count as init_app", async () => {
    const path = join(folder, ".clerk", "keyless.json");
    await mkdir(join(folder, ".clerk"), { recursive: true });
    await Bun.write(path, JSON.stringify({ unexpected: true }));

    expect(await classifyUnlinkedFolder(folder)).toBe("plain");
    expect(await Bun.file(path).exists()).toBe(true);
  });
});

describe("notLinkedMessage", () => {
  test("plain keeps today's text with the caller's rerun command", async () => {
    expect(await notLinkedMessage(folder, "clerk deploy status")).toBe(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy status`.",
    );
  });

  test("init_app says clerk link claims the app", async () => {
    await writeInitBreadcrumb(folder);
    expect(await notLinkedMessage(folder, "clerk deploy")).toBe(
      "This folder holds a claim token a signed-out `clerk init` wrote to `.clerk/keyless.json`. " +
        "If no account owns that application yet, `clerk link` claims it into your account. " +
        "Run `clerk link` to link this folder, then rerun `clerk deploy`.",
    );
  });

  test("sdk_app says a person claims it with clerk open first", async () => {
    await writeSdkKeylessFile(folder);
    expect(await notLinkedMessage(folder, "clerk deploy")).toBe(
      "This folder holds a claim link a Clerk SDK wrote to `.clerk/.tmp/keyless.json`. " +
        "If no account owns that application yet, a person must run `clerk open` to claim it in the Dashboard. " +
        "Then run `clerk link` and choose it (agents: `clerk auth login` if needed, then `clerk apps list --json` and `clerk link --app <app_id>`), " +
        "then rerun `clerk deploy`.",
    );
  });
});
