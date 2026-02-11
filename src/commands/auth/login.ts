const MOCK_APP_URL = "http://localhost:5174";

export async function login(): Promise<{ isNewUser: boolean }> {
  console.log("[debug] Starting clerk auth login...");

  const { port, result } = await startCallbackServer();
  const url = `${MOCK_APP_URL}?callback_port=${port}`;

  console.log(`[debug] Opening browser: ${url}`);
  const proc = Bun.spawn(["open", url]);
  await proc.exited;

  console.log("[debug] Waiting for authentication callback...");
  const data = await result;

  console.log(
    `[debug] Auth complete. User ${data.isNewUser ? "signed up" : "signed in"}.`,
  );

  return data;
}

function startCallbackServer(): Promise<{
  port: number;
  result: Promise<{ isNewUser: boolean }>;
}> {
  return new Promise((resolveSetup) => {
    let resolveResult: (data: { isNewUser: boolean }) => void;
    const result = new Promise<{ isNewUser: boolean }>((r) => {
      resolveResult = r;
    });

    const server = Bun.serve({
      port: 0,
      routes: {
        "/callback": {
          POST: async (req) => {
            const data = (await req.json()) as { isNewUser: boolean };
            resolveResult(data);
            setTimeout(() => server.stop(), 100);
            return new Response("ok", {
              headers: { "Access-Control-Allow-Origin": "*" },
            });
          },
          OPTIONS: () =>
            new Response(null, {
              headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST",
                "Access-Control-Allow-Headers": "Content-Type",
              },
            }),
        },
      },
    });

    resolveSetup({ port: server.port, result });
  });
}
