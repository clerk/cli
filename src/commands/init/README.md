# Init Command

Initializes Clerk in a project by authenticating the user, linking a Clerk application, installing the SDK, and writing environment variables.

## Usage

```sh
clerk init
```

## Flow

1. Authenticates the user via `clerk auth login` (see [auth/README.md](../auth/README.md) for APIs)
2. Links the project to a Clerk application via `clerk link` (see [link/README.md](../link/README.md) for APIs)
3. Detects the project's framework from `package.json` and installs the appropriate Clerk SDK (e.g. `@clerk/nextjs` for Next.js)
4. Pulls development instance API keys via `clerk env pull` and writes them to `.env.local`

## Framework Detection

The command detects the project's framework by checking `package.json` dependencies:

| Dependency              | Framework      | Clerk SDK               |
| ----------------------- | -------------- | ----------------------- |
| `next`                  | Next.js        | `@clerk/nextjs`         |
| `expo`                  | Expo           | `@clerk/expo`           |
| `astro`                 | Astro          | `@clerk/astro`          |
| `nuxt`                  | Nuxt           | `@clerk/nuxt`           |
| `@tanstack/react-start` | TanStack Start | `@clerk/tanstack-start` |
| `react-router`          | React Router   | `@clerk/react-router`   |
| `fastify`               | Fastify        | `@clerk/fastify`        |
| `express`               | Express        | `@clerk/express`        |
| `vue`                   | Vue            | `@clerk/vue`            |
| `react`                 | React          | `@clerk/clerk-react`    |
| `vite`                  | Vite           | `@clerk/clerk-react`    |

The package manager is detected from lock files (`bun.lockb` → bun, `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm, else npm).

## Post-Setup Recipes

After completing the setup steps, the command outputs a framework-specific integration recipe with the code changes needed to finish the Clerk integration (middleware, providers, components). Recipes are bundled as static markdown files in `recipes/`.

- **Human mode**: the recipe text is printed to the console after the check lines.
- **Agent mode**: the recipe is included as a `recipe` field in the TOON output, giving agents the full integration guide to follow.

Supported frameworks: Next.js, React/Vite, Expo, Astro, Nuxt, TanStack Start, React Router, Fastify, Express, Vue.

## API Endpoints

See [auth/README.md](../auth/README.md), [link/README.md](../link/README.md), and [env/README.md](../env/README.md) for the API endpoints used by each step.
