import express from "express";

const app = express();

app.get("/", (_req, res) => {
  res.json({ ok: true });
});

// The e2e dev-server helper appends `--port <n> --host <addr>` to the command.
function argValue(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  const value = idx === -1 ? undefined : process.argv[idx + 1];
  return value ?? fallback;
}

const port = Number(argValue("--port", "3000"));
const host = argValue("--host", "127.0.0.1");

app.listen(port, host, () => {
  console.log(`listening on http://${host}:${port}`);
});
