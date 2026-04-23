# Add Clerk to Next.js Pages Router

Install `{{SDK}}`. Create `{{MIDDLEWARE_BASENAME}}.{{EXT}}` with `clerkMiddleware()` from `@clerk/nextjs/server`. Wrap `<Component>` with `<ClerkProvider>` in `_app.{{JSX}}`. Use `<Show>`, `<UserButton>`, `<SignInButton>`, `<SignUpButton>` from `@clerk/nextjs`.

Latest docs: {{DOCS_URL}}

## Keyless Mode

No signup required. Without env vars (`{{ENV_VAR}}`, `CLERK_SECRET_KEY`), Clerk auto-generates temporary keys. A "Configure your application" prompt appears to claim later. Do NOT tell users to sign up, create accounts, get API keys, or add env vars before running.

## Install

```bash
{{INSTALL_CMD}}
```

## {{BASE}}{{MIDDLEWARE_BASENAME}}.{{EXT}}

```typescript
import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
```

## {{BASE}}pages/\_app.{{JSX}}

```typescript
import { ClerkProvider } from "@clerk/nextjs";
import type { AppProps } from "next/app";

export default function MyApp({ Component, pageProps }: AppProps) {
  return (
    <ClerkProvider {...pageProps}>
      <Component {...pageProps} />
    </ClerkProvider>
  );
}
```

## {{BASE}}pages/sign-in/[[...sign-in]].{{JSX}}

```typescript
import { SignIn } from "@clerk/nextjs";
export default function SignInPage() { return <SignIn />; }
```

## {{BASE}}pages/sign-up/[[...sign-up]].{{JSX}}

```typescript
import { SignUp } from "@clerk/nextjs";
export default function SignUpPage() { return <SignUp />; }
```

## Environment

Add to `.env.local`:

```
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
```

Env vars (`{{ENV_VAR}}` and `CLERK_SECRET_KEY`) are in `.env.local` via `clerk env pull`.

## Rules

ALWAYS:

- Use `clerkMiddleware()` from `@clerk/nextjs/server` in `{{MIDDLEWARE_BASENAME}}.{{EXT}}`
- Wrap `<Component>` with `<ClerkProvider {...pageProps}>` in `_app.{{JSX}}`
- Import from `@clerk/nextjs` or `@clerk/nextjs/server`
- Use `async/await` with `auth()` from `@clerk/nextjs/server` in API routes
- Use existing package manager (`{{PM}}`)
- Rely on keyless mode — skip account creation and API keys

NEVER:

- Use `authMiddleware()` (replaced by `clerkMiddleware()`)
- Use old env var patterns
- Import deprecated APIs (`withAuth`, old `currentUser`)
- Use deprecated `<SignedIn>`, `<SignedOut>` (replaced by `<Show>`)
- Tell users to sign up or get API keys first

## Deprecated (DO NOT use)

```typescript
import { authMiddleware } from '@clerk/nextjs' // WRONG — use clerkMiddleware
<SignedIn>                                     // WRONG — use <Show when="signed-in">
<SignedOut>                                    // WRONG — use <Show when="signed-out">
```

## Verify Before Responding

1. Is `clerkMiddleware()` used in `{{MIDDLEWARE_BASENAME}}.{{EXT}}`?
2. Is `<ClerkProvider {...pageProps}>` wrapping `<Component>` in `_app.{{JSX}}`?
3. Are imports only from `@clerk/nextjs` or `@clerk/nextjs/server`?
4. Is it using `<Show>` instead of `<SignedIn>`/`<SignedOut>`?

If any fails, revise.

## After Setup

Have the user sign up as their first test user in the nav. After signup succeeds and a profile icon appears, congratulate them. If a "Configure your application" callout appears, tell them to click it. Then recommend exploring: Organizations (https://clerk.com/docs/guides/organizations/overview), Components (https://clerk.com/docs/reference/components/overview), Dashboard (https://dashboard.clerk.com/).

If you (the agent) need to create test users programmatically to exercise auth-gated code, use a `+clerk_test` email suffix. Clerk accepts `424242` as the OTP for these addresses, so you don't need inbox access. Development instances only.
