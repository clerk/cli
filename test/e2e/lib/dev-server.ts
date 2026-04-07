import { createServer } from "node:net";
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

/**
 * Host the dev server should bind to. We pin to IPv4 loopback instead of
 * `localhost` because some environments (e.g. the Playwright Docker image)
 * resolve `localhost` to `::1` first, which leaves the dev server listening
 * only on IPv6 while Bun's `fetch` and some tooling try IPv4 first.
 */
export const DEV_SERVER_HOST = "127.0.0.1";

/** Build the full dev server command with host and port flags appended. */
export function buildDevCommand(devCmd: string[], port: number): string[] {
  const isNextjs = devCmd[0] === "next";
  const portFlag = isNextjs ? "-p" : "--port";
  const hostFlag = isNextjs ? "-H" : "--host";
  return [...devCmd, hostFlag, DEV_SERVER_HOST, portFlag, String(port)];
}

interface ReadyServer {
  proc: Subprocess;
  port: number;
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
  fixtureName: string;
}): Promise<StartAttempt> {
  const { devCmd, port, projectDir, fixtureName } = opts;
  const fullCmd = buildDevCommand(devCmd, port);
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];

  log(fixtureName, `starting dev server: bunx ${fullCmd.join(" ")} on port ${port}`);

  const proc = Bun.spawn(["bunx", ...fullCmd], {
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

  const killAndAwait = async () => {
    proc.kill("SIGKILL");
    await proc.exited.catch(() => {});
  };

  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Early-bail: framework reported the port is taken. Don't wait the full timeout.
    if (hasPortConflict()) {
      log(fixtureName, `port ${port} reported in use by dev server`);
      await killAndAwait();
      return { kind: "port_conflict" };
    }

    // Some frameworks exit non-zero on bind failure rather than logging and
    // retrying. Detect that as a port conflict if the output supports it.
    if (proc.exitCode !== null) {
      if (hasPortConflict()) {
        log(fixtureName, `dev server exited (port ${port} in use)`);
        return { kind: "port_conflict" };
      }
      throw new Error(
        `Dev server exited (code ${proc.exitCode}) before becoming ready on port ${port}.\n` +
          `stdout:\n${stdoutLines.join("")}\nstderr:\n${stderrLines.join("")}`,
      );
    }

    try {
      const res = await fetch(`http://${DEV_SERVER_HOST}:${port}`, {
        signal: AbortSignal.timeout(1000),
        redirect: "manual",
      });
      if (res.status < 500) {
        log(fixtureName, `dev server ready (status ${res.status})`);
        return { kind: "ready", value: { proc, port, stdout: stdoutLines, stderr: stderrLines } };
      }
    } catch {
      // Connection refused / timeout while polling — keep waiting.
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
  fixtureName: string;
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
    log(opts.fixtureName, `port ${port} collided, retrying (${attempt + 1}/${MAX_BIND_ATTEMPTS})`);
  }
  throw new Error("unreachable");
}

/** Kill a dev server process, falling back to SIGKILL after 5 seconds. */
export async function killDevServer(proc: Subprocess, fixtureName: string): Promise<void> {
  log(fixtureName, "killing dev server");
  proc.kill("SIGTERM");

  const timeout = setTimeout(() => {
    proc.kill("SIGKILL");
  }, 5_000);

  try {
    await proc.exited;
  } finally {
    clearTimeout(timeout);
  }

  log(fixtureName, "dev server stopped");
}
