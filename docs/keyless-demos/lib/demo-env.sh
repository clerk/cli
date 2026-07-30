# Helpers the demo tapes source inside a `Hide` block, so the recording shows
# the Clerk commands rather than the scaffolding around them.
#
# Sourced, never executed: `new_project` has to change the caller's directory.

# A quiet prompt with no history file, so recordings are reproducible.
quiet_shell() {
  export PS1='$ '
  export PROMPT_COMMAND=
  export HISTFILE=/dev/null
  # Keep the CLI's own update check out of the recording.
  export CLERK_NO_UPDATE_CHECK=1
}

# These demos are about a developer who has never logged in, but they get
# recorded on a machine that has. Point the CLI at an empty config directory and
# at an environment name nothing is stored under, so it genuinely finds no
# account — rather than faking one with a mock API.
#
# Credentials are keyed `oauth-access-token:<environment>` in the OS keyring, so
# naming an environment other than `production` is enough to miss every stored
# session without touching, reading, or deleting any of them. Both profiles hold
# the real Clerk URLs: every request in these recordings goes to the live API.
signed_out() {
  local dir="${1:?config dir required}"
  mkdir -p "$dir"
  printf '{"environment":"keyless-demo"}\n' > "$dir/config.json"
  export CLERK_CONFIG_DIR="$dir"

  local profile='{
    "oauthClientId": "ins_1lyWDZiobr600AKUeQDoSlrEmoM",
    "oauthBaseUrl": "https://clerk.clerk.com",
    "platformApiUrl": "https://api.clerk.com",
    "backendApiUrl": "https://api.clerk.dev",
    "dashboardUrl": "https://dashboard.clerk.com"
  }'
  printf '{"production": %s, "keyless-demo": %s}\n' "$profile" "$profile" > .env-profiles.json
}

# Fresh Next.js-shaped project at work/<name>, and cd into it. The `next`
# dependency is what drives the CLI's framework detection and the
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY naming.
#
# Built outside the repository on purpose. A project inside a dirty git worktree
# makes `clerk init` open with "You have uncommitted changes", which is correct
# advice and pure noise in a recording about something else.
new_project() {
  local name="${1:?project name required}"
  local root="${TMPDIR:-/tmp}/clerk-keyless-demos"

  rm -rf "$root/$name"
  mkdir -p "$root/$name"
  cd "$root/$name" || return 1

  cat > package.json <<'JSON'
{
  "name": "acme-dashboard",
  "private": true,
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "@clerk/nextjs": "^6.0.0"
  }
}
JSON

  signed_out "$root/.config-$name"
}

# Mint an unclaimed keyless application straight from Clerk's public endpoint
# and drop its keys where the CLI will find them. Demos that are *about*
# configuring a keyless app start here instead of replaying `clerk init`.
#
# The endpoint rate-limits, and a half-written .env.local is worse than no
# recording at all — it makes the CLI fall through to the account path and the
# demo silently shows the wrong thing. So: retry, then fail loudly.
#
# $1 — optional application template (b2b-saas, b2c-saas, native, waitlist)
keyless_keys() {
  local template="${1:-}"
  local body="source=cli"
  [ -n "$template" ] && body="$body&template=$template"

  local response publishable secret attempt
  for attempt in 1 2 3 4 5; do
    response="$(curl -sS --connect-timeout 10 --max-time 30 -X POST https://api.clerk.com/v1/accountless_applications \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      -d "$body")"

    publishable="$(printf '%s' "$response" | grep -o '"publishable_key":"[^"]*"' | cut -d'"' -f4)"
    secret="$(printf '%s' "$response" | grep -o '"secret_key":"[^"]*"' | cut -d'"' -f4)"

    if [ -n "$publishable" ] && [ -n "$secret" ]; then
      cat > .env.local <<EOF
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$publishable
CLERK_SECRET_KEY=$secret
EOF
      return 0
    fi

    echo "keyless_keys: attempt $attempt failed to return both key values" >&2
    sleep $((attempt * 5))
  done

  echo "keyless_keys: could not mint a keyless application; refusing to record" >&2
  return 1
}
