/**
 * `clerk migrate undo` with a human at the prompt.
 *
 * Its own file because `mock.module` replaces `prompts.ts` for the whole
 * process, and `undo.test.ts` runs non-interactively.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let confirmed: () => void = () => {};
mock.module("../../lib/prompts.ts", () => ({
  confirm: async () => {
    confirmed();
    return true;
  },
}));

const { startRun } = await import("./lib/run-store.ts");
const { terminal } = await import("./lib/terminal.ts");
const { undo } = await import("./undo.ts");

const IMPORT_STARTED = "2026-09-01T00:00:00.000Z";
const AFTER_IMPORT = Date.parse("2026-09-02T00:00:00.000Z");

let runsDir: string;
let originalFetch: typeof globalThis.fetch;
let originalMode: string | undefined;
const terminalAvailable = spyOn(terminal, "available");
/** Clerk IDs the stubbed instance holds, with each one's last sign-in. */
let instanceUsers: Map<string, number | null>;
let deletes: string[];

beforeAll(() => {
  originalFetch = globalThis.fetch;
  originalMode = process.env.CLERK_MODE;
});

afterAll(() => {
  terminalAvailable.mockRestore();
  if (originalMode === undefined) delete process.env.CLERK_MODE;
  else process.env.CLERK_MODE = originalMode;
});

beforeEach(() => {
  process.env.CLERK_MODE = "human";
  terminalAvailable.mockReturnValue(true);
  runsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-undo-human-")));
  deletes = [];
  confirmed = () => {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/instance") {
      return Response.json({ object: "instance", id: "ins_1", environment_type: "development" });
    }
    if (method === "GET" && url.pathname === "/v1/users") {
      return Response.json(
        url.searchParams
          .getAll("user_id")
          .filter((id) => instanceUsers.has(id))
          .map((id) => ({ id, last_sign_in_at: instanceUsers.get(id) })),
      );
    }
    if (method === "DELETE") {
      const id = url.pathname.split("/").pop() as string;
      deletes.push(id);
      instanceUsers.delete(id);
      return Response.json({ id, deleted: true });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exitCode = 0;
  fs.rmSync(runsDir, { recursive: true, force: true });
});

// The prompt warned about user_a. While it waited, user_a was deleted
// elsewhere and user_b signed in: one signed in either way, so a count would
// match, and user_b would be deleted with nobody agreeing to it.
test("refuses a user who signed in while the prompt waited, though the count is the same", async () => {
  instanceUsers = new Map([
    ["user_a", AFTER_IMPORT],
    ["user_b", null],
  ]);
  const run = startRun(runsDir, {
    kind: "import",
    target: { instanceId: "ins_1", env: "development" },
    source: "clerk",
  });
  run.update({ startedAt: IMPORT_STARTED });
  run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
  run.append({ sourceId: "b", status: "created", clerkId: "user_b" });
  const record = run.finish();
  confirmed = () => {
    instanceUsers.delete("user_a");
    instanceUsers.set("user_b", AFTER_IMPORT);
  };

  await expect(undo(record.id, { secretKey: "sk_test_x", runsDir })).rejects.toThrow(
    /1 more user the import created signed in after the preview/,
  );
  expect(deletes).toEqual([]);
});
