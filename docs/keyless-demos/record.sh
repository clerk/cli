#!/usr/bin/env bash
#
# Re-record the keyless demos.
#
#   ./docs/keyless-demos/record.sh            # every tape
#   ./docs/keyless-demos/record.sh 03 06      # only tapes whose name starts with 03 or 06
#
# Each run compiles the CLI from the current working tree and puts that binary
# first on PATH, so what you see recorded is this checkout — not whatever
# `clerk` happens to be installed globally.
#
# Every tape mints its own unclaimed keyless application against the real Clerk
# API. No account, no login, nothing to clean up: unclaimed applications expire
# on their own. Only publishable keys and instance IDs ever reach the screen.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

command -v vhs >/dev/null || { echo "vhs is not installed: brew install vhs" >&2; exit 1; }

mkdir -p "$here/bin" "$here/out" "$here/work"

# `clerk` on the tapes' PATH is this working tree, so a recording always shows
# the current checkout rather than a globally installed CLI.
#
# It runs the TypeScript entry point rather than `build:compile`'s binary on
# purpose. A locally built binary is unsigned, so macOS puts up a keychain
# authorization dialog the first time it reads the credential store — which a
# headless recording can never answer, and the tape hangs. `--env-file=/dev/null`
# turns off Bun's .env autoload so the CLI resolves keys from the project's files
# itself, exactly as the signed release binary does (it is compiled with
# --no-compile-autoload-dotenv). Without it the CLI would report every key as
# coming from an environment variable.
cat > "$here/bin/clerk" <<EOF
#!/usr/bin/env bash
exec bun --env-file=/dev/null run "$repo/packages/cli-core/src/cli.ts" "\$@"
EOF
chmod +x "$here/bin/clerk"
export PATH="$here/bin:$PATH"

shopt -s nullglob
tapes=()
if [ $# -eq 0 ]; then
  tapes=("$here"/tapes/[0-9]*.tape)
else
  for prefix in "$@"; do tapes+=("$here"/tapes/"$prefix"*.tape); done
fi

[ ${#tapes[@]} -gt 0 ] || { echo "no tapes matched" >&2; exit 1; }

for tape in "${tapes[@]}"; do
  echo "==> recording $(basename "$tape")"
  (cd "$here/tapes" && vhs "$(basename "$tape")")
done

echo "==> done, output in $here/out"
ls -la "$here/out"
