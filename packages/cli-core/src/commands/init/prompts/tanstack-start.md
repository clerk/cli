# Add Clerk to TanStack Start

Install `{{SDK}}`. Add `clerkMiddleware()` to `src/start.ts`. Wrap content with `<ClerkProvider>` in `src/routes/__root.tsx`. Use `<Show>`, `<UserButton>`, `<SignInButton>`, `<SignUpButton>` from `@clerk/tanstack-react-start`.

Latest docs: {{DOCS_URL}}

## Install

```bash
{{INSTALL_CMD}}
```

## src/start.ts

```typescript
import { createStart } from "@tanstack/react-start/server";
import { clerkMiddleware } from "@clerk/tanstack-react-start/server";

export default createStart({
  requestMiddleware: [clerkMiddleware()],
});
```

## src/routes/\_\_root.tsx

```typescript
import { ClerkProvider } from "@clerk/tanstack-react-start";
import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <ClerkProvider>
      <Outlet />
    </ClerkProvider>
  );
}
```

## src/routes/sign-in.$.{{JSX}}

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { SignIn } from "@clerk/tanstack-react-start";

export const Route = createFileRoute("/sign-in/$")({
  component: () => <SignIn />,
});
```

## src/routes/sign-up.$.{{JSX}}

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { SignUp } from "@clerk/tanstack-react-start";

export const Route = createFileRoute("/sign-up/$")({
  component: () => <SignUp />,
});
```

## Environment

Env vars (`{{ENV_VAR}}` and `CLERK_SECRET_KEY`) are in `{{ENV_FILE}}` via `clerk env pull`.

## Rules

ALWAYS:

- Use `clerkMiddleware()` from `@clerk/tanstack-react-start/server` in `src/start.ts`
- Wrap content with `<ClerkProvider>` in `src/routes/__root.tsx`
- Use `createFileRoute` for sign-in/sign-up routes with `$` splat
- Use `<Show>` for conditional rendering
- Use existing package manager (`{{PM}}`)

NEVER:

- Use `authMiddleware()` (replaced by `clerkMiddleware()`)
- Use deprecated `<SignedIn>`, `<SignedOut>` (replaced by `<Show>`)
- Import from `@clerk/react` or `@clerk/nextjs` — use `@clerk/tanstack-react-start`
- Skip `requestMiddleware` in `createStart` config

## Deprecated (DO NOT use)

```typescript
import { authMiddleware } from '@clerk/tanstack-react-start' // WRONG — use clerkMiddleware
<SignedIn>                                                   // WRONG — use <Show when="signed-in">
<SignedOut>                                                  // WRONG — use <Show when="signed-out">
import { ClerkProvider } from "@clerk/react"                 // WRONG — use @clerk/tanstack-react-start
```

## Verify Before Responding

1. Is `clerkMiddleware()` in `requestMiddleware` in `src/start.ts`?
2. Is `<ClerkProvider>` wrapping `<Outlet />` in `src/routes/__root.tsx`?
3. Are sign-in/sign-up routes using `createFileRoute` with `$` splat?
4. Is it using `<Show>` instead of `<SignedIn>`/`<SignedOut>`?

If any fails, revise.

## After Setup

Have the user sign up as their first test user. After signup succeeds and a profile icon appears, congratulate them. Then recommend exploring: Components (https://clerk.com/docs/reference/components/overview), Dashboard (https://dashboard.clerk.com/).
