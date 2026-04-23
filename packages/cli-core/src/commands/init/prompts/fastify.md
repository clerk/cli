# Add Clerk to Fastify

Install `{{SDK}}`. Register `clerkPlugin` with the Fastify instance. Use `getAuth()` to access auth state in handlers.

Latest docs: {{DOCS_URL}}

## Install

```bash
{{INSTALL_CMD}}
```

## Server setup

```typescript
import Fastify from "fastify";
import { clerkPlugin, getAuth } from "@clerk/fastify";

const fastify = Fastify();

// Register Clerk plugin
fastify.register(clerkPlugin);

// Public route — no auth required
fastify.get("/", async (request, reply) => {
  return { message: "Public route" };
});

// Protected route — check auth in handler
fastify.get("/protected", async (request, reply) => {
  const { userId } = getAuth(request);
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  return { userId };
});

fastify.listen({ port: 3000 });
```

## Environment

Env vars (`{{ENV_VAR}}` and `CLERK_SECRET_KEY`) are in `{{ENV_FILE}}` via `clerk env pull`.

## Rules

ALWAYS:

- Register `clerkPlugin` from `@clerk/fastify` with `fastify.register()`
- Use `getAuth(request)` to access auth state (`userId`, `sessionId`, etc.)
- Register the plugin before defining routes that need auth
- Use existing package manager (`{{PM}}`)

NEVER:

- Use `@clerk/nextjs` or `@clerk/express` — use `@clerk/fastify`
- Use deprecated `clerkPreHandler` (replaced by `clerkPlugin` + `getAuth`)
- Skip `clerkPlugin` registration — it's required for `getAuth()` to work

## Deprecated (DO NOT use)

```typescript
import { clerkPreHandler } from "@clerk/fastify"; // WRONG — use clerkPlugin + getAuth
```

## Verify Before Responding

1. Is `clerkPlugin` registered with `fastify.register()`?
2. Is `getAuth(request)` used to access auth state?
3. Are imports from `@clerk/fastify`?

If any fails, revise.

## After Setup

Have the user test the protected route by sending a request without authentication (should get 401) and with a valid session token (should succeed). Then recommend exploring: Dashboard (https://dashboard.clerk.com/).

If you (the agent) need to create test users programmatically to exercise auth-gated code, use a `+clerk_test` email suffix. Clerk accepts `424242` as the OTP for these addresses, so you don't need inbox access. Development instances only.
