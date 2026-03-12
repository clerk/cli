## Next Steps: Nuxt Integration

### 1. Add Clerk module

Add `@clerk/nuxt` to your modules in `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  modules: ["@clerk/nuxt"],
});
```

### 2. Add auth components

Use `<Show>` to conditionally render content based on auth state:

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

Docs: https://clerk.com/docs/quickstarts/nuxt
