/**
 * HTTP mocking for integration tests.
 *
 * Provides route-based fetch mocking, custom fetch stubbing, and request
 * logging under a single `http` namespace. All internal state (route tracking,
 * matched routes) is fully encapsulated — consumers interact only through the
 * exported `http` object.
 */

let currentRoutePatterns: string[] = [];
const matchedRoutes = new Set<string>();

/**
 * Assert that every route from the current (or just-replaced) fetch mock was
 * matched at least once. Resets tracking state after assertion.
 *
 * Empty route sets (from `http.mock()` with no args) are exempt since
 * they act as "no fetches allowed" guards, not route expectations.
 */
function assertRoutesConsumed() {
  if (currentRoutePatterns.length === 0) return;

  const unmatched = currentRoutePatterns.filter((p) => !matchedRoutes.has(p));
  currentRoutePatterns = [];
  matchedRoutes.clear();

  if (unmatched.length > 0) {
    throw new Error(
      `${unmatched.length} fetch route(s) were registered but never matched: ` +
        `${unmatched.map((p) => `"${p}"`).join(", ")}. ` +
        `Remove unused routes or verify the command makes the expected requests.`,
    );
  }
}

function installFetch(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  globalThis.fetch = impl as typeof fetch;
}

function recordRequest(input: string | URL | Request, init?: RequestInit) {
  const url = input.toString();
  const method = init?.method ?? "GET";
  const body = (init?.body as string) ?? null;
  http.requests.push({ method, url, body });
  return { url, method, body };
}

/**
 * Unified HTTP mocking namespace. Co-locates request logging, route-based
 * mocking, and custom fetch stubbing under a single API.
 *
 * - **`http.requests`** — logged requests from the current mock phase.
 * - **`http.mock(routes)`** — install a route-matching fetch mock.
 * - **`http.stub(fn)`** — install a custom fetch with auto-logging.
 * - **`http.reset()`** — clear state and install a guard mock (for `beforeEach`).
 * - **`http.assertRoutesConsumed()`** — assert all routes were hit (for `afterEach`).
 */
export const http = {
  requests: [] as Array<{ method: string; url: string; body: string | null }>,

  /**
   * Install a mock `fetch` implementation that matches URLs against a route map.
   * Clears {@link http.requests} before installing.
   *
   * Routes are matched by substring — if the request URL contains the route key,
   * the corresponding value is returned as a JSON response with status 200.
   * Unmatched requests throw an error to catch missing route mocks.
   *
   * When called with no arguments (or an empty map), every fetch call throws —
   * this is the default installed by {@link http.reset} to catch unmocked calls.
   */
  mock(routes: Record<string, unknown> = {}) {
    assertRoutesConsumed();
    http.requests.length = 0;
    matchedRoutes.clear();
    currentRoutePatterns = Object.keys(routes);
    const sortedRoutes = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
    installFetch(async (input, init) => {
      const { url, method } = recordRequest(input, init);

      for (const [pattern, response] of sortedRoutes) {
        if (url.includes(pattern)) {
          matchedRoutes.add(pattern);
          return new Response(JSON.stringify(response), { status: 200 });
        }
      }
      throw new Error(
        `Unmocked fetch route: ${method} ${url}. ` + `Add a matching route pattern to http.mock().`,
      );
    });
  },

  /**
   * Install a custom fetch implementation with automatic request logging.
   * Clears {@link http.requests} and route tracking state before installing.
   *
   * The callback receives the resolved URL string and the original `RequestInit`.
   */
  stub(fn: (url: string, init?: RequestInit) => Promise<Response>) {
    assertRoutesConsumed();
    http.requests.length = 0;
    matchedRoutes.clear();
    currentRoutePatterns = [];
    installFetch(async (input, init) => {
      const { url } = recordRequest(input, init);
      return fn(url, init);
    });
  },

  /**
   * Reset HTTP mocking state and install a guard mock that throws on any
   * unmocked fetch call. Intended for `beforeEach` / `setupTest`.
   */
  reset() {
    http.requests.length = 0;
    currentRoutePatterns = [];
    matchedRoutes.clear();
    http.mock();
  },

  /**
   * Assert that all registered routes from the current mock phase were consumed.
   * Intended for `afterEach` / `teardownTest`.
   */
  assertRoutesConsumed,
};
