## Next Steps: React Integration

### 1. Add ClerkProvider

Wrap your app with `<ClerkProvider>` in your root component:

```tsx
import { ClerkProvider } from "@clerk/react";

function App() {
  return <ClerkProvider>{/* your app */}</ClerkProvider>;
}

export default App;
```

### 2. Add auth components

Add sign-in and user profile components:

```tsx
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/react";

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

Docs: https://clerk.com/docs/quickstarts/react
