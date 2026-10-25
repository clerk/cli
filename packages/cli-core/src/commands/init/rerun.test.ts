import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../../cli-program.ts";
import { unlinkedFolderNextStep } from "../../lib/unlinked-folder.ts";
import { NOT_RERUN, RERUN_FLAGS } from "./flags.ts";
import { initRerun } from "./rerun.ts";

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, writable: true });
}
afterEach(() => setPlatform(originalPlatform));

describe("initRerun", () => {
  test("bare `clerk init` when it ran with no flags", () => {
    expect(initRerun({})).toEqual({ clause: "run `clerk init` again", command: "clerk init" });
  });

  // Agent mode installs the skills without asking, so a rerun without
  // `--no-skills` would install what the agent declined.
  test("repeats the flags the run had, `--no-skills` included", () => {
    expect(
      initRerun({ framework: "next", pm: "bun", login: true, yes: true, skills: false }).command,
    ).toBe("clerk init --framework next --pm bun --login --yes --no-skills");
  });

  const IOS = {
    json: true,
    xcodeProject: "My App.xcodeproj",
    xcodeTarget: "MyApp",
    appleSdk: "ui" as const,
    bundleId: "com.example.app",
    signInWithApple: true,
  };

  // `quoteArg`'s two forms: single quotes pass the value through untouched on
  // POSIX shells; Windows gets the double quotes cmd.exe and PowerShell honor.
  test.each([
    { platform: "darwin" as const, quoted: "'My App.xcodeproj'" },
    { platform: "linux" as const, quoted: "'My App.xcodeproj'" },
    { platform: "win32" as const, quoted: '"My App.xcodeproj"' },
  ])(
    "repeats the iOS flags, quoting values the shell would split ($platform)",
    ({ platform, quoted }) => {
      setPlatform(platform);

      expect(initRerun(IOS).command).toBe(
        `clerk init --json --xcode-project ${quoted} --xcode-target MyApp --apple-sdk ui --bundle-id com.example.app --sign-in-with-apple`,
      );
    },
  );

  // The new project already holds its Bundle ID; passing it again would mask
  // what Xcode reports.
  test("inside a project `--starter` just created, leaves out `--bundle-id`", () => {
    expect(initRerun(IOS, { from: "/work", projectDir: "/work/MyApp" }).command).toBe(
      "clerk init --json --xcode-project 'My App.xcodeproj' --xcode-target MyApp --apple-sdk ui --sign-in-with-apple",
    );
  });

  test("leaves out flags that never reach the stop, or would scaffold again", () => {
    expect(
      initRerun({
        app: "app_123",
        accountless: true,
        keyless: true,
        template: "b2b-saas",
        fresh: true,
        dryRun: true,
        starter: true,
        name: "my-app",
      }).command,
    ).toBe("clerk init");
  });

  // A starter's project is a new folder below the one `init` ran in: the
  // commands must run there.
  test("names the project's folder when it isn't where `init` ran", () => {
    expect(initRerun({ yes: true }, { from: "/work", projectDir: "/work/my-app" })).toEqual({
      clause: "run `clerk init --yes` again in `my-app`",
      command: "clerk init --yes",
      folder: { name: "my-app", path: "/work/my-app" },
    });
  });

  test("names no folder when the project is where `init` ran", () => {
    expect(initRerun({ yes: true }, { from: "/work", projectDir: "/work" })).toEqual({
      clause: "run `clerk init --yes` again",
      command: "clerk init --yes",
    });
  });

  test("the clause names the whole command", () => {
    expect(initRerun({ yes: true, skills: false }).clause).toBe(
      "run `clerk init --yes --no-skills` again",
    );
  });
});

// A flag added to `clerk init` and left off both lists would vanish from the
// rerun without a word, as `--no-skills` once did: this fails until someone
// decides which list it belongs on.
describe("every flag `clerk init` registers", () => {
  const init = createProgram().commands.find((command) => command.name() === "init");
  const registered = (init?.options ?? []).map((option) => option.long ?? option.flags);
  const repeated = RERUN_FLAGS.map(([, flag]) => flag as string);
  const leftOut = Object.keys(NOT_RERUN);

  test("is repeated by the rerun or named as left out", () => {
    expect(registered.length).toBeGreaterThan(0);
    expect(
      registered.filter((flag) => !repeated.includes(flag) && !leftOut.includes(flag)),
    ).toEqual([]);
  });

  test("is on only one of the two lists", () => {
    expect(repeated.filter((flag) => leftOut.includes(flag))).toEqual([]);
  });
});

// An agent's shell may keep its working folder between commands, or start
// fresh for each. Run every advised command in one shell, as the first kind
// does: each must still run in the project's folder, not a folder inside it.
describe("advice for a project `clerk init` just created, run in one shell", () => {
  test.skipIf(process.platform === "win32")(
    "every command runs in the project's folder",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "clerk-rerun-shell-"));
      try {
        const project = join(parent, "my site");
        const bin = join(parent, "bin");
        await mkdir(project);
        await mkdir(bin);
        // A stand-in `clerk` that prints the folder it ran in.
        await Bun.write(join(bin, "clerk"), "#!/bin/sh\npwd -P\n");
        await chmod(join(bin, "clerk"), 0o755);

        const rerun = initRerun({ yes: true }, { from: parent, projectDir: project });
        const { examples } = unlinkedFolderNextStep(
          { kind: "no_app", credential: "session" },
          { agent: true, rerun, linkStop: { autolink: "list_failed", retry: rerun } },
        );
        const script = examples
          .map((example) => example.command.replace("<app_id>", "app_123"))
          .join("\n");
        const run = Bun.spawnSync(["sh", "-c", script], {
          cwd: parent,
          env: { PATH: `${bin}:/usr/bin:/bin` },
        });

        // macOS's temporary folder is a symlink; `pwd -P` prints the real path.
        const projectPath = await realpath(project);
        expect(examples.length).toBeGreaterThan(1);
        expect(run.stdout.toString().trim().split("\n")).toEqual(examples.map(() => projectPath));
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});
