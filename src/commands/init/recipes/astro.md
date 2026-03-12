## Next Steps: Astro Integration

### 1. Add Clerk integration

Add the `clerk()` integration and an SSR adapter to `astro.config.mjs`:

```ts
import { defineConfig } from "astro/config";
import clerk from "@clerk/astro";
import node from "@astrojs/node";

export default defineConfig({
  integrations: [clerk()],
  adapter: node({ mode: "standalone" }),
  output: "server",
});
```

### 2. Create middleware

Create `src/middleware.ts`:

```ts
import { clerkMiddleware } from "@clerk/astro/server";

export const onRequest = clerkMiddleware();
```

### 3. Add auth components

Use Clerk components in your Astro layouts and pages:

```astro
---
import { Show, UserButton, SignInButton, SignUpButton } from "@clerk/astro/components";
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

Docs: https://clerk.com/docs/quickstarts/astro
