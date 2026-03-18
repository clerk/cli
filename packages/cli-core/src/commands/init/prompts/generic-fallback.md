# Add Clerk to {{FRAMEWORK_NAME}}

Install `{{SDK}}`. Set up the Clerk provider/middleware for {{FRAMEWORK_NAME}}. Use `<Show>` for conditional auth rendering.

Latest docs: {{DOCS_URL}}

## Install

```bash
{{INSTALL_CMD}}
```

## Steps

1. Set up the Clerk provider/middleware for {{FRAMEWORK_NAME}}.
2. Create sign-in and sign-up routes/components.
3. Use `<Show when="signed-in">` and `<Show when="signed-out">` for conditional rendering.

## Environment

Env vars (`{{ENV_VAR}}` and `CLERK_SECRET_KEY`) are in `{{ENV_FILE}}` via `clerk env pull`.

## Rules

ALWAYS:

- Use `{{SDK}}` — the correct SDK for {{FRAMEWORK_NAME}}
- Use `<Show>` for conditional rendering
- Use existing package manager (`{{PM}}`)

NEVER:

- Use deprecated `<SignedIn>`, `<SignedOut>` (replaced by `<Show>`)
- Use `authMiddleware()` (replaced by `clerkMiddleware()`)
- Import from the wrong Clerk SDK package

## Verify Before Responding

1. Is `{{SDK}}` installed?
2. Is the Clerk provider wrapping the application?
3. Is it using `<Show>` instead of `<SignedIn>`/`<SignedOut>`?

If any fails, revise.

## After Setup

Have the user sign up as their first test user. After signup succeeds and a profile icon appears, congratulate them. Then recommend exploring: Components (https://clerk.com/docs/reference/components/overview), Dashboard (https://dashboard.clerk.com/).
