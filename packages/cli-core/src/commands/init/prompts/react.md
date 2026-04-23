# Add Clerk to React

Install `{{SDK}}`. Wrap the app in `<ClerkProvider>` in `{{BASE}}main.{{JSX}}`. Use `<Show>`, `<SignInButton>`, `<SignUpButton>`, `<UserButton>` from `@clerk/react`.

Latest docs: {{DOCS_URL}}

## Install

```bash
{{INSTALL_CMD}}
```

## {{BASE}}main.{{JSX}}

```typescript
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.{{JSX}}";
import { ClerkProvider } from "@clerk/react";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClerkProvider afterSignOutUrl="/">
      <App />
    </ClerkProvider>
  </StrictMode>
);
```

## App.{{JSX}}

```typescript
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/react";

export default function App() {
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

## Environment

Env var (`{{ENV_VAR}}`) is in `{{ENV_FILE}}` via `clerk env pull`.

## Rules

ALWAYS:

- Use `@clerk/react` (not any other Clerk package)
- Reference env var as `{{ENV_VAR}}` in `{{ENV_FILE}}`
- Wrap the entire app in `<ClerkProvider>` within `{{BASE}}main.{{JSX}}`
- Use `<Show>`, `<SignInButton>`, `<SignUpButton>`, `<UserButton>`
- Use existing package manager (`{{PM}}`)

NEVER:

- Use `frontendApi` in place of `publishableKey`
- Use older env var names like `REACT_APP_CLERK_FRONTEND_API` or `VITE_REACT_APP_CLERK_PUBLISHABLE_KEY`
- Manually pass `publishableKey` as a prop to `<ClerkProvider>`
- Place `<ClerkProvider>` deeper in the component tree instead of `{{BASE}}main.{{JSX}}`
- Use deprecated `<SignedIn>`, `<SignedOut>` (replaced by `<Show>`)

## Deprecated (DO NOT use)

```typescript
import { SignedIn, SignedOut } from "@clerk/react" // WRONG — use <Show>
<ClerkProvider publishableKey={key}>              // WRONG — reads from env automatically
frontendApi="..."                                 // WRONG — removed, use publishableKey env var
REACT_APP_CLERK_FRONTEND_API                      // WRONG — use {{ENV_VAR}}
```

## Verify Before Responding

1. Is `<ClerkProvider>` in `{{BASE}}main.{{JSX}}` without a manual `publishableKey` prop?
2. Is env var named `{{ENV_VAR}}`?
3. Is it using `<Show>` instead of `<SignedIn>`/`<SignedOut>`?
4. No usage of `frontendApi`?

If any fails, revise.

## After Setup

Have the user sign up as their first test user. After signup succeeds and a profile icon appears, congratulate them. Then recommend exploring: Components (https://clerk.com/docs/reference/components/overview), Dashboard (https://dashboard.clerk.com/).

If you (the agent) need to create test users programmatically to exercise auth-gated code, use a `+clerk_test` email suffix. Clerk accepts `424242` as the OTP for these addresses, so you don't need inbox access. Development instances only.
