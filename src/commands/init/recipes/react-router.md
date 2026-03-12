## Next Steps: React Router Integration

### 1. Enable middleware and add root auth loader

Enable the `v8_middleware` future flag in `react-router.config.ts`:

```ts
import type { Config } from "@react-router/dev/config";

export default {
  future: {
    v8_middleware: true,
  },
} satisfies Config;
```

### 2. Configure root route

Add `clerkMiddleware`, `rootAuthLoader`, and `<ClerkProvider>` in `app/root.tsx`:

```tsx
import { clerkMiddleware, rootAuthLoader } from "@clerk/react-router/server";
import { ClerkProvider } from "@clerk/react-router";
import { Outlet } from "react-router";
import type { Route } from "./+types/root";

export const middleware: Route.MiddlewareFunction[] = [clerkMiddleware()];

export const loader = (args: Route.LoaderArgs) => rootAuthLoader(args);

export default function App({ loaderData }: Route.ComponentProps) {
  return (
    <ClerkProvider loaderData={loaderData}>
      <Outlet />
    </ClerkProvider>
  );
}
```

### 3. Add auth components

Use Clerk components in your routes:

```tsx
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/react-router";

export default function Header() {
  return (
    <header>
      <Show when="signed-out">
        <SignInButton />
        <SignUpButton />
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </header>
  );
}
```

Docs: https://clerk.com/docs/quickstarts/react-router
