# Add Clerk to Express

Install `{{SDK}}`. Add `clerkMiddleware()` to the Express app. Use `requireAuth()` to protect routes. Use `getAuth()` to access auth state in handlers.

Latest docs: {{DOCS_URL}}

## Install

```bash
{{INSTALL_CMD}}
```

## Server setup

```typescript
import express from "express";
import { clerkMiddleware, requireAuth, getAuth } from "@clerk/express";

const app = express();

// Apply Clerk middleware to all routes
app.use(clerkMiddleware());

// Public route — no auth required
app.get("/", (req, res) => {
  res.json({ message: "Public route" });
});

// Protected route — requires authentication
app.get("/protected", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  res.json({ userId });
});

app.listen(3000);
```

## Environment

Env vars (`{{ENV_VAR}}` and `CLERK_SECRET_KEY`) are in `{{ENV_FILE}}` via `clerk env pull`.

## Rules

ALWAYS:

- Use `clerkMiddleware()` from `@clerk/express` as Express middleware
- Use `requireAuth()` to protect routes that need authentication
- Use `getAuth(req)` to access auth state (`userId`, `sessionId`, etc.)
- Apply `clerkMiddleware()` before any route that needs auth
- Use existing package manager (`{{PM}}`)

NEVER:

- Use `@clerk/nextjs` or `@clerk/react` — use `@clerk/express`
- Use deprecated `ClerkExpressRequireAuth` or `ClerkExpressWithAuth` (replaced by `requireAuth` and `getAuth`)
- Skip `clerkMiddleware()` — it's required for `requireAuth()` and `getAuth()` to work

## Deprecated (DO NOT use)

```typescript
import { ClerkExpressRequireAuth } from "@clerk/express"; // WRONG — use requireAuth
import { ClerkExpressWithAuth } from "@clerk/express"; // WRONG — use clerkMiddleware + getAuth
```

## Verify Before Responding

1. Is `clerkMiddleware()` applied as middleware?
2. Are protected routes using `requireAuth()`?
3. Is `getAuth(req)` used to access auth state (not `req.auth` directly)?
4. Are imports from `@clerk/express`?

If any fails, revise.

## After Setup

Have the user test the protected route by sending a request without authentication (should get 401) and with a valid session token (should succeed). Then recommend exploring: Dashboard (https://dashboard.clerk.com/).

If you (the agent) need to create test users programmatically to exercise auth-gated code, use a `+clerk_test` email suffix. Clerk accepts `424242` as the OTP for these addresses, so you don't need inbox access. Development instances only.
