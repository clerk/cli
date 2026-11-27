import { spawn, spawnSync } from "node:child_process";

/**
 * Runs a child process without blocking the event loop.
 *
 * spawnSync froze the parent for the whole of a 10K seed/export/import. Sockets
 * the parent had pooled (Turso, Clerk, Auth0) were closed by the server
 * meanwhile, the frozen loop never noticed, and the next request reused a dead
 * socket: "fetch failed", cause "other side closed".
 *
 * stdin is closed: nothing here feeds a child input, and `codex exec` waits for
 * stdin to end before it starts.
 *
 * @param opts.timeoutMs - Kill the child (SIGTERM) after this long; `code` is then 124.
 *   Its own children go too, and the result comes back once it exits rather
 *   than when its pipes close: a grandchild still holding stdout would
 *   otherwise keep the call waiting.
 */
export function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  opts: { cwd?: string; timeoutMs?: number } = {},
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) spawnSync("pkill", ["-TERM", "-P", String(child.pid)]);
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", finish);
    child.on("exit", (code) => {
      if (timedOut) finish(code);
    });
  });
}
