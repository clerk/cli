import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createIOSFixture } from "./test-helpers.ts";

setDefaultTimeout(30_000);

const cliEntry = resolve(import.meta.dir, "../../../cli.ts");
const repositoryRoot = resolve(import.meta.dir, "../../../../../..");

function isolatedCLIEnvironment(configDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...Bun.env };
  for (const key of Object.keys(env)) {
    if (key.includes("CLERK")) delete env[key];
  }
  delete env.CI;
  delete env.DO_NOT_TRACK;
  delete env.NO_UPDATE_NOTIFIER;
  return {
    ...env,
    NO_COLOR: "1",
    CLERK_CONFIG_DIR: configDir,
    CLERK_TELEMETRY_DISABLED: "1",
  };
}

async function run(
  command: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
) {
  const child = Bun.spawn(command, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("the compiled CLI semantically parses iOS XML plists", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "clerk-ios-compiled-cli-"));
  try {
    const binary = join(temporaryRoot, "clerk");
    const fixtureRoot = join(temporaryRoot, "fixture");
    const configDir = join(temporaryRoot, "config");
    await mkdir(configDir);
    await createIOSFixture(fixtureRoot, {
      complete: true,
      includeKey: false,
      localSecrets: true,
    });
    await Bun.write(
      join(fixtureRoot, "MyApp", "LocalSecrets.plist"),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>replace-me</string></dict></plist>',
    );
    await Bun.write(
      join(configDir, "config.json"),
      `${JSON.stringify({
        profiles: {},
        telemetryNoticeShown: true,
        machineUuid: "00000000-0000-4000-8000-000000000000",
      })}\n`,
    );

    const compiled = await run(
      [
        process.execPath,
        "build",
        "--compile",
        "--minify",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        cliEntry,
        "--outfile",
        binary,
      ],
      { cwd: repositoryRoot },
    );
    expect(compiled.exitCode, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);

    const result = await run(
      [binary, "--mode", "human", "init", "--dry-run", "--json", "--sign-in-with-apple"],
      { cwd: fixtureRoot, env: isolatedCLIEnvironment(configDir) },
    );
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");

    const output = JSON.parse(result.stdout) as {
      inspection: {
        appTargets: Array<{
          configurations: Array<{
            entitlements?: {
              associatedDomains: string[];
              literalAppIdentifierPrefix?: string;
            };
          }>;
        }>;
        diagnostics: Array<{ code: string }>;
      };
      plan: {
        steps: Array<{ id: string; status: string; automatable: boolean }>;
      };
    };
    const configurations = output.inspection.appTargets[0]?.configurations ?? [];
    expect(configurations).toHaveLength(2);
    expect(configurations.map((configuration) => configuration.entitlements)).toEqual([
      expect.objectContaining({
        associatedDomains: ["webcredentials:clerk.example.test"],
        literalAppIdentifierPrefix: "LEGACY1234",
      }),
      expect.objectContaining({
        associatedDomains: ["webcredentials:clerk.example.test"],
        literalAppIdentifierPrefix: "LEGACY1234",
      }),
    ]);
    expect(output.inspection.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "xcode.unreadable-entitlements",
    );
    expect(output.plan.steps).toContainEqual(
      expect.objectContaining({
        id: "configure-publishable-key",
        status: "required",
        automatable: true,
      }),
    );
    expect(output.plan.steps).toContainEqual(
      expect.objectContaining({
        id: "enable-native-apple",
        status: "required",
        automatable: true,
      }),
    );
    expect(result.stdout).not.toContain("unreadable-entitlements");
    expect(result.stdout).not.toContain("unreadable-local-secrets");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
