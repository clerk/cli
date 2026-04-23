# Add Clerk to Nuxt

Install `{{SDK}}`. Add `@clerk/nuxt` to the `modules` array in `nuxt.config.ts`. Middleware is auto-configured. Use `<Show>`, `<SignIn>`, `<SignUp>`, `<UserButton>` (auto-imported).

Latest docs: {{DOCS_URL}}

## Install

```bash
{{INSTALL_CMD}}
```

## nuxt.config.ts

```typescript
export default defineNuxtConfig({
  modules: ["@clerk/nuxt"],
});
```

## pages/sign-in/[...slug].vue

```vue
<template>
  <SignIn />
</template>
```

## pages/sign-up/[...slug].vue

```vue
<template>
  <SignUp />
</template>
```

## Example usage in a component

```vue
<template>
  <header>
    <Show when="signed-out">
      <SignInButton />
      <SignUpButton />
    </Show>
    <Show when="signed-in">
      <UserButton />
    </Show>
  </header>
</template>
```

## Environment

Env vars (`{{ENV_VAR}}` and `NUXT_CLERK_SECRET_KEY`) are in `{{ENV_FILE}}` via `clerk env pull`.

## Rules

ALWAYS:

- Add `'@clerk/nuxt'` to the `modules` array in `nuxt.config.ts`
- Let Nuxt auto-import Clerk components (no manual imports needed)
- Use `<Show>` for conditional rendering
- Use existing package manager (`{{PM}}`)

NEVER:

- Manually configure middleware (Nuxt module handles it)
- Manually import Clerk components in `.vue` files (auto-imported)
- Use deprecated `<SignedIn>`, `<SignedOut>` (replaced by `<Show>`)
- Import from `@clerk/vue` — use `@clerk/nuxt`

## Deprecated (DO NOT use)

```typescript
import { clerkMiddleware } from '@clerk/nuxt' // WRONG — module auto-configures middleware
<SignedIn>                                    // WRONG — use <Show when="signed-in">
<SignedOut>                                   // WRONG — use <Show when="signed-out">
import { SignIn } from "@clerk/vue"           // WRONG — auto-imported by Nuxt module
```

## Verify Before Responding

1. Is `'@clerk/nuxt'` in the `modules` array in `nuxt.config.ts`?
2. Are Clerk components used without manual imports?
3. Is it using `<Show>` instead of `<SignedIn>`/`<SignedOut>`?

If any fails, revise.

## After Setup

Have the user sign up as their first test user. After signup succeeds and a profile icon appears, congratulate them. Then recommend exploring: Components (https://clerk.com/docs/reference/components/overview), Dashboard (https://dashboard.clerk.com/).

If you (the agent) need to create test users programmatically to exercise auth-gated code, use a `+clerk_test` email suffix. Clerk accepts `424242` as the OTP for these addresses, so you don't need inbox access. Development instances only.
