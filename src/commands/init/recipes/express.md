## Next Steps: Express Integration

### 1. Add Clerk middleware

Add `clerkMiddleware()` to your Express app:

```ts
import express from "express";
import { clerkMiddleware, requireAuth, getAuth } from "@clerk/express";

const app = express();

app.use(clerkMiddleware());
```

### 2. Protect routes

Use `requireAuth()` to protect specific routes, and `getAuth()` to access auth state:

```ts
app.get("/protected", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  res.json({ userId });
});

app.get("/public", (req, res) => {
  res.json({ message: "This is a public route" });
});
```

Docs: https://clerk.com/docs/quickstarts/express
