# Add Clerk to React Router

Install `{{SDK}}`. Enable middleware in `react-router.config.ts`. Set up `clerkMiddleware()` and `ClerkProvider` in `app/root.tsx`. Use `<Show>`, `<UserButton>`, `<SignInButton>`, `<SignUpButton>` from `@clerk/react-router`.

Latest docs: {{DOCS_URL}}

## Install

```bash
{{INSTALL_CMD}}
```

## react-router.config.ts

```typescript
import type { Config } from "@react-router/dev/config";

export default {
  future: {
    v8_middleware: true,
  },
} satisfies Config;
```

## app/root.tsx

```typescript
import { clerkMiddleware, rootAuthLoader } from "@clerk/react-router/server";
import { ClerkProvider } from "@clerk/react-router";
import type { Route } from "./+types/root";

export const middleware: Route.MiddlewareFunction[] = [clerkMiddleware()];

export const loader = (args: Route.LoaderArgs) => rootAuthLoader(args);

export default function Root({ loaderData }: Route.ComponentProps) {
  return (
    <ClerkProvider loaderData={loaderData}>
      {/* your app content */}
    </ClerkProvider>
  );
}
```

## app/routes/sign-in.{{JSX}}

```typescript
import { SignIn } from "@clerk/react-router";
export default function SignInPage() { return <SignIn />; }
```

## app/routes/sign-up.{{JSX}}

```typescript
import { SignUp } from "@clerk/react-router";
export default function SignUpPage() { return <SignUp />; }
```

## app/routes.ts

```typescript
import { type RouteConfig, route } from "@react-router/dev/routes";

export default [
  route("sign-in/*", "routes/sign-in.tsx"),
  route("sign-up/*", "routes/sign-up.tsx"),
] satisfies RouteConfig;
```

## Environment

Env vars (`{{ENV_VAR}}` and `CLERK_SECRET_KEY`) are in `{{ENV_FILE}}` via `clerk env pull`.

## Rules

ALWAYS:

- Enable `future: { v8_middleware: true }` in `react-router.config.ts`
- Use `clerkMiddleware()` from `@clerk/react-router/server` in `app/root.tsx`
- Use `rootAuthLoader` for the root loader
- Wrap content with `<ClerkProvider loaderData={loaderData}>`
- Use `<Show>` for conditional rendering
- Use existing package manager (`{{PM}}`)

NEVER:

- Use `authMiddleware()` (replaced by `clerkMiddleware()`)
- Skip the `rootAuthLoader` in the root route
- Use deprecated `<SignedIn>`, `<SignedOut>` (replaced by `<Show>`)
- Import from `@clerk/nextjs` or `@clerk/react` — use `@clerk/react-router`

## Deprecated (DO NOT use)

```typescript
import { authMiddleware } from '@clerk/react-router' // WRONG — use clerkMiddleware
<SignedIn>                                           // WRONG — use <Show when="signed-in">
<SignedOut>                                          // WRONG — use <Show when="signed-out">
import { ClerkProvider } from "@clerk/react"         // WRONG — use @clerk/react-router
```

## Verify Before Responding

1. Is `v8_middleware: true` set in `react-router.config.ts`?
2. Is `clerkMiddleware()` exported in `app/root.tsx`?
3. Is `rootAuthLoader` used as the root loader?
4. Is `<ClerkProvider loaderData={loaderData}>` wrapping the app?
5. Is it using `<Show>` instead of `<SignedIn>`/`<SignedOut>`?

If any fails, revise.

## After Setup

Have the user sign up as their first test user. After signup succeeds and a profile icon appears, congratulate them. Then recommend exploring: Components (https://clerk.com/docs/reference/components/overview), Dashboard (https://dashboard.clerk.com/).

If you (the agent) need to create test users programmatically to exercise auth-gated code, use a `+clerk_test` email suffix. Clerk accepts `424242` as the OTP for these addresses, so you don't need inbox access. Development instances only.
