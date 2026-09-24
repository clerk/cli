/**
 * Localhost callback server for the OAuth authorization code flow.
 * Starts a temporary HTTP server on 127.0.0.1 to receive the auth code redirect.
 */

import { AUTH_TIMEOUT_MS, CALLBACK_PATH } from "./constants.ts";
import { CliError, ERROR_CODE, errorMessage } from "./errors.ts";
import { observeHostCapabilityFailure } from "./host-execution.ts";
import { log } from "./log.ts";
import { whileAwaitingUser } from "./signals.ts";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CLERK_LOGO = `<span class="clerk-logo-frame"><svg class="clerk-logo" width="48" height="48" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<path d="M111.125 33.4395C112.875 34.6113 113.024 37.0763 111.535 38.5652L98.7464 51.3541C97.5905 52.5099 95.7974 52.6925 94.3426 51.9472C90.0408 49.7434 85.1656 48.5 80 48.5C62.603 48.5 48.5 62.603 48.5 80C48.5 85.1656 49.7434 90.0408 51.9472 94.3426C52.6925 95.7974 52.5099 97.5905 51.3541 98.7464L38.5652 111.535C37.0763 113.024 34.6113 112.875 33.4395 111.125C27.4773 102.224 24 91.5181 24 80C24 49.0721 49.0721 24 80 24C91.5181 24 102.224 27.4773 111.125 33.4395Z" fill="currentColor" fill-opacity="0.4"/>
<path d="M97.5 80C97.5 89.665 89.665 97.5 80 97.5C70.335 97.5 62.5 89.665 62.5 80C62.5 70.335 70.335 62.5 80 62.5C89.665 62.5 97.5 70.335 97.5 80Z" fill="currentColor"/>
<path d="M111.535 121.435C113.024 122.924 112.875 125.389 111.125 126.56C102.224 132.523 91.5181 136 80 136C68.4819 136 57.7759 132.523 48.8747 126.56C47.1253 125.389 46.9758 122.924 48.4647 121.435L61.2535 108.646C62.4094 107.49 64.2025 107.307 65.6573 108.053C69.9592 110.257 74.8344 111.5 80 111.5C85.1656 111.5 90.0408 110.257 94.3427 108.053C95.7975 107.307 97.5906 107.49 98.7465 108.646L111.535 121.435Z" fill="currentColor"/>
</svg></span>
`;

const PAGE_STYLE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    color-scheme: light dark;
    --cli-bg: #fff;
    --cli-fg: #0a0a0a;
    --cli-fg-muted: rgba(10,10,10,0.62);
    --cli-fg-dim: rgba(10,10,10,0.5);
    --cli-fg-faint: rgba(10,10,10,0.42);
    --cli-border: rgba(10,10,10,0.12);
    --cli-tab-bg: linear-gradient(90deg, rgba(10,10,10,0.045) 0%, rgba(10,10,10,0.022) 100%);
    --cli-code-bg: linear-gradient(90deg, rgba(10,10,10,0.028) 0%, rgba(10,10,10,0.014) 100%);
    --cli-hover-bg: rgba(10,10,10,0.06);
    --cli-syntax-mid: #7c3aed;
    --cli-syntax-target: #2563eb;
    --cli-accent: #6c47ff;
    --cli-logo-bg: linear-gradient(180deg, rgba(10,10,10,0) 0%, rgba(10,10,10,0.02) 100%);
    --cli-logo-shadow: 0px 11px 28px -10px #00000026, 0px 4px 14px -10px #0000001a, 0px 1px 2px 0px #0000000a, 0px 0px 0px 0.5px #1313161a, inset 0px -4px 16px 0px #fff, inset 0px -4px 4px 0px #ffffff80, inset 0px 3px 5px 0px #fff, inset 0px 4px 35px -6px #0000000f;
    --cli-focus-outline: #131316;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --cli-bg: #0e0e10;
      --cli-fg: #f5f5f7;
      --cli-fg-muted: rgba(245,245,247,0.6);
      --cli-fg-dim: rgba(245,245,247,0.5);
      --cli-fg-faint: rgba(245,245,247,0.42);
      --cli-border: rgba(245,245,247,0.1);
      --cli-tab-bg: linear-gradient(90deg, rgba(245,245,247,0.05) 0%, rgba(245,245,247,0.025) 100%);
      --cli-code-bg: linear-gradient(90deg, rgba(245,245,247,0.03) 0%, rgba(245,245,247,0.015) 100%);
      --cli-hover-bg: rgba(245,245,247,0.06);
      --cli-syntax-mid: #c4baff;
      --cli-syntax-target: #70b8ff;
      --cli-accent: #9c87ff;
      --cli-logo-bg: linear-gradient(180deg, rgba(245,245,247,0.08) 0%, rgba(245,245,247,0) 100%);
      --cli-logo-shadow: 0px 11px 28px -10px #00000080, 0px 4px 14px -10px #00000059, 0px 1px 2px 0px #00000059, inset 0 0 0 1px rgba(255 255 255 / 0.04), inset 0 1px 0 0 rgba(255 255 255 / 0.04), 0 0 0 1px rgba(0 0 0 / 1);
      --cli-focus-outline: #fff;
    }
  }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; min-height: 100vh; background: var(--cli-bg); color: var(--cli-fg); }
  ::selection { background: var(--cli-fg); color: var(--cli-bg); }
  .auth-page { min-height: 100dvh; text-align: center; padding-block: 3rem 2rem; padding-inline: 1rem; }
  .auth-headline { position: relative; }
  .intro > p { --stagger: 4; color: var(--cli-fg-muted); }
  .intro .clerk-logo-frame { --stagger: 0; }
  .clerk-logo-frame { margin-bottom: 1.25rem; display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: 50%; background: var(--cli-logo-bg); box-shadow: var(--cli-logo-shadow); }
  .clerk-logo { color: var(--cli-fg); }
  .auth-page h1 { font-size: clamp(1.875rem, 4vw, 2.5rem); }
  .auth-headline > p { max-width: 42ch; margin-inline: auto; margin-top: 0.75rem; text-wrap: balance; font-size: 0.875rem; line-height: 1.5rem; }
  @keyframes enter { from { opacity: 0; transform: translateY(0.5rem); } }
  .intro .clerk-logo-frame, .word-in, .intro > p, .cli-card { animation: enter 450ms cubic-bezier(0.25, 0.46, 0.45, 0.94) both; animation-delay: calc(var(--delay, 45ms) * var(--stagger, 0)); }
  .word-in { display: inline-block; }
  .cli-cards { --cli-cards-width: 52rem; margin-top: 4rem; margin-bottom: 1.5rem; }
  .cli-cards-grid { margin-inline: auto; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; width: var(--cli-cards-width); max-width: 100%; }
  @media (min-width: 861px) and (min-height: 700px) { .auth-page { padding-block: 0; } .auth-hero { min-height: 100dvh; display: grid; place-content: center; } .clerk-logo-frame { position: absolute; left: 50%; bottom: 100%; translate: -50% 0; } .cli-cards { position: absolute; top: 100%; left: 50%; translate: -50% 0; width: var(--cli-cards-width); max-width: calc(100vw - 2rem); margin: 4rem 0 0; } body { overflow: clip; } }
  @media (max-width: 860px) { .cli-cards { --cli-cards-width: 100%; margin-top: 2.5rem; } .cli-cards-grid { grid-template-columns: 1fr; } .cli-card-desc { max-width: 36ch; } }
  .cli-card { animation-delay: calc(260ms + var(--index, 0) * 75ms); display: flex; flex-direction: column; gap: 0.5rem; border: 1px solid var(--cli-border); border-radius: 1rem; padding: 1rem; text-align: left; background: var(--cli-bg); }
  .cli-card:nth-child(1) { --index: 0; }
  .cli-card:nth-child(2) { --index: 1; }
  .cli-card:nth-child(3) { --index: 2; }
  .cli-card-head { display: flex; align-items: center; }
  .cli-card-title { margin-top: 0.25rem; font-size: 0.8125rem; line-height: 1.25rem; font-weight: 500; }
  .cli-card-icon { width: 14px; height: 14px; flex: none; color: var(--cli-fg-dim); }
  .cli-card-desc { flex: 1; font-size: 0.8125rem; line-height: 1.25rem; color: var(--cli-fg-muted); }
  .cli-card-code { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.75rem; padding: 0.35rem 0.35rem 0.35rem 0.75rem; border: 1px solid var(--cli-border); border-radius: 8px; background: var(--cli-code-bg); }
  .cli-card-code code { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78125rem; letter-spacing: -0.02em; color: var(--cli-fg); user-select: text; }
  .cli-prompt { color: var(--cli-fg-faint); user-select: none; }
  .cli-bin { color: var(--cli-syntax-mid); }
  .copy-btn { background: transparent; border: 0; width: 1.75rem; height: 1.75rem; cursor: pointer; color: var(--cli-fg-dim); border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; flex: none; transition: color 0.3s cubic-bezier(0.4,0.36,0,1), background 0.15s, transform 0.15s; }
  .copy-btn:hover { color: var(--cli-fg); background: var(--cli-hover-bg); }
  .copy-btn:focus { outline: none; }
  .copy-btn:focus-visible { outline: 2px solid var(--cli-focus-outline); outline-offset: 2px; }
  .copy-btn:active { transform: scale(0.92); }
  .copy-btn .icon-check { display: none; color: #16a34a; }
  .copy-btn.copied .icon-copy { display: none; }
  .copy-btn.copied .icon-check { display: inline; }
  .copy-btn.copied, .copy-btn.copied:hover { color: #16a34a; }
`;

function animatedText(text: string): string {
  // Split on words, not characters: the words stay real text for a screen
  // reader, so the headline needs no duplicate hidden copy.
  return text
    .split(" ")
    .map((word, i) => {
      return `<span class="word-in" style="--stagger:${i + 1};">${escapeHtml(word)}</span>`;
    })
    .join(" ");
}

const TERMINAL_ICON_SVG = `<svg class="cli-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`;

const COPY_ICON_SVG = `<svg class="icon-copy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

const CHECK_ICON_SVG = `<svg class="icon-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

const COPY_SCRIPT = `
  const copyTimers = new WeakMap();
  function copyCmd(btn) {
    const cmd = btn.parentElement.querySelector('.cli-cmd-text').textContent.replace(/\\s+/g, ' ').trim();
    // Each click restarts the window. Without this, an earlier click's timer
    // fires mid-spam and flashes the button back to the copy icon.
    const done = function () {
      clearTimeout(copyTimers.get(btn));
      btn.classList.add('copied');
      copyTimers.set(
        btn,
        setTimeout(function () {
          copyTimers.delete(btn);
          btn.classList.remove('copied');
        }, 1500),
      );
    };
    const fallback = function () {
      const ta = document.createElement('textarea');
      ta.value = cmd; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(cmd).then(done).catch(fallback);
    } else {
      fallback();
    }
  }
`;

function commandCard(title: string, description: string, commandHtml: string): string {
  return `<div class="cli-card">
          <div class="cli-card-head">${TERMINAL_ICON_SVG}</div>
          <h3 class="cli-card-title">${escapeHtml(title)}</h3>
          <p class="cli-card-desc">${escapeHtml(description)}</p>
          <div class="cli-card-code">
            <code><span class="cli-prompt">$ </span><span class="cli-cmd-text">${commandHtml}</span></code>
            <button class="copy-btn" onclick="copyCmd(this)" aria-label="Copy command">${COPY_ICON_SVG}${CHECK_ICON_SVG}</button>
          </div>
        </div>`;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Clerk CLI</title><style>${PAGE_STYLE}</style></head>
<body>
  <div class="auth-page">
    <div class="auth-hero">
      <div class="auth-headline intro">
        ${CLERK_LOGO}
        <h1>${animatedText("Authentication successful")}</h1>
        <p>Setup, configure and ship Clerk straight from your agent or terminal. You may close this window.</p>
        <div class="cli-cards">
          <div class="cli-cards-grid">
        ${commandCard(
          "Install",
          "Detects your framework and sets up API keys automatically.",
          `<span class="cli-bin">npx</span> clerk@latest init`,
        )}
        ${commandCard(
          "Customize",
          "Turn on features like B2B Authentication with one command.",
          `clerk enable orgs`,
        )}
        ${commandCard(
          "Deploy to production",
          "Register your domain, configure DNS, and go live with your app.",
          `clerk deploy`,
        )}
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>${COPY_SCRIPT}</script>
</body>
</html>`;

const ERROR_HTML = (message: string) => `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Clerk CLI</title><style>${PAGE_STYLE}</style></head>
<body>
  <div class="auth-page">
    <div class="auth-hero">
      <div class="auth-headline">
        ${CLERK_LOGO}
        <h1>Authentication failed</h1>
        <p>${escapeHtml(message)}</p>
      </div>
    </div>
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
  let server: ReturnType<typeof Bun.serve> | undefined;

  const callbackPromise = new Promise<{ code: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const timeout = setTimeout(() => {
    log.debug(`auth-server: timed out after ${AUTH_TIMEOUT_MS}ms`);
    rejectCallback(
      new CliError(
        "Authentication timed out. Run `clerk auth login` to try again — if your browser did not open, copy the printed URL into any browser on this machine.",
        { code: ERROR_CODE.AUTH_TIMEOUT },
      ),
    );
    // `stop()` is a promise nothing can wait on: the login flow has already
    // settled by every point we close from, and these are timer and request
    // callbacks with nowhere to return it. Dropped explicitly, here and below.
    void server?.stop();
  }, AUTH_TIMEOUT_MS);

  try {
    server = Bun.serve({
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
              log.debug(`auth-server: OAuth error in callback — ${error}: ${description}`);
              rejectCallback(
                new CliError(`OAuth error: ${description}`, {
                  code: ERROR_CODE.OAUTH_PROVIDER_ERROR,
                }),
              );
              clearTimeout(timeout);
              setTimeout(() => void server?.stop(), 100);
              return new Response(ERROR_HTML(description), {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              });
            }

            if (state !== expectedState) {
              log.debug(`auth-server: state mismatch (expected=${expectedState}, got=${state})`);
              rejectCallback(
                new CliError("Invalid state parameter. Possible CSRF attack.", {
                  code: ERROR_CODE.OAUTH_STATE_MISMATCH,
                }),
              );
              clearTimeout(timeout);
              setTimeout(() => void server?.stop(), 100);
              return new Response(ERROR_HTML("Invalid state parameter."), {
                status: 400,
                headers: { "Content-Type": "text/html; charset=utf-8" },
              });
            }

            if (!code) {
              log.debug("auth-server: callback received with no authorization code");
              rejectCallback(
                new CliError("No authorization code received.", {
                  code: ERROR_CODE.OAUTH_NO_CODE,
                }),
              );
              clearTimeout(timeout);
              setTimeout(() => void server?.stop(), 100);
              return new Response(ERROR_HTML("No authorization code received."), {
                status: 400,
                headers: { "Content-Type": "text/html; charset=utf-8" },
              });
            }

            log.debug("auth-server: callback received with valid code and state");
            resolveCallback({ code });
            clearTimeout(timeout);
            setTimeout(() => void server?.stop(), 100);
            return new Response(SUCCESS_HTML, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
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
  } catch (error) {
    clearTimeout(timeout);
    observeHostCapabilityFailure("localhost-bind", error, {
      operation: "listen",
      target: "127.0.0.1:0",
      label: CALLBACK_PATH,
    });
    // A sandbox or firewall that forbids binding loopback fails every login on
    // the machine; it is a distinct condition from anything the user did.
    log.debug(
      `auth-server: bind failed — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    throw new CliError(
      `Could not start the local sign-in callback server: ${errorMessage(error)}`,
      {
        code: ERROR_CODE.CALLBACK_BIND_FAILED,
      },
    );
  }

  const activeServer = server;
  log.debug(`auth-server: listening on 127.0.0.1:${activeServer.port} for ${CALLBACK_PATH}`);

  return {
    port: activeServer.port!,
    // The CLI is idle here while the user signs in through their browser, so
    // Ctrl-C is them abandoning the login rather than an interrupted operation.
    waitForCallback: async () => whileAwaitingUser(callbackPromise),
    stop: () => {
      clearTimeout(timeout);
      void activeServer.stop();
    },
  };
}
