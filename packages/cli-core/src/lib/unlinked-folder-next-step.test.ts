/**
 * The next step each kind of unlinked folder gets. These assert which
 * commands are named, and in what order, not whole sentences: the wording may
 * be polished, the commands may not change.
 */

import { describe, expect, test } from "bun:test";
import {
  unlinkedFolderNextStep,
  type Credential,
  type LinkStop,
  type Rerun,
  type UnlinkedFolder,
} from "./unlinked-folder.ts";

type Situation = { name: string; folder: UnlinkedFolder };

/** A stored session stands for any credential; `none` is signed out. */
const signedInAs = (signedIn: boolean): Credential => (signedIn ? "session" : "none");

function situations(credential: Credential): Situation[] {
  return [
    { name: "an init app", folder: { kind: "init_app", credential } },
    { name: "an SDK app", folder: { kind: "sdk_app", credential } },
    {
      name: "an SDK app whose file has no publishable key",
      folder: {
        kind: "sdk_app",
        credential,
        unusable: { reason: "it has no publishable key", findableByKey: false },
      },
    },
    {
      name: "an SDK app whose claim link is unusable",
      folder: {
        kind: "sdk_app",
        credential,
        unusable: { reason: "it has no claim URL", findableByKey: true },
      },
    },
    {
      name: "a publishable key",
      folder: {
        kind: "unknown_owner",
        credential,
        publishableKey: { name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", source: ".env.local" },
        secretKey: { name: "CLERK_SECRET_KEY", source: ".env.local" },
      },
    },
    {
      name: "a secret key only",
      folder: {
        kind: "unknown_owner",
        credential,
        secretKey: { name: "CLERK_SECRET_KEY", source: "CLERK_SECRET_KEY env var" },
      },
    },
    {
      name: "keys the CLI couldn't tell apart",
      folder: {
        kind: "unknown_owner",
        credential,
        couldntTell:
          "`.env` and `.env.local` hold different Clerk publishable keys, and the CLI doesn't know which one this app loads",
      },
    },
    { name: "no app", folder: { kind: "no_app", credential } },
  ];
}

const SESSION = situations("session");
const API_KEY = situations("api_key");
const NONE = situations("none");
const SIGNED_IN = [...SESSION, ...API_KEY];
const ALL = [...SIGNED_IN, ...NONE];

function folderNamed(name: string): UnlinkedFolder {
  const found = SESSION.find((situation) => situation.name === name);
  if (!found) throw new Error(`no situation named ${name}`);
  return found.folder;
}
const PUBLISHABLE = folderNamed("a publishable key");
const SECRET_ONLY = folderNamed("a secret key only");
const COULDNT_TELL = folderNamed("keys the CLI couldn't tell apart");

/** Each situation with its credential, for test names. */
const named = (list: Situation[]) =>
  list.map((situation) => ({ ...situation, credential: situation.folder.credential }));

/**
 * An SDK app that can be claimed: outside a stop, its steps start with
 * `clerk open`. After a stop, a failed list signs in first like every kind.
 */
const isClaimableSdkApp = ({ name }: Situation) => name === "an SDK app";

const MODES = [
  { mode: "person", agent: false },
  { mode: "agent", agent: true },
];
const EVERY_CELL = ALL.flatMap((situation) =>
  MODES.map(({ mode, agent }) => ({
    ...situation,
    mode,
    agent,
    credential: situation.folder.credential,
  })),
);

const LINK_RETRY: Rerun = { clause: "run `clerk link` again", command: "clerk link" };
const INIT_RERUN: Rerun = { clause: "run `clerk init` again", command: "clerk init" };

// The stops whose advice is never the command that stopped.
const LINK_STOPS: { stop: string; linkStop: LinkStop }[] = [
  { stop: "no key", linkStop: { autolink: "no_key" } },
  { stop: "no match", linkStop: { autolink: "no_match" } },
  { stop: "couldn't tell", linkStop: { autolink: "couldnt_tell" } },
  {
    stop: "a refused credential",
    linkStop: { autolink: "list_failed", refused: true, retry: LINK_RETRY },
  },
];
const NO_MATCH: LinkStop = { autolink: "no_match" };
const ANOTHER_FAILURE: LinkStop = { autolink: "list_failed", refused: false, retry: LINK_RETRY };
const REFUSED: LinkStop = { autolink: "list_failed", refused: true, retry: LINK_RETRY };

// An init app "isn't in an account yet" by its token alone; only a list can
// say the app isn't in this account.
const SAYS_NOT_IN_ACCOUNT =
  /isn't in your account|not in your account|No application in your account/;

const commands = (folder: UnlinkedFolder, context: Parameters<typeof unlinkedFolderNextStep>[1]) =>
  unlinkedFolderNextStep(folder, context).examples.map((example) => example.command);

describe("init app", () => {
  test.each([
    { who: "a person, signed in", agent: false, signedIn: true },
    { who: "a person, signed out (`clerk link` signs in itself)", agent: false, signedIn: false },
    { who: "an agent, signed in", agent: true, signedIn: true },
  ])("$who: `clerk link`, which claims and links", ({ agent, signedIn }) => {
    const step = unlinkedFolderNextStep(
      { kind: "init_app", credential: signedInAs(signedIn) },
      { agent },
    );

    expect(step.examples.map((example) => example.command)).toEqual(["clerk link"]);
    expect(step.text).toContain("claims");
    expect(step.text).not.toContain("clerk auth login");
  });

  test("an agent, signed out: `clerk auth login`, which claims and links", () => {
    const step = unlinkedFolderNextStep({ kind: "init_app", credential: "none" }, { agent: true });

    expect(step.examples.map((example) => example.command)).toEqual(["clerk auth login"]);
    expect(step.text).toContain("claims");
  });
});

describe("SDK app", () => {
  test("a person: `clerk link`, which opens the claim page", () => {
    const step = unlinkedFolderNextStep({ kind: "sdk_app", credential: "none" }, { agent: false });

    expect(step.examples.map((example) => example.command)).toEqual(["clerk link"]);
    expect(step.text).toContain("claim");
  });

  test.each([
    { credential: "session" as const, expected: ["clerk open", "clerk link"] },
    { credential: "api_key" as const, expected: ["clerk open", "clerk link"] },
    { credential: "none" as const, expected: ["clerk open", "clerk auth login", "clerk link"] },
  ])("an agent with $credential: `clerk open` before `clerk link`", ({ credential, expected }) => {
    expect(commands({ kind: "sdk_app", credential }, { agent: true })).toEqual([...expected]);
  });

  // The next `clerk link` searches only where the CLI's credential points.
  test.each([
    { credential: "api_key" as const, into: "the workspace `CLERK_PLATFORM_API_KEY` belongs to" },
    { credential: "session" as const, into: "the account this CLI is signed in to" },
    { credential: "none" as const, into: "the account `clerk auth login` will sign in to" },
  ])("an agent with $credential: says where the person must claim it", ({ credential, into }) => {
    const { text } = unlinkedFolderNextStep({ kind: "sdk_app", credential }, { agent: true });

    expect(text).toContain(`claim the app into ${into}`);
  });

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
  ])("no publishable key, $who: link by ID, saying why", ({ agent, signedIn, expected }) => {
    const folder: UnlinkedFolder = {
      kind: "sdk_app",
      credential: signedInAs(signedIn),
      unusable: { reason: "it has no publishable key", findableByKey: false },
    };
    const step = unlinkedFolderNextStep(folder, { agent });

    expect(step.examples.map((example) => example.command)).toEqual([...expected]);
    expect(step.text).toContain("it has no publishable key");
  });

  // `clerk link` still finds the app by its key; if it isn't in the account,
  // `link` stops saying to link by ID, so this can't loop.
  test.each([
    { who: "a person", agent: false, signedIn: false, expected: ["clerk link"] },
    { who: "an agent, signed in", agent: true, signedIn: true, expected: ["clerk link"] },
    {
      who: "an agent, signed out",
      agent: true,
      signedIn: false,
      expected: ["clerk auth login", "clerk link"],
    },
  ])(
    "a publishable key but no usable claim link, $who: `clerk link` finds it by key",
    ({ agent, signedIn, expected }) => {
      const folder: UnlinkedFolder = {
        kind: "sdk_app",
        credential: signedInAs(signedIn),
        unusable: { reason: "its claim URL isn't an https link", findableByKey: true },
      };
      const step = unlinkedFolderNextStep(folder, { agent });

      expect(step.examples.map((example) => example.command)).toEqual([...expected]);
      expect(step.text).toContain("its claim URL isn't an https link");
      expect(step.text).toContain("clerk link --app <app_id>");
      expect(step.text).not.toContain("clerk open");
    },
  );
});

describe("keys whose owner is unknown", () => {
  test("a publishable key promises detection, naming where the key is", () => {
    const step = unlinkedFolderNextStep(PUBLISHABLE, { agent: false });

    expect(step.examples.map((example) => example.command)).toEqual(["clerk link"]);
    expect(step.text).toContain("finds the app");
    expect(step.text).toContain("`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in .env.local");
  });

  test("a publishable key, agent signed out: sign in, then `clerk link`", () => {
    const folder: UnlinkedFolder = { ...PUBLISHABLE, credential: "none" };

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
    "$name, $mode, $credential: never says unclaimed",
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
      const { text } = unlinkedFolderNextStep(
        { kind: "no_app", credential: signedInAs(signedIn) },
        { agent: false },
      );

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
    expect(commands({ kind: "no_app", credential: signedInAs(signedIn) }, { agent: true })).toEqual(
      [...expected],
    );
  });
});

// A folder with no app of its own: the list is for choosing an existing one.
describe("no app, the list's description", () => {
  test.each([
    { who: "signed in", credential: "session" as const, linkStop: undefined },
    { who: "signed out", credential: "none" as const, linkStop: undefined },
    {
      who: "after `link`'s no-key stop",
      credential: "session" as const,
      linkStop: { autolink: "no_key" } as LinkStop,
    },
  ])('an agent, $who: never "the one this folder uses"', ({ credential, linkStop }) => {
    const step = unlinkedFolderNextStep({ kind: "no_app", credential }, { agent: true, linkStop });

    expect(JSON.stringify(step)).not.toContain("this folder uses");
  });
});

describe("every cell", () => {
  test.each(EVERY_CELL)(
    "$name, $mode, $credential: no `deploy --app`, `init --accountless`, or URL",
    ({ folder, agent }) => {
      const step = unlinkedFolderNextStep(folder, { agent });
      const everything = [step.text, ...step.examples.map((example) => example.command)].join("\n");

      expect(everything).not.toContain("deploy --app");
      expect(everything).not.toContain("init --accountless");
      expect(everything).not.toContain("://");
    },
  );

  test.each(NONE.filter((situation) => !isClaimableSdkApp(situation)))(
    "$name, agent signed out: starts with `clerk auth login`",
    ({ folder }) => {
      expect(commands(folder, { agent: true })[0]).toBe("clerk auth login");
    },
  );

  test("an SDK app, agent signed out: starts with `clerk open`", () => {
    expect(commands({ kind: "sdk_app", credential: "none" }, { agent: true })[0]).toBe(
      "clerk open",
    );
  });

  test.each(EVERY_CELL)(
    "$name, $mode, $credential: every example has a description",
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
      { kind: "no_app", credential: "session" },
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
      { kind: "init_app", credential: "session" },
      { agent: true, rerun: { clause: "run the same `clerk migrate import` command again" } },
    );

    expect(step.text).toEndWith("Then run the same `clerk migrate import` command again.");
    expect(step.examples.map((example) => example.command)).toEqual(["clerk link"]);
  });
});

// Agent-mode `clerk link`, or `clerk init` through it, just stopped: the advice
// never sends the agent back into that stop.
describe("after agent-mode `clerk link` stopped", () => {
  // A refused API key's advice ends with the retry, once the key is fixed.
  const stoppedCells = LINK_STOPS.flatMap(({ stop, linkStop }) =>
    ALL.filter(
      ({ folder }) => !(linkStop.autolink === "list_failed" && folder.credential === "api_key"),
    ).map((situation) => ({
      ...situation,
      stop,
      linkStop,
      credential: situation.folder.credential,
    })),
  );

  test.each(stoppedCells)(
    "$stop, $name, $credential: the first example isn't `clerk link`",
    ({ folder, linkStop }) => {
      expect(commands(folder, { agent: true, linkStop })[0]).not.toBe("clerk link");
    },
  );

  const everyStopCell = [...LINK_STOPS, { stop: "another failure", linkStop: ANOTHER_FAILURE }]
    .flatMap(({ stop, linkStop }) =>
      ALL.map((situation) => ({
        ...situation,
        stop,
        linkStop,
        credential: situation.folder.credential,
      })),
    )
    .flatMap((cell) => [
      { ...cell, rerunLabel: "no rerun", rerun: undefined },
      { ...cell, rerunLabel: "init's rerun", rerun: INIT_RERUN },
    ]);

  test.each(everyStopCell)(
    "$stop, $name, $credential, $rerunLabel: safe, runnable, described",
    ({ folder, linkStop, rerun }) => {
      const step = unlinkedFolderNextStep(folder, { agent: true, linkStop, rerun });
      const everything = [step.text, ...step.examples.map((example) => example.command)].join("\n");

      expect(everything).not.toContain("deploy --app");
      expect(everything).not.toContain("init --accountless");
      expect(everything).not.toContain("://");
      expect(step.examples.length).toBeGreaterThan(0);
      expect(step.examples.every((example) => example.description.length > 0)).toBe(true);
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

  // The SDK's app isn't in the account, so listing it to link by ID would pick
  // another app: the claimable one is claimed first.
  test.each([
    { credential: "session" as const, into: "the account this CLI is signed in to" },
    { credential: "api_key" as const, into: "the workspace `CLERK_PLATFORM_API_KEY` belongs to" },
  ])(
    "no match on a claimable SDK app, $credential: `clerk open` naming where to claim, then `clerk link`",
    ({ credential, into }) => {
      const step = unlinkedFolderNextStep(
        { kind: "sdk_app", credential },
        { agent: true, linkStop: { autolink: "no_match" } },
      );

      expect(step.examples.map((example) => example.command)).toEqual(["clerk open", "clerk link"]);
      expect(step.text).toContain(`claim the app into ${into}`);
    },
  );

  test("no match on an SDK app whose claim link is unusable: list, then link by ID, saying why", () => {
    const step = unlinkedFolderNextStep(
      {
        kind: "sdk_app",
        credential: "session",
        unusable: { reason: "it has no claim URL", findableByKey: true },
      },
      { agent: true, linkStop: { autolink: "no_match" } },
    );

    expect(step.examples.map((example) => example.command)).toEqual([
      "clerk apps list --json",
      "clerk link --app <app_id>",
    ]);
    expect(step.text).toContain("has no usable claim link: it has no claim URL");
  });

  test("no match with CLERK_PLATFORM_API_KEY names the key's workspace, not your account", () => {
    const { text } = unlinkedFolderNextStep(
      { ...PUBLISHABLE, credential: "api_key" },
      { agent: true, linkStop: { autolink: "no_match" } },
    );

    expect(text).toContain("No application in the workspace `CLERK_PLATFORM_API_KEY` belongs to");
  });

  // The folder's app isn't in the list, or can't be found by key, so the
  // choice is an existing app, never "the app this folder uses".
  test.each([
    { row: "no match on a plain key", folder: PUBLISHABLE, linkStop: NO_MATCH },
    {
      row: "no match on an init app",
      folder: { kind: "init_app", credential: "session" } as UnlinkedFolder,
      linkStop: NO_MATCH,
    },
    {
      row: "no match on an SDK app whose claim link is unusable",
      folder: {
        kind: "sdk_app",
        credential: "session",
        unusable: { reason: "it has no claim URL", findableByKey: true },
      } as UnlinkedFolder,
      linkStop: NO_MATCH,
    },
    {
      row: "no key, on an SDK app whose claim link is unusable",
      folder: {
        kind: "sdk_app",
        credential: "session",
        unusable: { reason: "it has no claim URL", findableByKey: true },
      } as UnlinkedFolder,
      linkStop: { autolink: "no_key" } as LinkStop,
    },
    {
      row: "an SDK file with no publishable key",
      folder: {
        kind: "sdk_app",
        credential: "session",
        unusable: { reason: "it has no publishable key", findableByKey: false },
      } as UnlinkedFolder,
      linkStop: undefined,
    },
  ])("$row: links an existing application, not the folder's", ({ folder, linkStop }) => {
    const step = unlinkedFolderNextStep(folder, { agent: true, linkStop });

    expect(JSON.stringify(step)).not.toContain("this folder uses");
  });

  // The folder's app may be in the list here.
  test.each([
    {
      row: "couldn't tell",
      folder: COULDNT_TELL,
      linkStop: { autolink: "couldnt_tell" } as LinkStop,
    },
    { row: "a secret key only", folder: SECRET_ONLY, linkStop: undefined },
    {
      row: "a spent init token",
      folder: { kind: "init_app", credential: "session" } as UnlinkedFolder,
      linkStop: { autolink: "no_key" } as LinkStop,
    },
  ])("$row: links the app this folder uses", ({ folder, linkStop }) => {
    const { text } = unlinkedFolderNextStep(folder, { agent: true, linkStop });

    expect(text).toContain("with the app this folder uses");
  });

  test("no match on a key exported in the shell names the variable", () => {
    const folder: UnlinkedFolder = {
      kind: "unknown_owner",
      credential: "session",
      publishableKey: { name: "CLERK_PUBLISHABLE_KEY", source: "CLERK_PUBLISHABLE_KEY env var" },
    };
    const { text } = unlinkedFolderNextStep(folder, {
      agent: true,
      linkStop: { autolink: "no_match" },
    });

    expect(text).toContain("the `CLERK_PUBLISHABLE_KEY` env var");
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

  test.each(["session" as const, "api_key" as const])(
    "no key, no app, %s: keeps today's sentence",
    (credential) => {
      const step = unlinkedFolderNextStep(
        { kind: "no_app", credential },
        { agent: true, linkStop: { autolink: "no_key" } },
      );

      expect(step.text).toBe("Pass --app <id>, or run `clerk apps list --json` and retry.");
    },
  );

  // A failed list is a credential problem, not proof the app needs claiming:
  // after signing in, the retry decides. An init app's sign-in claims it.
  const signInThenRetry = (folder: UnlinkedFolder) =>
    folder.kind === "init_app" ? ["clerk auth login"] : ["clerk auth login", "clerk link"];

  test.each(named([...SESSION, ...NONE]))(
    "a refused session, or none, $name, $credential: signs in, then retries; never a claim about the account",
    ({ folder }) => {
      const step = unlinkedFolderNextStep(folder, { agent: true, linkStop: REFUSED });

      expect(step.examples.map((example) => example.command)).toEqual(signInThenRetry(folder));
      expect(step.text).not.toMatch(SAYS_NOT_IN_ACCOUNT);
    },
  );

  test("`clerk init` through `link`, a refused session: signs in, then retries `clerk init`", () => {
    const step = unlinkedFolderNextStep(PUBLISHABLE, {
      agent: true,
      rerun: INIT_RERUN,
      linkStop: { autolink: "list_failed", refused: true, retry: INIT_RERUN },
    });

    expect(step.text).toContain("then run `clerk init` again");
    expect(step.examples.map((example) => example.command)).toEqual([
      "clerk auth login",
      "clerk init",
    ]);
  });

  // Platform API calls use the key over any session, so signing in can't help.
  test.each(API_KEY)(
    "a refused CLERK_PLATFORM_API_KEY, $name: fix the key, then retry",
    ({ folder }) => {
      const step = unlinkedFolderNextStep(folder, { agent: true, linkStop: REFUSED });

      expect(step.text).toContain("CLERK_PLATFORM_API_KEY");
      expect(step.text).toContain("run `clerk link` again");
      expect(step.examples.map((example) => example.command)).toEqual(["clerk link"]);
      expect(step.text).not.toMatch(SAYS_NOT_IN_ACCOUNT);
    },
  );

  test.each(named(SIGNED_IN))(
    "another failure, $name, $credential: retry first, then link by ID if it fails again",
    ({ folder }) => {
      const step = unlinkedFolderNextStep(folder, { agent: true, linkStop: ANOTHER_FAILURE });

      expect(step.text).toContain("retry: run `clerk link` again");
      expect(step.text).toContain("If it fails again");
      expect(step.text).toContain("Clerk Dashboard");
      expect(step.text).not.toContain("Then run");
      expect(step.examples.map((example) => example.command)).toEqual([
        "clerk link",
        "clerk link --app <app_id>",
      ]);
      expect(step.text).not.toMatch(SAYS_NOT_IN_ACCOUNT);
    },
  );

  test.each(NONE)(
    "another failure with no credential, $name: signs in first, never the bare retry",
    ({ folder }) => {
      const step = unlinkedFolderNextStep(folder, { agent: true, linkStop: ANOTHER_FAILURE });

      expect(step.examples.map((example) => example.command)).toEqual(signInThenRetry(folder));
      expect(step.text).not.toContain("can be temporary");
    },
  );

  test("`clerk init` through `link`, another failure: retries `clerk init`, then links by ID and reruns it", () => {
    const step = unlinkedFolderNextStep(PUBLISHABLE, {
      agent: true,
      rerun: INIT_RERUN,
      linkStop: { autolink: "list_failed", refused: false, retry: INIT_RERUN },
    });

    expect(step.text).toContain("retry: run `clerk init` again");
    expect(step.text).toContain("`clerk link --app <app_id>`, then run `clerk init` again");
    expect(step.examples.map((example) => example.command)).toEqual([
      "clerk init",
      "clerk link --app <app_id>",
      "clerk init",
    ]);
  });

  test("a retry whose command can't be echoed: the clause, and only the fallback as an example", () => {
    const migrate: Rerun = { clause: "run the same `clerk migrate import` command again" };
    const step = unlinkedFolderNextStep(PUBLISHABLE, {
      agent: true,
      rerun: migrate,
      linkStop: { autolink: "list_failed", refused: false, retry: migrate },
    });

    expect(step.text).toContain("retry: run the same `clerk migrate import` command again");
    expect(step.examples.map((example) => example.command)).toEqual(["clerk link --app <app_id>"]);
  });

  test("`clerk init` through `link`, no match: ends with `clerk init`, never a bare `clerk link`", () => {
    const step = unlinkedFolderNextStep(PUBLISHABLE, {
      agent: true,
      rerun: INIT_RERUN,
      linkStop: { autolink: "no_match" },
    });
    const named = step.examples.map((example) => example.command);

    expect(named.at(-1)).toBe("clerk init");
    expect(named).not.toContain("clerk link");
  });

  // A signed-in agent's `link` claims the token first. One still on disk is
  // spent (its file couldn't be deleted), so `clerk link` would stop again.
  test.each(LINK_STOPS.filter(({ linkStop }) => linkStop.autolink !== "list_failed"))(
    "an init token, signed in, $stop: lists and links by ID",
    ({ linkStop }) => {
      expect(
        commands({ kind: "init_app", credential: "session" }, { agent: true, linkStop }),
      ).toEqual(["clerk apps list --json", "clerk link --app <app_id>"]);
    },
  );

  test.each(LINK_STOPS)(
    "an init token, signed out, $stop: `clerk auth login`, which claims",
    ({ linkStop }) => {
      expect(commands({ kind: "init_app", credential: "none" }, { agent: true, linkStop })).toEqual(
        ["clerk auth login"],
      );
    },
  );
});
