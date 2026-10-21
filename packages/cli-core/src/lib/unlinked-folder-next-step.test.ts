/**
 * The next step each kind of unlinked folder gets. These assert which
 * commands are named, and in what order, not whole sentences: the wording may
 * be polished, the commands may not change.
 */

import { describe, expect, test } from "bun:test";
import { unlinkedFolderNextStep, type LinkStop, type UnlinkedFolder } from "./unlinked-folder.ts";

type Situation = { name: string; folder: UnlinkedFolder };

function situations(signedIn: boolean): Situation[] {
  return [
    { name: "an init app", folder: { kind: "init_app", signedIn } },
    { name: "an SDK app", folder: { kind: "sdk_app", signedIn } },
    {
      name: "an SDK app with no usable claim link",
      folder: { kind: "sdk_app", signedIn, unusable: "it has no publishable key" },
    },
    {
      name: "a publishable key",
      folder: {
        kind: "unknown_owner",
        signedIn,
        publishableKey: { name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", source: ".env.local" },
        secretKey: { name: "CLERK_SECRET_KEY", source: ".env.local" },
      },
    },
    {
      name: "a secret key only",
      folder: {
        kind: "unknown_owner",
        signedIn,
        secretKey: { name: "CLERK_SECRET_KEY", source: "CLERK_SECRET_KEY env var" },
      },
    },
    {
      name: "keys the CLI couldn't tell apart",
      folder: {
        kind: "unknown_owner",
        signedIn,
        couldntTell:
          "`.env` and `.env.local` hold different Clerk publishable keys, and the CLI doesn't know which one this app loads",
      },
    },
    { name: "no app", folder: { kind: "no_app", signedIn } },
  ];
}

const SIGNED_IN = situations(true);

function folderNamed(name: string): UnlinkedFolder {
  const found = SIGNED_IN.find((situation) => situation.name === name);
  if (!found) throw new Error(`no situation named ${name}`);
  return found.folder;
}
const PUBLISHABLE = folderNamed("a publishable key");
const SECRET_ONLY = folderNamed("a secret key only");
const COULDNT_TELL = folderNamed("keys the CLI couldn't tell apart");
const SIGNED_OUT = situations(false);
const ALL = [...SIGNED_IN, ...SIGNED_OUT];
const MODES = [
  { mode: "person", agent: false },
  { mode: "agent", agent: true },
];
const EVERY_CELL = ALL.flatMap((situation) =>
  MODES.map(({ mode, agent }) => ({
    ...situation,
    mode,
    agent,
    signedIn: situation.folder.signedIn,
  })),
);

const LINK_STOPS: { stop: string; linkStop: LinkStop }[] = [
  { stop: "no key", linkStop: { autolink: "no_key" } },
  { stop: "no match", linkStop: { autolink: "no_match" } },
  { stop: "couldn't tell", linkStop: { autolink: "couldnt_tell" } },
  { stop: "a refused session", linkStop: { autolink: "list_failed", sessionRefused: true } },
];

const commands = (folder: UnlinkedFolder, context: Parameters<typeof unlinkedFolderNextStep>[1]) =>
  unlinkedFolderNextStep(folder, context).examples.map((example) => example.command);

describe("init app", () => {
  test.each([
    { who: "a person, signed in", agent: false, signedIn: true },
    { who: "a person, signed out (`clerk link` signs in itself)", agent: false, signedIn: false },
    { who: "an agent, signed in", agent: true, signedIn: true },
  ])("$who: `clerk link`, which claims and links", ({ agent, signedIn }) => {
    const step = unlinkedFolderNextStep({ kind: "init_app", signedIn }, { agent });

    expect(step.examples.map((example) => example.command)).toEqual(["clerk link"]);
    expect(step.text).toContain("claims");
    expect(step.text).not.toContain("clerk auth login");
  });

  test("an agent, signed out: `clerk auth login`, which claims and links", () => {
    const step = unlinkedFolderNextStep({ kind: "init_app", signedIn: false }, { agent: true });

    expect(step.examples.map((example) => example.command)).toEqual(["clerk auth login"]);
    expect(step.text).toContain("claims");
  });
});

describe("SDK app", () => {
  test("a person: `clerk link`, which opens the claim page", () => {
    const step = unlinkedFolderNextStep({ kind: "sdk_app", signedIn: false }, { agent: false });

    expect(step.examples.map((example) => example.command)).toEqual(["clerk link"]);
    expect(step.text).toContain("claim");
  });

  test.each([
    { signedIn: true, expected: ["clerk open", "clerk link"] },
    { signedIn: false, expected: ["clerk open", "clerk auth login", "clerk link"] },
  ])(
    "an agent, signed in: $signedIn: `clerk open` before `clerk link`",
    ({ signedIn, expected }) => {
      expect(commands({ kind: "sdk_app", signedIn }, { agent: true })).toEqual([...expected]);
    },
  );

  test.each([
    { who: "a person", agent: false, signedIn: true, expected: ["clerk link --app <app_id>"] },
    {
      who: "an agent, signed in",
      agent: true,
      signedIn: true,
      expected: ["clerk apps list --json", "clerk link --app <app_id>"],
    },
    {
      who: "an agent, signed out",
      agent: true,
      signedIn: false,
      expected: ["clerk auth login", "clerk apps list --json", "clerk link --app <app_id>"],
    },
  ])("no usable claim link, $who: link by ID, saying why", ({ agent, signedIn, expected }) => {
    const folder: UnlinkedFolder = {
      kind: "sdk_app",
      signedIn,
      unusable: "it has no publishable key",
    };
    const step = unlinkedFolderNextStep(folder, { agent });

    expect(step.examples.map((example) => example.command)).toEqual([...expected]);
    expect(step.text).toContain("it has no publishable key");
  });
});

describe("keys whose owner is unknown", () => {
  test("a publishable key promises detection, naming where the key is", () => {
    const step = unlinkedFolderNextStep(PUBLISHABLE, { agent: false });

    expect(step.examples.map((example) => example.command)).toEqual(["clerk link"]);
    expect(step.text).toContain("finds the app");
    expect(step.text).toContain("`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in .env.local");
  });

  test("a publishable key, agent signed out: sign in, then `clerk link`", () => {
    const folder = { ...PUBLISHABLE, signedIn: false };

    expect(commands(folder, { agent: true })).toEqual(["clerk auth login", "clerk link"]);
  });

  test.each([
    { who: "a secret key only", folder: SECRET_ONLY },
    { who: "keys the CLI couldn't tell apart", folder: COULDNT_TELL },
  ])("$who: no promise of detection", ({ folder }) => {
    const person = unlinkedFolderNextStep(folder, { agent: false });

    expect(person.text).not.toContain("finds the app");
    expect(commands(folder, { agent: true })).toEqual([
      "clerk apps list --json",
      "clerk link --app <app_id>",
    ]);
  });

  test("a secret key only names where the key is", () => {
    expect(unlinkedFolderNextStep(SECRET_ONLY, { agent: false }).text).toContain(
      "the `CLERK_SECRET_KEY` env var",
    );
  });

  test("keys the CLI couldn't tell apart give the reason", () => {
    expect(unlinkedFolderNextStep(COULDNT_TELL, { agent: false }).text).toContain(
      "hold different Clerk publishable keys",
    );
  });

  test.each(EVERY_CELL.filter(({ folder }) => folder.kind === "unknown_owner"))(
    "$name, $mode, signed in: $signedIn: never says unclaimed",
    ({ folder, agent }) => {
      expect(unlinkedFolderNextStep(folder, { agent }).text.toLowerCase()).not.toContain(
        "unclaimed",
      );
    },
  );
});

describe("no app", () => {
  test.each([true, false])(
    "a person, signed in: %p: names `clerk link` and `clerk init`",
    (signedIn) => {
      const { text } = unlinkedFolderNextStep({ kind: "no_app", signedIn }, { agent: false });

      expect(text).toContain("`clerk link`");
      expect(text).toContain("`clerk init`");
    },
  );

  test.each([
    {
      signedIn: true,
      expected: ["clerk apps list --json", "clerk link --app <app_id>", "clerk init"],
    },
    {
      signedIn: false,
      expected: [
        "clerk auth login",
        "clerk apps list --json",
        "clerk link --app <app_id>",
        "clerk init",
      ],
    },
  ])("an agent, signed in: $signedIn: list and link by ID, or create", ({ signedIn, expected }) => {
    expect(commands({ kind: "no_app", signedIn }, { agent: true })).toEqual([...expected]);
  });
});

describe("every cell", () => {
  test.each(EVERY_CELL)(
    "$name, $mode, signed in: $signedIn: no `deploy --app`, `init --accountless`, or URL",
    ({ folder, agent }) => {
      const step = unlinkedFolderNextStep(folder, { agent });
      const everything = [step.text, ...step.examples.map((example) => example.command)].join("\n");

      expect(everything).not.toContain("deploy --app");
      expect(everything).not.toContain("init --accountless");
      expect(everything).not.toContain("://");
    },
  );

  test.each(SIGNED_OUT.filter(({ name }) => name !== "an SDK app"))(
    "$name, agent signed out: starts with `clerk auth login`",
    ({ folder }) => {
      expect(commands(folder, { agent: true })[0]).toBe("clerk auth login");
    },
  );

  test("an SDK app, agent signed out: starts with `clerk open`", () => {
    expect(commands({ kind: "sdk_app", signedIn: false }, { agent: true })[0]).toBe("clerk open");
  });

  test.each(EVERY_CELL)(
    "$name, $mode, signed in: $signedIn: every example has a description",
    ({ folder, agent }) => {
      const { examples } = unlinkedFolderNextStep(folder, { agent });

      expect(examples.length).toBeGreaterThan(0);
      expect(examples.every((example) => example.description.length > 0)).toBe(true);
    },
  );
});

describe("the rerun", () => {
  test("appends the clause and ends the examples with the command", () => {
    const step = unlinkedFolderNextStep(
      { kind: "no_app", signedIn: true },
      {
        agent: true,
        rerun: {
          clause: "run `clerk deploy --domain example.com` again",
          command: "clerk deploy --domain example.com",
        },
      },
    );

    expect(step.text).toEndWith("Then run `clerk deploy --domain example.com` again.");
    expect(step.examples.at(-1)?.command).toBe("clerk deploy --domain example.com");
  });

  test("without a command (its arguments may hold a secret), adds the clause but no example", () => {
    const step = unlinkedFolderNextStep(
      { kind: "init_app", signedIn: true },
      { agent: true, rerun: { clause: "run the same `clerk migrate import` command again" } },
    );

    expect(step.text).toEndWith("Then run the same `clerk migrate import` command again.");
    expect(step.examples.map((example) => example.command)).toEqual(["clerk link"]);
  });
});

// Agent-mode `clerk link`, or `clerk init` through it, just stopped: the advice
// never sends the agent back into that stop.
describe("after agent-mode `clerk link` stopped", () => {
  const stoppedCells = LINK_STOPS.flatMap(({ stop, linkStop }) =>
    ALL.filter(({ folder }) => folder.kind !== "init_app").map((situation) => ({
      ...situation,
      stop,
      linkStop,
      signedIn: situation.folder.signedIn,
    })),
  );

  test.each(stoppedCells)(
    "$stop, $name, signed in: $signedIn: the first example isn't `clerk link`",
    ({ folder, linkStop }) => {
      expect(commands(folder, { agent: true, linkStop })[0]).not.toBe("clerk link");
    },
  );

  test("no match: says no app in the account uses the key, then lists and links by ID", () => {
    const step = unlinkedFolderNextStep(PUBLISHABLE, {
      agent: true,
      linkStop: { autolink: "no_match" },
    });

    expect(step.text).toContain("No application in your account uses");
    expect(step.examples.map((example) => example.command)).toEqual([
      "clerk apps list --json",
      "clerk link --app <app_id>",
    ]);
  });

  test("couldn't tell: lists and links by ID, without repeating the stop's reason", () => {
    const step = unlinkedFolderNextStep(COULDNT_TELL, {
      agent: true,
      linkStop: { autolink: "couldnt_tell" },
    });

    expect(step.examples.map((example) => example.command)).toEqual([
      "clerk apps list --json",
      "clerk link --app <app_id>",
    ]);
    expect(step.text).not.toContain("hold different");
  });

  test("no key, no app, signed in: keeps today's sentence", () => {
    const step = unlinkedFolderNextStep(
      { kind: "no_app", signedIn: true },
      { agent: true, linkStop: { autolink: "no_key" } },
    );

    expect(step.text).toBe("Pass --app <id>, or run `clerk apps list --json` and retry.");
  });

  // An SDK app's own steps start with `clerk open`; `link` never reaches this
  // stop for one.
  test.each(ALL.filter(({ folder, name }) => folder.kind !== "init_app" && name !== "an SDK app"))(
    "a refused session, $name: signs in first and never says the app isn't in the account",
    ({ folder }) => {
      const step = unlinkedFolderNextStep(folder, {
        agent: true,
        linkStop: { autolink: "list_failed", sessionRefused: true },
      });

      expect(step.examples[0]?.command).toBe("clerk auth login");
      expect(step.text).not.toMatch(/isn't in|not in your account|No application in your account/);
    },
  );

  test("any other failed list: a retry of the same command, never a claim about the account", () => {
    const step = unlinkedFolderNextStep(PUBLISHABLE, {
      agent: true,
      rerun: { clause: "run `clerk init` again", command: "clerk init" },
      linkStop: { autolink: "list_failed", sessionRefused: false },
    });

    expect(step.text).toContain("retry: run `clerk init` again");
    expect(step.text).not.toMatch(/isn't in|not in your account|No application in your account/);
    expect(step.examples.map((example) => example.command)).toEqual(["clerk init"]);
  });

  test("any other failed list, with no rerun given: retry the same command", () => {
    const step = unlinkedFolderNextStep(PUBLISHABLE, {
      agent: true,
      linkStop: { autolink: "list_failed", sessionRefused: false },
    });

    expect(step.text).toContain("retry: run the same command again");
  });

  test.each([
    { signedIn: true, expected: ["clerk link"] },
    { signedIn: false, expected: ["clerk auth login"] },
  ])("an init token, signed in: $signedIn: the init app's own step", ({ signedIn, expected }) => {
    expect(
      commands({ kind: "init_app", signedIn }, { agent: true, linkStop: { autolink: "no_key" } }),
    ).toEqual([...expected]);
  });
});
