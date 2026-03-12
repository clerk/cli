## Next Steps: Vue Integration

### 1. Install Clerk plugin

Add the Clerk plugin to your Vue app in `main.ts`:

```ts
import { createApp } from "vue";
import { clerkPlugin } from "@clerk/vue";
import App from "./App.vue";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  throw new Error("Add your Clerk Publishable Key to the .env file");
}

const app = createApp(App);

app.use(clerkPlugin, {
  publishableKey: PUBLISHABLE_KEY,
});

app.mount("#app");
```

### 2. Add auth components

Use `<Show>` to conditionally render content based on auth state:

```vue
<script setup lang="ts">
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

Docs: https://clerk.com/docs/quickstarts/vue
