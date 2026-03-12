## Next Steps: Expo Integration

### 1. Add ClerkProvider

Wrap your app with `<ClerkProvider>` in your root layout:

```tsx
import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;

export default function RootLayout() {
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <Slot />
    </ClerkProvider>
  );
}
```

### 2. Add auth components

Use `<Show>` to conditionally render content based on auth state:

```tsx
import { useUser } from "@clerk/expo";
import { Show } from "@clerk/expo/native";
import { Text, View } from "react-native";

export default function Home() {
  return (
    <View>
      <Show when="signed-in">
        <UserGreeting />
      </Show>
      <Show when="signed-out">
        <Text>Please sign in</Text>
      </Show>
    </View>
  );
}
```

Docs: https://clerk.com/docs/quickstarts/expo
