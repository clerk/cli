# Clerk CLI — Recipes

Copy-pasteable patterns for common tasks. Treat these as starting points; confirm exact paths and parameters with `clerk api ls <keyword>` and `clerk <command> --help`, since the Clerk API evolves.

## Discovery first

```sh
clerk api ls                  # everything Backend API exposes
clerk api ls users            # filter by keyword
clerk api ls --platform       # Platform API (account-level)
```

The bundled catalog is cached locally for 1 hour; run `clerk api ls` to force a refresh if needed.

## Users

```sh
# List users (paginated)
clerk api /users
clerk api '/users?limit=10&offset=0&order_by=-created_at'

# Count users
clerk api /users/count

# Fetch a user
clerk api /users/user_abc123

# Search by email
clerk api '/users?email_address=alice@example.com'

# Create a user
clerk api /users -d '{
  "email_address": ["alice@example.com"],
  "password": "SuperSecret123!",
  "first_name": "Alice",
  "last_name": "Doe"
}'

# Update (PATCH merges)
clerk api /users/user_abc123 -X PATCH -d '{"first_name":"Alicia"}'

# Ban / unban
clerk api /users/user_abc123/ban -X POST
clerk api /users/user_abc123/unban -X POST

# Lock / unlock
clerk api /users/user_abc123/lock -X POST
clerk api /users/user_abc123/unlock -X POST

# Delete (PREVIEW FIRST)
clerk api /users/user_abc123 -X DELETE --dry-run
clerk api /users/user_abc123 -X DELETE --yes
```

### Test users (development only)

For test accounts you need to sign into without real email or SMS delivery, Clerk provides two magic patterns that both verify with the fixed OTP `424242`. Use them on development instances; production rejects them.

**By email.** Any address with the `+clerk_test` subaddress is recognized as a test email. The domain portion is arbitrary.

```sh
# Create a test user with a test email (dev instance)
clerk api /users -d '{
  "email_address": ["demo+clerk_test@example.com"],
  "password": "TestPass123!",
  "skip_password_checks": true
}'
```

**By phone.** Any US fictional phone number in the `+1 (XXX) 555-0100` through `+1 (XXX) 555-0199` range is recognized as a test phone. Pass the E.164 form.

```sh
# Create a test user with a test phone (dev instance)
clerk api /users -d '{
  "phone_number": ["+12015550100"],
  "password": "TestPass123!",
  "skip_password_checks": true
}'
```

When signing in as either user in a browser or Playwright, enter `424242` at the OTP prompt.

These patterns only apply to development instances. In production, client trust blocks sign-in regardless of suffix or number, and using real-looking test addresses is highly discouraged. Test addresses and numbers do not count against the dev-instance monthly caps (20 SMS, 100 emails). See [Clerk's test emails and phones reference](https://clerk.com/docs/guides/development/testing/test-emails-and-phones) for the full contract.

## Organizations

```sh
# List
clerk api /organizations
clerk api '/organizations?limit=20&query=acme'

# Fetch
clerk api /organizations/org_abc123

# Create
clerk api /organizations -d '{"name":"Acme","created_by":"user_abc123"}'

# Update
clerk api /organizations/org_abc123 -X PATCH -d '{"name":"Acme Inc."}'

# Members
clerk api /organizations/org_abc123/memberships
clerk api /organizations/org_abc123/memberships -d '{"user_id":"user_xyz","role":"org:member"}'
clerk api /organizations/org_abc123/memberships/user_xyz -X PATCH -d '{"role":"org:admin"}'
clerk api /organizations/org_abc123/memberships/user_xyz -X DELETE --dry-run

# Invitations
clerk api /organizations/org_abc123/invitations -d '{"email_address":"new@acme.com","role":"org:member"}'
```

If organization endpoints return `organization_not_enabled_in_instance`, enable the feature first:

```sh
# Inspect org settings
clerk api /instance/organization_settings

# Preview, then enable organizations for this instance
clerk api /instance/organization_settings -X PATCH -d '{"enabled":true}' --dry-run
clerk api /instance/organization_settings -X PATCH -d '{"enabled":true}' --yes
```

## Sessions

```sh
# List active sessions for a user
clerk api '/sessions?user_id=user_abc123&status=active'

# Revoke a session
clerk api /sessions/sess_abc123/revoke -X POST

# Create an impersonation / sign-in token (for testing)
clerk api /sign_in_tokens -d '{"user_id":"user_abc123"}'
```

## Invitations (top-level, not org-scoped)

```sh
clerk api /invitations
clerk api /invitations -d '{"email_address":"new@example.com","redirect_url":"https://example.com/welcome"}'
clerk api /invitations/inv_abc123/revoke -X POST
```

## JWT templates

```sh
clerk api /jwt_templates
clerk api /jwt_templates/jtmp_abc123
clerk api /jwt_templates -d '{
  "name": "supabase",
  "claims": {"aud": "authenticated", "role": "authenticated"},
  "lifetime": 60
}'
```

## Instance configuration

Prefer the dedicated `config` commands over raw `api` calls — they handle confirmation, dry-run, and formatting.

```sh
# Pull the current dev config
clerk config pull
clerk config pull --output config.dev.json

# Pull production
clerk config pull --instance prod --output config.prod.json

# Look at the schema to know what's available
clerk config schema --keys session sign_in social

# PATCH: surgical updates
clerk config patch --json '{"session":{"lifetime":3600}}' --dry-run
clerk config patch --json '{"session":{"lifetime":3600}}' --yes

# PUT: replace everything (destructive — always --dry-run first)
clerk config put --file config.prod.json --dry-run
clerk config put --file config.prod.json --instance prod --yes
```

## Environment variables

```sh
# Pull dev keys into .env.local (auto-detects framework and key names)
clerk env pull

# Pull production keys
clerk env pull --instance prod

# Target a specific file
clerk env pull --file .env
```

`env pull` merges into the existing file: existing Clerk keys are updated in place; new ones are appended under a `# Clerk` header; everything else is preserved.

## Applications (Platform API)

```sh
# List your apps
clerk apps list
clerk apps list --json

# Fetch one (raw API)
clerk api /v1/platform/applications/app_abc123 --platform
```

## Scripting patterns

### Pipe to `jq`

```sh
# Get a list of user IDs
clerk api /users | jq -r '.[] | .id'

# Count banned users
clerk api /users | jq '[.[] | select(.banned)] | length'
```

### Read body from stdin

```sh
echo '{"first_name":"Bob"}' | clerk api /users/user_abc123 -X PATCH
jq -n '{email_address:["c@d.co"]}' | clerk api /users
```

### Loop safely

```sh
# Always --dry-run first across the whole set
for id in $(clerk api /users | jq -r '.[] | .id'); do
  clerk api /users/$id -X PATCH -d '{"public_metadata":{"migrated":true}}' --dry-run
done
# Re-run without --dry-run once the previews look right
```

### Target multiple instances

```sh
# Copy config from dev to staging for review
clerk config pull --instance dev --output /tmp/dev-config.json
clerk config patch --instance ins_staging --file /tmp/dev-config.json --dry-run
```

## When in doubt

```sh
clerk api ls <keyword>        # find the right endpoint
clerk <command> --help        # authoritative flag list
clerk doctor --json           # health check
```
