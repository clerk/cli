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

async function writeSdkKeylessFile(dir: string): Promise<void> {
  await mkdir(join(dir, ".clerk", ".tmp"), { recursive: true });
  await Bun.write(
    join(dir, ".clerk", ".tmp", "keyless.json"),
    JSON.stringify({ claimUrl: "https://dashboard.clerk.com/apps/claim?token=tok_sdk" }),
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

  test("an SDK keyless file without a breadcrumb is sdk_app", async () => {
    await writeSdkKeylessFile(folder);
    expect(await classifyUnlinkedFolder(folder)).toBe("sdk_app");
  });

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
      "This folder runs on an application `clerk init` created that no account owns yet. " +
        "Run `clerk link` to claim it into your account and link this folder, then rerun `clerk deploy`.",
    );
  });

  test("sdk_app says a person claims it with clerk open first", async () => {
    await writeSdkKeylessFile(folder);
    expect(await notLinkedMessage(folder, "clerk deploy")).toBe(
      "This folder runs on an application a Clerk SDK created that no account owns yet. " +
        "`clerk link` can't list it until it's claimed: a person must run `clerk open` to claim it in the Dashboard. " +
        "Then run `clerk link`, choose it, and rerun `clerk deploy`.",
    );
  });
});
