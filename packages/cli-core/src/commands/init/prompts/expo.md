# Add Clerk to Expo

Install `{{SDK}}`. Wrap the app in `<ClerkProvider>` with a secure token cache. Use `<Show>`, `<SignInButton>`, `<SignUpButton>`, `<UserButton>` from `@clerk/expo`.

Latest docs: {{DOCS_URL}}

## Install

```bash
{{INSTALL_CMD}}
```

## Token Cache

Create a secure token cache using `expo-secure-store`:

```bash
{{INSTALL_CMD_EXTRA}}
```

```typescript
import * as SecureStore from "expo-secure-store";

export const tokenCache = {
  async getToken(key: string) {
    return SecureStore.getItemAsync(key);
  },
  async saveToken(key: string, value: string) {
    return SecureStore.setItemAsync(key, value);
  },
  async clearToken(key: string) {
    return SecureStore.deleteItemAsync(key);
  },
};
```

## App entry (app/\_layout.{{JSX}} or App.{{JSX}})

```typescript
import { ClerkProvider, ClerkLoaded } from "@clerk/expo";
import { tokenCache } from "./token-cache";

export default function RootLayout() {
  const publishableKey = process.env.{{ENV_VAR}};

  return (
    <ClerkProvider tokenCache={tokenCache} publishableKey={publishableKey}>
      <ClerkLoaded>
        {/* your app content */}
      </ClerkLoaded>
    </ClerkProvider>
  );
}
```

## Example usage

```typescript
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/expo";

export default function Home() {
  return (
    <>
      <Show when="signed-out">
        <SignInButton />
        <SignUpButton />
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </>
  );
}
```

## Environment

Env var (`{{ENV_VAR}}`) is in `{{ENV_FILE}}` via `clerk env pull`.

## Rules

ALWAYS:

- Use `@clerk/expo` (not `@clerk/react` or `@clerk/nextjs`)
- Pass `tokenCache` to `<ClerkProvider>` for secure token storage
- Pass `publishableKey` explicitly from `process.env.{{ENV_VAR}}`
- Wrap content with `<ClerkLoaded>` inside `<ClerkProvider>`
- Use `<Show>` for conditional rendering
- Use existing package manager (`{{PM}}`)

NEVER:

- Use `@clerk/react` or `@clerk/nextjs` — use `@clerk/expo`
- Use deprecated `<SignedIn>`, `<SignedOut>` (replaced by `<Show>`)
- Skip the `tokenCache` (tokens won't persist across app restarts)
- Use `localStorage` or `AsyncStorage` directly for tokens

## Deprecated (DO NOT use)

```typescript
import { ClerkProvider } from "@clerk/react"   // WRONG — use @clerk/expo
<SignedIn>                                     // WRONG — use <Show when="signed-in">
<SignedOut>                                    // WRONG — use <Show when="signed-out">
```

## Verify Before Responding

1. Is `@clerk/expo` used (not `@clerk/react`)?
2. Is `tokenCache` passed to `<ClerkProvider>`?
3. Is `<ClerkLoaded>` wrapping the app content?
4. Is it using `<Show>` instead of `<SignedIn>`/`<SignedOut>`?

If any fails, revise.

## After Setup

Have the user sign up as their first test user. After signup succeeds, congratulate them. Then recommend exploring: Components (https://clerk.com/docs/reference/components/overview), Dashboard (https://dashboard.clerk.com/).

If you (the agent) need to create test users programmatically to exercise auth-gated code, use a `+clerk_test` email suffix. Clerk accepts `424242` as the OTP for these addresses, so you don't need inbox access. Development instances only.
