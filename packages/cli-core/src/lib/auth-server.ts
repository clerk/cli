/**
 * Localhost callback server for the OAuth authorization code flow.
 * Starts a temporary HTTP server on 127.0.0.1 to receive the auth code redirect.
 */

import { AUTH_TIMEOUT_MS, CALLBACK_PATH } from "./constants.ts";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CLERK_LOGO = `<svg width="48" height="48" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="160" height="160" rx="80" fill="#6C47FF"/>
<path d="M111.125 33.4395C112.875 34.6113 113.024 37.0763 111.535 38.5652L98.7464 51.3541C97.5905 52.5099 95.7974 52.6925 94.3426 51.9472C90.0408 49.7434 85.1656 48.5 80 48.5C62.603 48.5 48.5 62.603 48.5 80C48.5 85.1656 49.7434 90.0408 51.9472 94.3426C52.6925 95.7974 52.5099 97.5905 51.3541 98.7464L38.5652 111.535C37.0763 113.024 34.6113 112.875 33.4395 111.125C27.4773 102.224 24 91.5181 24 80C24 49.0721 49.0721 24 80 24C91.5181 24 102.224 27.4773 111.125 33.4395Z" fill="white" fill-opacity="0.4"/>
<path d="M97.5 80C97.5 89.665 89.665 97.5 80 97.5C70.335 97.5 62.5 89.665 62.5 80C62.5 70.335 70.335 62.5 80 62.5C89.665 62.5 97.5 70.335 97.5 80Z" fill="white"/>
<path d="M111.535 121.435C113.024 122.924 112.875 125.389 111.125 126.56C102.224 132.523 91.5181 136 80 136C68.4819 136 57.7759 132.523 48.8747 126.56C47.1253 125.389 46.9758 122.924 48.4647 121.435L61.2535 108.646C62.4094 107.49 64.2025 107.307 65.6573 108.053C69.9592 110.257 74.8344 111.5 80 111.5C85.1656 111.5 90.0408 110.257 94.3427 108.053C95.7975 107.307 97.5906 107.49 98.7465 108.646L111.535 121.435Z" fill="white"/>
</svg>
`;

const PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #fff; color: #000; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #fff; } }
  @keyframes roll-in { from { transform: rotateX(90deg); opacity: 0; } to { transform: rotateX(0deg); opacity: 1; } }
  @keyframes fade-in { from { opacity: 0; filter: blur(2px); } to { opacity: 1; filter: blur(0px); } }
`;

function animatedText(text: string): string {
  return (
    text
      .split("")
      .map((letter, i) => {
        const delay = (i * 0.015).toFixed(3);
        const char = letter === " " ? "&nbsp;" : escapeHtml(letter);
        return `<span style="display:inline-block;perspective:800px;">\
<span style="display:inline-block;backface-visibility:hidden;transform-origin:50% 100%;\
animation:roll-in 0.15s ease-out ${delay}s both;">${char}</span></span>`;
      })
      .join("") +
    `<span style="clip-path:inset(50%);white-space:nowrap;border-width:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden;">${escapeHtml(text)}</span>`
  );
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>Clerk CLI</title><style>${PAGE_STYLE}</style></head>
<body>
  <div style="text-align: center;">
    ${CLERK_LOGO}
    <h1>${animatedText("Authentication successful")}</h1>
    <p style="color: #9394a1; opacity:0;animation:fade-in 0.4s ease-out 0.5s forwards;">You can close this window and return to your terminal.</p>
  </div>
</body>
</html>`;

const ERROR_HTML = (message: string) => `<!DOCTYPE html>
<html>
<head><title>Clerk CLI</title><style>${PAGE_STYLE}</style></head>
<body>
  <div style="text-align: center;">
    ${CLERK_LOGO}
    <h1>Authentication failed</h1>
    <p>${escapeHtml(message)}</p>
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
  }, AUTH_TIMEOUT_MS);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      [CALLBACK_PATH]: {
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
    port: server.port!,
    waitForCallback: () => callbackPromise,
    stop: () => {
      clearTimeout(timeout);
      server.stop();
    },
  };
}
