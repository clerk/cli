#!/usr/bin/env bash
# Every migration test, in one 1Password session:  bun run test:migrate-live:all
#
# Runs each source's variations on the dev instance, then the 1K run on the
# raised-limit dev instance and the 10K run on production. A failing source
# doesn't stop the rest. Everything goes in one batch folder, stamped when this
# starts: test-results/<stamp>-all/summary.md lists each run's exit code, and
# each run's report is test-results/<stamp>-all/<provider>-<target>/report.md
# (its CLI runs under clerk-runs/<stamp>-all/ the same way).
#
# Expects the env vars to be set: the root package.json script runs it under
# `op run` (scripts/run-migrate-live-op.ts), and CI passes them as secrets.
#
# Arguments are passed to every test-migrate.ts run, e.g. a CLI checkout other
# than DEFAULT_CLI:  bun run test:migrate-live:all --cli <path/to/cli.ts>
set -u
# Ctrl-C ends the batch, not just the current run: test-migrate.ts exits 130
# on SIGINT instead of dying by it, so bash would otherwise start the next one.
trap 'echo; echo "Interrupted: batch stopped"; exit 130' INT
cd "$(dirname "$0")"
EXTRA=("$@")
# test-migrate.ts puts each run in a sub-folder of this batch.
export MIGRATE_BATCH="$(date -u +%Y%m%dT%H%M%S)-all"

# Free Supabase projects pause after a week idle; wake it before its turn.
wake_supabase() {
  local ref status
  ref=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https://([^.]+)\..*#\1#')
  for i in $(seq 1 40); do
    status=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "https://api.supabase.com/v1/projects/$ref" |
      python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))')
    [ "$status" = "ACTIVE_HEALTHY" ] && return 0
    if [ "$i" = 1 ] && [ "$status" = "INACTIVE" ]; then
      echo "Supabase project is paused; requesting a restore"
      curl -s -X POST -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "https://api.supabase.com/v1/projects/$ref/restore" >/dev/null
    fi
    echo "Supabase status: $status (waiting)"
    sleep 15
  done
  echo "Supabase never became healthy"
  return 1
}

declare -a summary
run() {
  local label=$1; shift
  echo; echo "=== $label  $(date +%H:%M:%S)"
  # The +-guard: macOS bash 3.2 treats an empty array as unset under set -u.
  bun test-migrate.ts "$@" ${EXTRA[@]+"${EXTRA[@]}"}
  local code=$?
  summary+=("$(printf '%-24s %s' "$label" "$([ $code = 0 ] && echo pass || echo "FAIL (exit $code)")")")
}

for p in clerk auth0 authjs supabase firebase workos better-auth; do
  if [ "$p" = supabase ] && ! wake_supabase; then summary+=("$(printf '%-24s %s' supabase "SKIPPED (project not healthy)")"); continue; fi
  run "$p" -p "$p"
done
run "better-auth 1K (10k-dev)" -p better-auth -t 10k-dev -v BK1K
run "better-auth 10K (prod)" -p better-auth -t 10k-prod -v BK

echo; echo "=== Summary"
printf '%s\n' "${summary[@]}"
mkdir -p "test-results/$MIGRATE_BATCH"
{ echo "# test:migrate-live:all — $MIGRATE_BATCH"; echo; echo '```'; printf '%s\n' "${summary[@]}"; echo '```'; } > "test-results/$MIGRATE_BATCH/summary.md"
echo "Batch: test-results/$MIGRATE_BATCH/"

# Fail the batch when any run failed or was skipped, so CI goes red and Slack fires.
printf '%s\n' "${summary[@]}" | grep -qE 'FAIL|SKIPPED' && exit 1
exit 0
