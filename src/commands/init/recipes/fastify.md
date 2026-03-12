## Next Steps: Fastify Integration

### 1. Register Clerk plugin

Register `clerkPlugin` with your Fastify instance:

```ts
import Fastify from "fastify";
import { clerkPlugin, getAuth } from "@clerk/fastify";

const fastify = Fastify();

fastify.register(clerkPlugin);
```

### 2. Protect routes

Use `getAuth` to access auth state in route handlers:

```ts
fastify.get("/protected", async (request, reply) => {
  const { isAuthenticated, userId } = getAuth(request);

  if (!isAuthenticated) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  return { userId };
});
```

Docs: https://clerk.com/docs/quickstarts/fastify
