/**
 * Localhost callback server for the OAuth authorization code flow.
 * Starts a temporary HTTP server on 127.0.0.1 to receive the auth code redirect.
 */

const TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>Clerk CLI</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
  <div style="text-align: center;">
    <h1>Authentication successful</h1>
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>`;

const ERROR_HTML = (message: string) => `<!DOCTYPE html>
<html>
<head><title>Clerk CLI</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
  <div style="text-align: center;">
    <h1>Authentication failed</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;

interface AuthServerResult {
  port: number;
  waitForCallback: () => Promise<{ code: string }>;
  stop: () => void;
}

export function startAuthServer(expectedState: string): AuthServerResult {
  let resolveCallback: (value: { code: string }) => void;
  let rejectCallback: (reason: Error) => void;

  const callbackPromise = new Promise<{ code: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const timeout = setTimeout(() => {
    rejectCallback(new Error("Authentication timed out. Please try again."));
    server.stop();
  }, TIMEOUT_MS);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/callback": {
        GET: (req) => {
          const url = new URL(req.url);
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error) {
            const description = url.searchParams.get("error_description") || error;
            rejectCallback(new Error(`OAuth error: ${description}`));
            clearTimeout(timeout);
            setTimeout(() => server.stop(), 100);
            return new Response(ERROR_HTML(description), {
              headers: { "Content-Type": "text/html" },
            });
          }

          if (state !== expectedState) {
            rejectCallback(new Error("Invalid state parameter. Possible CSRF attack."));
            clearTimeout(timeout);
            setTimeout(() => server.stop(), 100);
            return new Response(ERROR_HTML("Invalid state parameter."), {
              status: 400,
              headers: { "Content-Type": "text/html" },
            });
          }

          if (!code) {
            rejectCallback(new Error("No authorization code received."));
            clearTimeout(timeout);
            setTimeout(() => server.stop(), 100);
            return new Response(ERROR_HTML("No authorization code received."), {
              status: 400,
              headers: { "Content-Type": "text/html" },
            });
          }

          resolveCallback({ code });
          clearTimeout(timeout);
          setTimeout(() => server.stop(), 100);
          return new Response(SUCCESS_HTML, {
            headers: { "Content-Type": "text/html" },
          });
        },
      },
    },
    fetch() {
      return new Response("Clerk CLI is waiting for authentication...", {
        headers: { "Content-Type": "text/plain" },
      });
    },
  });

  return {
    port: server.port,
    waitForCallback: () => callbackPromise,
    stop: () => {
      clearTimeout(timeout);
      server.stop();
    },
  };
}
