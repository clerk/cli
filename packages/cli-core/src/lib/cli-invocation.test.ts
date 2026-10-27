import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPrefixFor, lookupCliPrefix, shellQuote, type LaunchFacts } from "./cli-invocation.ts";

// Facts as the running process would report them. `links` stands in for the
// filesystem: each key resolves to its value, and any other path to itself.
function facts(
  overrides: Partial<Omit<LaunchFacts, "realpath">>,
  links: Record<string, string> = {},
): LaunchFacts {
  return {
    execPath: "/opt/homebrew/Cellar/clerk/4.0.0/bin/clerk",
    script: undefined,
    platform: "darwin",
    clerkOnPath: null,
    realpath: (path) => links[path] ?? path,
    ...overrides,
  };
}

const NPX_BINARY = "/Users/dev/.npm/_npx/1a2b/node_modules/@clerk/cli-darwin-arm64/bin/clerk";
const BUN = "/Users/dev/.bun/bin/bun";
const SCRIPT = "/Users/dev/cli/packages/cli-core/src/cli.ts";

describe("cliPrefixFor", () => {
  test.each([
    {
      launch: "Homebrew install, its clerk on PATH",
      facts: facts(
        { clerkOnPath: "/opt/homebrew/bin/clerk" },
        { "/opt/homebrew/bin/clerk": "/opt/homebrew/Cellar/clerk/4.0.0/bin/clerk" },
      ),
      prefix: "clerk",
    },
    {
      launch: "npx, with an older global clerk on PATH",
      facts: facts(
        { execPath: NPX_BINARY, clerkOnPath: "/usr/local/bin/clerk" },
        { "/usr/local/bin/clerk": "/usr/local/lib/node_modules/clerk/bin/clerk" },
      ),
      prefix: `'${NPX_BINARY}'`,
    },
    {
      launch: "npx, with no clerk on PATH",
      facts: facts({ execPath: NPX_BINARY }),
      prefix: `'${NPX_BINARY}'`,
    },
    {
      // The npm shim on PATH is a different file from the binary it starts.
      launch: "npm global install, reached through its shim",
      facts: facts(
        {
          execPath:
            "/usr/local/lib/node_modules/clerk/node_modules/@clerk/cli-darwin-arm64/bin/clerk",
          clerkOnPath: "/usr/local/bin/clerk",
        },
        { "/usr/local/bin/clerk": "/usr/local/lib/node_modules/clerk/bin/clerk" },
      ),
      prefix: "'/usr/local/lib/node_modules/clerk/node_modules/@clerk/cli-darwin-arm64/bin/clerk'",
    },
    {
      launch: "dev checkout run with bun, no clerk on PATH",
      facts: facts({ execPath: BUN, script: SCRIPT }),
      prefix: `'${BUN}' '${SCRIPT}'`,
    },
    {
      launch: "dev checkout linked with bun link",
      facts: facts(
        { execPath: BUN, script: SCRIPT, clerkOnPath: "/Users/dev/.bun/bin/clerk" },
        { "/Users/dev/.bun/bin/clerk": SCRIPT },
      ),
      prefix: "clerk",
    },
    {
      launch: "dev checkout run with bun, another install's clerk on PATH",
      facts: facts(
        { execPath: BUN, script: SCRIPT, clerkOnPath: "/opt/homebrew/bin/clerk" },
        { "/opt/homebrew/bin/clerk": "/opt/homebrew/Cellar/clerk/4.0.0/bin/clerk" },
      ),
      prefix: `'${BUN}' '${SCRIPT}'`,
    },
    {
      launch: "binary reached through a symlink, its clerk on PATH",
      facts: facts(
        { execPath: "/usr/local/bin/clerk", clerkOnPath: "/usr/local/bin/clerk" },
        { "/usr/local/bin/clerk": "/opt/clerk/4.0.0/clerk" },
      ),
      prefix: "clerk",
    },
  ])("$launch: $prefix", ({ facts, prefix }) => {
    expect(cliPrefixFor(facts)).toBe(prefix);
  });

  // No single quoting works in both PowerShell and cmd.exe, and the commands
  // copied as given are written for bash and zsh.
  test("keeps clerk on Windows", () => {
    expect(
      cliPrefixFor(
        facts({ execPath: "C:\\Users\\dev\\AppData\\npm\\clerk.exe", platform: "win32" }),
      ),
    ).toBe("clerk");
  });

  test("quotes a path holding spaces and single quotes", () => {
    expect(cliPrefixFor(facts({ execPath: "/Users/o'brien/clerk tools/clerk" }))).toBe(
      "'/Users/o'\\''brien/clerk tools/clerk'",
    );
  });
});

// The quoted word must come back unchanged from the shells agents use.
describe.each(["bash", "zsh"])("shellQuote in %s", (shell) => {
  const installed = Bun.which(shell) !== null || Boolean(process.env.CI);

  test
    .skipIf(!installed)
    .each([
      "/plain/path/clerk",
      "/Users/dev/clerk tools/clerk",
      "/Users/o'brien/clerk",
      "/tmp/$HOME/`date`/*/clerk",
    ])("keeps %p intact", async (word) => {
    const args = shell === "zsh" ? ["zsh", "-f", "-c"] : ["bash", "-c"];
    const proc = Bun.spawn([...args, `printf '%s' ${shellQuote(word)}`], {
      env: { PATH: "/usr/bin:/bin" },
      stdout: "pipe",
    });

    expect(await new Response(proc.stdout).text()).toBe(word);
    expect(await proc.exited).toBe(0);
  });
});

// The real PATH lookup, not injected facts. `bun run` puts the checkout's
// `node_modules/.bin` first on the CLI's PATH, but not on the agent's shell's.
describe("lookupCliPrefix", () => {
  async function checkoutWithLink(binDir: string) {
    const dir = await mkdtemp(join(tmpdir(), "clerk-lookup-"));
    const script = join(dir, "cli.ts");
    // Executable, like the checkout's `src/cli.ts`: PATH lookup skips other files.
    await Bun.write(script, "");
    await chmod(script, 0o755);
    await mkdir(join(dir, binDir), { recursive: true });
    await symlink(script, join(dir, binDir, "clerk"));
    return { dir, script };
  }

  test("ignores a node_modules/.bin clerk that links to the running script", async () => {
    const { dir, script } = await checkoutWithLink(join("node_modules", ".bin"));
    try {
      const prefix = lookupCliPrefix({
        PATH: `${join(dir, "node_modules", ".bin")}:/usr/bin:/bin`,
        execPath: process.execPath,
        script,
      });

      expect(prefix).toBe(`${shellQuote(process.execPath)} ${shellQuote(script)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses clerk when another PATH folder links to the running script", async () => {
    const { dir, script } = await checkoutWithLink("bin");
    try {
      expect(
        lookupCliPrefix({
          PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
          execPath: process.execPath,
          script,
        }),
      ).toBe("clerk");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
