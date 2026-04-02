import { createServer } from "node:net";
import type { Subprocess } from "bun";
import { log } from "./logger.ts";

/** Find an available port by binding to port 0 and reading the assigned port. */
export async function getAvailablePort(): Promise<number> {
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
  const isNextjs = devCmd[0] === "next";
  const portFlag = isNextjs ? "-p" : "--port";
  return [...devCmd, portFlag, String(port)];
}

/** Start a dev server and wait for it to respond. Returns the subprocess. */
export async function startDevServer(opts: {
  devCmd: string[];
  port: number;
  projectDir: string;
  fixtureName: string;
}): Promise<{ proc: Subprocess; stdout: string[]; stderr: string[] }> {
  const { devCmd, port, projectDir, fixtureName } = opts;
  const fullCmd = buildDevCommand(devCmd, port);
  const stderrLines: string[] = [];

  log(fixtureName, `starting dev server: bunx ${fullCmd.join(" ")} on port ${port}`);

  const proc = Bun.spawn(["bunx", ...fullCmd], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "development" },
  });

  // Collect stderr for diagnostics
  const reader = proc.stderr.getReader();
  const readStderr = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrLines.push(new TextDecoder().decode(value));
      }
    } catch {
      // Process exited, stop reading
    }
  };
  readStderr();

  // Collect stdout for diagnostics
  const stdoutLines: string[] = [];
  const stdoutReader = proc.stdout.getReader();
  const readStdout = async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutLines.push(new TextDecoder().decode(value));
      }
    } catch {
      // Process exited, stop reading
    }
  };
  readStdout();

  // Poll until the server responds with 200 or a redirect
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}`, {
        signal: AbortSignal.timeout(1000),
        redirect: "manual",
      });
      if (res.status < 500) {
        log(fixtureName, `dev server ready (status ${res.status})`);
        return { proc, stdout: stdoutLines, stderr: stderrLines };
      }
      await Bun.sleep(500);
    } catch {
      await Bun.sleep(500);
    }
  }

  // Timeout - kill and throw
  proc.kill("SIGKILL");
  throw new Error(
    `Dev server did not respond within 60s on port ${port}.\n` +
      `stdout:\n${stdoutLines.join("")}\n` +
      `stderr:\n${stderrLines.join("")}`,
  );
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
