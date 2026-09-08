import { createServer, Socket } from "node:net";
import type { Subprocess } from "bun";
import { log } from "./logger.ts";

/**
 * Match the assorted ways framework dev servers report a port-in-use error.
 * Next.js: "Port 3000 is in use ... using available port"
 * Vite:    "Port 5173 is in use, trying another one..."
 * Nuxt / generic Node: "EADDRINUSE: address already in use 0.0.0.0:3000"
 */
const PORT_CONFLICT = /EADDRINUSE|address already in use|port \S+ is (already )?in use/i;

const READINESS_TIMEOUT_MS = 60_000;
const MAX_BIND_ATTEMPTS = 3;

function isNextjsDevCommand(devCmd: string[]): boolean {
  return devCmd[0] === "next";
}

function getDevServerHost(devCmd: string[]): string {
  return isNextjsDevCommand(devCmd) ? "localhost" : "127.0.0.1";
}

/** Find an available port by binding to port 0 and reading the assigned port. */
async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to get port"));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** Build the full dev server command with the port flag appended. */
export function buildDevCommand(devCmd: string[], port: number): string[] {
  const isNextjs = isNextjsDevCommand(devCmd);
  const portFlag = isNextjs ? "-p" : "--port";
  const hostFlag = isNextjs ? "-H" : "--host";
  return [...devCmd, portFlag, String(port), hostFlag, getDevServerHost(devCmd)];
}

/**
 * TCP connect probe: resolves true if the given host:port accepts a TCP
 * connection within `timeoutMs`. We use this instead of an HTTP fetch because
 * dev servers (notably Next.js with Clerk middleware) can take longer than a
 * short HTTP timeout to produce the first response while compiling on demand,
 * even though they're already accepting connections. Playwright's page.goto
 * with waitUntil:"load" handles the slow first response.
 */
async function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

interface ReadyServer {
  proc: Subprocess;
  port: number;
  host: string;
  stdout: string[];
  stderr: string[];
}

type StartAttempt = { kind: "ready"; value: ReadyServer } | { kind: "port_conflict" };

/**
 * Single attempt to spawn a dev server on `port` and wait for it to respond.
 *
 * Returns `port_conflict` if either stream surfaces a port-in-use error
 * before the server reports ready. Throws on any other failure (timeout,
 * unexpected early exit).
 */
async function tryStart(opts: {
  devCmd: string[];
  port: number;
  projectDir: string;
}): Promise<StartAttempt> {
  const { devCmd, port, projectDir } = opts;
  const fullCmd = buildDevCommand(devCmd, port);
  const host = getDevServerHost(devCmd);
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];

  log(`starting dev server: npx ${fullCmd.join(" ")} on port ${port}`);

  const proc = Bun.spawn(["npx", ...fullCmd], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "development" },
  });

  // Drain stderr in the background so we can scan it for port-conflict signals
  // and surface it in error messages.
  const stderrReader = proc.stderr.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrLines.push(new TextDecoder().decode(value));
      }
    } catch {
      // Process exited, stop reading
    }
  })();

  // Drain stdout the same way (some frameworks log "Port X in use" to stdout).
  const stdoutReader = proc.stdout.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutLines.push(new TextDecoder().decode(value));
      }
    } catch {
      // Process exited, stop reading
    }
  })();

  const hasPortConflict = () =>
    PORT_CONFLICT.test(stderrLines.join("")) || PORT_CONFLICT.test(stdoutLines.join(""));

  // Reuse the tree kill: a half-started dev server can already have spawned
  // children that would otherwise survive and hold the project's dev lockfile.
  const killAndAwait = async () => {
    await killDevServer(proc).catch(() => {});
  };

  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Early-bail: framework reported the port is taken. Don't wait the full timeout.
    if (hasPortConflict()) {
      log(`port ${port} reported in use by dev server`);
      await killAndAwait();
      return { kind: "port_conflict" };
    }

    // Some frameworks exit non-zero on bind failure rather than logging and
    // retrying. Detect that as a port conflict if the output supports it.
    if (proc.exitCode !== null) {
      if (hasPortConflict()) {
        log(`dev server exited (port ${port} in use)`);
        await killAndAwait();
        return { kind: "port_conflict" };
      }
      // The wrapper exiting doesn't mean the tree is gone — reap it before
      // surfacing the failure so nothing is left holding the dev lockfile.
      await killAndAwait();
      throw new Error(
        `Dev server exited (code ${proc.exitCode}) before becoming ready on port ${port}.\n` +
          `stdout:\n${stdoutLines.join("")}\nstderr:\n${stderrLines.join("")}`,
      );
    }

    if (await canConnect(host, port, 1000)) {
      log(`dev server ready (accepting TCP on ${host}:${port})`);
      return {
        kind: "ready",
        value: { proc, port, host, stdout: stdoutLines, stderr: stderrLines },
      };
    }
    await Bun.sleep(500);
  }

  // Readiness timeout. If output mentions a port conflict, treat as such so the
  // outer loop can retry on a fresh port; otherwise surface a hard failure.
  if (hasPortConflict()) {
    await killAndAwait();
    return { kind: "port_conflict" };
  }
  await killAndAwait();
  throw new Error(
    `Dev server did not respond within ${READINESS_TIMEOUT_MS / 1000}s on port ${port}.\n` +
      `stdout:\n${stdoutLines.join("")}\nstderr:\n${stderrLines.join("")}`,
  );
}

/**
 * Start a dev server on a free port and wait for it to respond.
 *
 * `getAvailablePort` has an unavoidable TOCTOU window: the port is freed
 * before the dev server binds it, so a sibling fixture (or anything else on
 * the host) can race in. We mitigate by retrying with a fresh port whenever
 * `tryStart` reports the chosen port is taken.
 */
export async function startDevServer(opts: {
  devCmd: string[];
  projectDir: string;
}): Promise<ReadyServer> {
  for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt++) {
    const port = await getAvailablePort();
    const result = await tryStart({ ...opts, port });
    if (result.kind === "ready") return result.value;

    if (attempt === MAX_BIND_ATTEMPTS) {
      throw new Error(
        `Dev server could not bind to a free port after ${MAX_BIND_ATTEMPTS} attempts ` +
          `(last attempted port: ${port}).`,
      );
    }
    log(`port ${port} collided, retrying (${attempt + 1}/${MAX_BIND_ATTEMPTS})`);
  }
  throw new Error("unreachable");
}

const GRACEFUL_KILL_MS = 10_000;
const SIGKILL_SETTLE_MS = 5_000;
const KILL_POLL_MS = 250;

interface ProcessEntry {
  ppid: number;
  command: string;
}

type TreeMember = { pid: number } & ProcessEntry;

/** Snapshot the process table as pid -> { ppid, command }. */
async function readProcessTable(): Promise<Map<number, ProcessEntry>> {
  const table = new Map<number, ProcessEntry>();
  const ps = await Bun.$`ps -eo pid=,ppid=,command=`.quiet().nothrow();
  if (ps.exitCode !== 0) return table;

  for (const line of ps.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3]!.trim() });
  }
  return table;
}

/**
 * Snapshot `rootPid` and every transitive descendant, recording each one's
 * command line.
 *
 * This has to happen *before* we signal anything: `npx` execs the real dev
 * server as a child, and once the wrapper exits its children are reparented to
 * init, at which point they're no longer reachable from `proc.pid`.
 *
 * The command line is kept so a later signal can verify the pid still refers to
 * the same process — pids are recycled, and this code sends SIGKILL.
 */
async function collectProcessTree(rootPid: number): Promise<TreeMember[]> {
  const table = await readProcessTable();
  const childrenOf = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) {
    childrenOf.set(ppid, [...(childrenOf.get(ppid) ?? []), pid]);
  }

  const tree: TreeMember[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const entry = table.get(pid);
    if (entry) tree.push({ pid, ...entry });
    queue.push(...(childrenOf.get(pid) ?? []));
  }
  return tree;
}

/**
 * Tree members whose pid is still running the command we snapshotted.
 *
 * The command comparison guards against pid reuse: a recycled pid would
 * otherwise be a SIGKILL target.
 */
async function livingMembers(tree: TreeMember[]): Promise<TreeMember[]> {
  const table = await readProcessTable();
  return tree.filter((member) => table.get(member.pid)?.command === member.command);
}

/** Signal every still-living tree member. Returns the members that were signalled. */
async function signalTree(
  tree: TreeMember[],
  signal: "SIGTERM" | "SIGKILL",
): Promise<TreeMember[]> {
  const alive = await livingMembers(tree);
  for (const { pid } of alive) {
    try {
      process.kill(pid, signal);
    } catch {
      // Exited between the liveness check and the signal.
    }
  }
  return alive;
}

/** Poll until no tree member is alive, or `timeoutMs` elapses. */
async function waitForTreeExit(tree: TreeMember[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await livingMembers(tree)).length === 0) return true;
    await Bun.sleep(KILL_POLL_MS);
  }
  return (await livingMembers(tree)).length === 0;
}

/**
 * Kill a dev server process tree, escalating to SIGKILL after a grace period.
 *
 * Killing only the spawned `npx` wrapper is not enough. npm forwards SIGTERM
 * and then exits, so the wrapper dies while the real dev server is still
 * shutting down — or never terminates at all, if it ignores SIGTERM. The
 * survivor is reparented to init, keeps its port, and keeps its dev lockfile,
 * so the next attempt in the same project dir fails immediately with "Another
 * dev server is already running" (Astro) / "Another next dev server is already
 * running" (Next.js). Under `--retry 1` that turns any first-attempt flake into
 * a guaranteed hard failure.
 *
 * Tree liveness, not `proc.exited`, is the stopping condition: the wrapper's
 * exit says nothing about its descendants, and awaiting it can hang outright
 * when an orphaned descendant holds the inherited stdio pipes open.
 */
export async function killDevServer(proc: Subprocess): Promise<void> {
  log("killing dev server");
  // Snapshot before signalling — once the wrapper exits, its children are
  // reparented to init and can no longer be found from `proc.pid`.
  const tree = await collectProcessTree(proc.pid);
  await signalTree(tree, "SIGTERM");

  if (!(await waitForTreeExit(tree, GRACEFUL_KILL_MS))) {
    const survivors = await signalTree(tree, "SIGKILL");
    if (survivors.length > 0) {
      log(`dev server ignored SIGTERM, sent SIGKILL to ${survivors.map((s) => s.pid).join(", ")}`);
    }
    if (!(await waitForTreeExit(tree, SIGKILL_SETTLE_MS))) {
      log("warning: dev server process tree outlived SIGKILL");
    }
  }

  log("dev server stopped");
}
