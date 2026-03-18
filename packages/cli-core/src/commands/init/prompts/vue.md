# Add Clerk to Vue

Install `{{SDK}}`. Add `clerkPlugin` to the Vue app in `{{BASE}}main.ts`. Use `<Show>`, `<SignInButton>`, `<SignUpButton>`, `<UserButton>` from `@clerk/vue`.

Latest docs: {{DOCS_URL}}

## Install

```bash
{{INSTALL_CMD}}
```

## {{BASE}}main.ts

```typescript
import { createApp } from 'vue';
import App from './App.vue';
import { clerkPlugin } from '@clerk/vue';

const app = createApp(App);
app.use(clerkPlugin, {
  publishableKey: import.meta.env.{{ENV_VAR}},
});
app.mount('#app');
```

## Example usage in App.vue

```vue
<script setup>
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/vue";
</script>

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

Env var (`{{ENV_VAR}}`) is in `{{ENV_FILE}}` via `clerk env pull`.

## Rules

ALWAYS:

- Use `clerkPlugin` from `@clerk/vue` in `{{BASE}}main.ts`
- Pass `publishableKey: import.meta.env.{{ENV_VAR}}` to `clerkPlugin`
- Use `<Show>` for conditional rendering
- Use existing package manager (`{{PM}}`)

NEVER:

- Use deprecated `<SignedIn>`, `<SignedOut>` (replaced by `<Show>`)
- Import from `@clerk/react` or `@clerk/nextjs` — use `@clerk/vue`
- Use old env var names

## Deprecated (DO NOT use)

```typescript
<SignedIn>   // WRONG — use <Show when="signed-in">
<SignedOut>  // WRONG — use <Show when="signed-out">
```

## Verify Before Responding

1. Is `clerkPlugin` used with `app.use()` in `{{BASE}}main.ts`?
2. Is `publishableKey` reading from `import.meta.env.{{ENV_VAR}}`?
3. Is it using `<Show>` instead of `<SignedIn>`/`<SignedOut>`?

If any fails, revise.

## After Setup

Have the user sign up as their first test user. After signup succeeds and a profile icon appears, congratulate them. Then recommend exploring: Components (https://clerk.com/docs/reference/components/overview), Dashboard (https://dashboard.clerk.com/).
