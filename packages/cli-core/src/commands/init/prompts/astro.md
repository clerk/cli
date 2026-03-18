# Add Clerk to Astro

Install `{{SDK}}`. Add `clerk()` integration to `astro.config.mjs`. Create middleware with `clerkMiddleware()`. Use `<Show>`, `<SignIn>`, `<SignUp>`, `<UserButton>` from `@clerk/astro/components`.

Latest docs: {{DOCS_URL}}

## Install

```bash
{{INSTALL_CMD}}
```

## astro.config.mjs

```typescript
import { defineConfig } from "astro/config";
import clerk from "@clerk/astro";

export default defineConfig({
  integrations: [clerk()],
  output: "server",
});
```

## src/middleware.ts

```typescript
import { clerkMiddleware } from "@clerk/astro/server";

export const onRequest = clerkMiddleware();
```

## src/pages/sign-in.astro

```astro
---
import { SignIn } from '@clerk/astro/components';
---
<SignIn />
```

## src/pages/sign-up.astro

```astro
---
import { SignUp } from '@clerk/astro/components';
---
<SignUp />
```

## Example usage in a layout

```astro
---
import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/astro/components';
---
<header>
  <Show when="signed-out">
    <SignInButton />
    <SignUpButton />
  </Show>
  <Show when="signed-in">
    <UserButton />
  </Show>
</header>
```

## Environment

Env vars (`{{ENV_VAR}}` and `CLERK_SECRET_KEY`) are in `{{ENV_FILE}}` via `clerk env pull`.

## Rules

ALWAYS:

- Add `clerk()` to `integrations` in `astro.config.mjs`
- Set `output: 'server'` (SSR required) with an SSR adapter
- Use `clerkMiddleware()` from `@clerk/astro/server` in `src/middleware.ts`
- Import components from `@clerk/astro/components`
- Use `<Show>` for conditional rendering
- Use existing package manager (`{{PM}}`)

NEVER:

- Use `authMiddleware()` (replaced by `clerkMiddleware()`)
- Use deprecated `<SignedIn>`, `<SignedOut>` (replaced by `<Show>`)
- Import from `@clerk/react` or `@clerk/nextjs` — use `@clerk/astro`
- Skip `output: 'server'` (Clerk requires SSR)

## Deprecated (DO NOT use)

```typescript
import { authMiddleware } from '@clerk/astro' // WRONG — use clerkMiddleware
<SignedIn>                                    // WRONG — use <Show when="signed-in">
<SignedOut>                                   // WRONG — use <Show when="signed-out">
output: 'static'                             // WRONG — Clerk requires SSR
```

## Verify Before Responding

1. Is `clerk()` in `integrations` in `astro.config.mjs`?
2. Is `output: 'server'` set?
3. Is `clerkMiddleware()` exported as `onRequest` in `src/middleware.ts`?
4. Are components imported from `@clerk/astro/components`?
5. Is it using `<Show>` instead of `<SignedIn>`/`<SignedOut>`?

If any fails, revise.

## After Setup

Have the user sign up as their first test user. After signup succeeds and a profile icon appears, congratulate them. Then recommend exploring: Components (https://clerk.com/docs/reference/components/overview), Dashboard (https://dashboard.clerk.com/).
