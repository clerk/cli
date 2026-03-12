## Next Steps: TanStack Start Integration

### 1. Configure Clerk middleware

Add `clerkMiddleware` to your server entry (`src/start.ts`):

```ts
import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => ({
  requestMiddleware: [clerkMiddleware()],
}));
```

### 2. Add ClerkProvider to root

Wrap your app with `<ClerkProvider>` in `src/routes/__root.tsx`:

```tsx
import { ClerkProvider } from "@clerk/tanstack-react-start";
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <ClerkProvider>
          <Outlet />
        </ClerkProvider>
        <Scripts />
      </body>
    </html>
  );
}
```

### 3. Add auth components

Use Clerk components in your routes:

```tsx
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/tanstack-react-start";

export default function Home() {
  return (
    <div>
      <Show when="signed-out">
        <SignInButton />
        <SignUpButton />
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </div>
  );
}
```

Docs: https://clerk.com/docs/quickstarts/tanstack-start
