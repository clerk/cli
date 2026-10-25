/**
 * The `not_linked` error every command builds for a folder with no linked
 * app, and which folders' apps no app ID can reach.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { _resetMode, setMode } from "../mode.ts";
import {
  appInNoAccount,
  unlinkedFolderError,
  unlinkedFolderNextStep,
  type UnlinkedFolder,
} from "./unlinked-folder.ts";

afterEach(() => {
  _resetMode();
});

const PLAIN_KEYS: UnlinkedFolder = {
  kind: "unknown_owner",
  credential: "session",
  publishableKey: { name: "CLERK_PUBLISHABLE_KEY", source: ".env" },
};

describe("appInNoAccount", () => {
  test.each([
    { kind: "an init app", folder: { kind: "init_app", credential: "session" }, expected: true },
    {
      kind: "a claimable SDK app",
      folder: { kind: "sdk_app", credential: "session" },
      expected: true,
    },
    {
      kind: "an SDK app with no usable claim link",
      folder: {
        kind: "sdk_app",
        credential: "session",
        unusable: { reason: "its claim URL isn't https", findableByKey: true },
      },
      expected: false,
    },
    { kind: "plain keys", folder: PLAIN_KEYS, expected: false },
    { kind: "no app", folder: { kind: "no_app", credential: "session" }, expected: false },
  ] as { kind: string; folder: UnlinkedFolder; expected: boolean }[])(
    "$kind: $expected",
    ({ folder, expected }) => {
      expect(appInNoAccount(folder)).toBe(expected);
    },
  );
});

describe("unlinkedFolderError", () => {
  const LEAD = "No Clerk project linked to this directory.";
  const RERUN = { clause: "run `clerk deploy` again", command: "clerk deploy" };

  test("person: the lead, the step, then the tail, with no examples", () => {
    setMode("human");
    const step = unlinkedFolderNextStep(PLAIN_KEYS, { agent: false });

    const error = unlinkedFolderError(PLAIN_KEYS, { lead: LEAD, tail: "Or pass `--app`." });

    expect(error.code).toBe("not_linked");
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe(`${LEAD} ${step.text} Or pass \`--app\`.`);
    expect(error.examples).toBeUndefined();
  });

  test("agent: the step's commands and the rerun as examples", () => {
    setMode("agent");
    const step = unlinkedFolderNextStep(PLAIN_KEYS, { agent: true, rerun: RERUN });

    const error = unlinkedFolderError(PLAIN_KEYS, { lead: LEAD, rerun: RERUN });

    expect(error.message).toBe(`${LEAD} ${step.text}`);
    expect(error.message).toEndWith("Then run `clerk deploy` again.");
    expect(error.examples).toEqual(step.examples);
    expect(error.examples?.at(-1)?.command).toBe("clerk deploy");
  });
});
