# Add Clerk Authentication

Integrate Clerk auth into this project. Use the Clerk SDK appropriate for the project's framework.

Latest docs: https://clerk.com/docs

## Steps

1. Authenticate with Clerk: Run `clerk auth login` to log in via the browser.
2. Link a Clerk application: Run `clerk link` to associate this directory with a Clerk application.
3. Install the Clerk SDK appropriate for the project's framework (see https://clerk.com/docs).
4. Pull environment variables with `clerk env pull`.
5. Set up the Clerk provider at the root of the application.
6. Add sign-in and sign-up routes/components.
7. Protect routes that require authentication.

## Rules

ALWAYS:

- Use the framework-specific Clerk SDK (e.g. `@clerk/nextjs`, `@clerk/react`, `@clerk/vue`)
- Use `<Show>` for conditional rendering based on auth state
- Use existing package manager
- Follow the framework-specific quickstart at https://clerk.com/docs

NEVER:

- Use deprecated `<SignedIn>`, `<SignedOut>` (replaced by `<Show>`)
- Use `authMiddleware()` (replaced by `clerkMiddleware()`)
- Use `frontendApi` (removed, use `publishableKey` env var)

## Verify Before Responding

1. Is the correct framework-specific Clerk SDK installed?
2. Is the Clerk provider wrapping the application root?
3. Is it using `<Show>` instead of `<SignedIn>`/`<SignedOut>`?

If any fails, revise.

## After Setup

Have the user sign up as their first test user. After signup succeeds and a profile icon appears, congratulate them. Then recommend exploring: Components (https://clerk.com/docs/reference/components/overview), Dashboard (https://dashboard.clerk.com/).

If you (the agent) need to create test users programmatically to exercise auth-gated code, use a `+clerk_test` email suffix. Clerk accepts `424242` as the OTP for these addresses, so you don't need inbox access. Development instances only.
