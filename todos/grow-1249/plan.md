# Unclaimed-app advice and claim-first `clerk link`: implementation plan

Date: 2026-10-17, revised 2026-10-19 with Shane's decisions. Base: `origin/main` at `2133e7ea3` (CLI 4.0.0 plus canary commits). Status: draft for Shane's review. Covers two CLI PRs in this repo; the matching `clerk/skills` PR is summarized at the end.

## What this plan fixes

A folder that has a Clerk app but no link to one gets the same advice from every command, and following it often links the wrong app. For example, someone ran `clerk init` while signed out, so `init` created an unclaimed app and wrote its keys to `.env.local`. Later, signed in, they run `clerk deploy`. It prints "Run `clerk link`". They run `clerk link`, which shows a picker of the apps in their account. The app their code uses isn't in that list, because it was never claimed. They pick one, the folder is now linked to that other app, and `clerk deploy` prepares the other app for production while `.env.local` still holds the original app's keys.

Terms used throughout:

- **Linked**: the CLI's config file records which Clerk app this folder uses (`resolveProfile` in `lib/config.ts` finds it by git remote, git repo, or a parent directory).
- **Unclaimed app**: a Clerk app that belongs to no account yet. Claiming moves it into the signed-in person's account.
- **Init token**: the claim token `clerk init` saves in `.clerk/keyless.json` when it creates an unclaimed app. `clerk auth login` redeems it to claim the app (`lib/autoclaim.ts`).
- **SDK keyless file**: `.clerk/.tmp/keyless.json`, which a Clerk SDK such as `@clerk/nextjs` writes when it creates an unclaimed app for itself during `next dev`. It holds that app's keys and a full claim URL. The CLI can't claim it, because there is no token; the person claims it in the Dashboard. `clerk open` prints or opens that URL, and after PR 1 a person's `clerk link` opens it.
- **SDK-only folder**: a folder with no init token and no plain key of either kind, whose SDK keyless file holds a publishable key. An SDK keyless file without a publishable key doesn't make a folder SDK-only; `clerk link` stops on it with the "no usable claim link" message (milestone 4).
- **Plain keys**: a Clerk secret or publishable key in an env var, `.env`, or `.env.local`, with no init token. Nothing local says whether that app is in an account. The CLI's only call with the key, `GET /v1/instance`, can't tell either.
- **Signed in**: `hasAccountCredentials()` in `lib/credential-store.ts` returns true (a stored OAuth session or `CLERK_PLATFORM_API_KEY`). It checks presence only. When `CLERK_PLATFORM_API_KEY` is set, every Platform API call uses it, including the claim (`lib/plapi.ts:41-49`), so a claim goes to that key's workspace even when a person is also signed in with a different account.
- **The folder's keys**: the publishable and secret key the folder's app actually loads, read by one shared reader defined in "Conventions both PRs share". Every milestone that needs "the folder's key" uses that reader.
- **Person** and **agent**: the CLI's two modes (`src/mode.ts`). Agent mode is the default without a TTY and for Codex runs; it prints errors as one JSON line on stderr.

The work ships as two stacked PRs:

- **PR 1 (behavior)** makes `clerk link`, `clerk auth login`, and `clerk init` claim or match the folder's own app, and stop instead of linking a different one.
- **PR 2 (messages)** adds one shared classifier of unlinked folders and routes every "run `clerk link`" and "`clerk auth login` will claim it" message through it.

PR 2 depends on PR 1: several PR 2 messages are only true after PR 1 (for example, "run `clerk link`" for a signed-in person with an init token, because only PR 1 makes `clerk link` claim that app).

## Decisions still open

Each needs Shane's answer. None changes the milestone structure, and none blocks a milestone. The decisions Shane has already made are under "What's decided".

1. **Does claiming keep the app's keys?** The guard in milestone 2 compares the claimed app's keys with the folder's. If claiming issued new keys, the guard would refuse every legitimate link.
   - Evidence from the backend source (`~/repos/clerk_go` at `882f4439`, 2026-09-10): the claim changes only the claim token, creator, name, claim time, ownership, and a subscription flag (`api/shared/applications/service.go:250-288`), never instances or domains. The claim response serializes the app with its keys (`api/platform/v1/platform/applications.go:1343`), and the backend's test asserts `instances[0].publishable_key` and `secret_key` are present (`tests/platform/platform_accountless_applications_test.go:54-56`).
   - **Proceed on that evidence:** the remaining risk is that the checkout is five weeks old.
   - **Ask the team that owns the claim endpoint first:** costs a round trip.
   - **Recommendation: proceed; a confirmation from the owning team is optional.**
2. **Keep the picker when plain keys match no app in the account?** A person can still link a different app there (row 7 of the state table).
   - **Recommendation: keep it and record it as a known limitation.** Plain keys are often Dashboard keys from another workspace, and the picker is how people deliberately switch apps.
3. **How far the skills PR goes.** Approved: `auth.md:95`, `auth.md:171`, `agent-mode.md:274`, `agent-mode.md:71`. Three more passages say "`clerk auth login` claims it" with no condition: `clerk-setup/SKILL.md:203` and `:205`, and `clerk-cli/references/agent-mode.md:286`.
   - **Recommendation: include those three**, because they give the same wrong advice for SDK-created apps. Both plan reviewers agree. Leave the passages that describe `clerk link --app <id>` as the deterministic path for agents, because they are accurate for apps already in an account.
4. **Ship order between the CLI PRs and the skills PR.** Shane decides. No recommendation.
5. **The five working decisions** under "What's decided" (doctor output, error codes, local-only classification, telemetry deferred, extra message sites) still need Shane's confirmation.

## What's decided

**Approved by Shane:**

- Three tickets: a new bug ticket for PR 1, GROW-1249 rewritten for PR 2 and the skills PR, and a telemetry follow-up.
- Two CLI PRs and one skills PR, with one plan file covering both CLI PRs.
- The scope of PR 1 and PR 2 as listed in the milestones below.
- The verified state table below replaces GROW-1249's four-message model.

**Decided by Shane on 2026-10-19:**

- **Ask before any claim.** One prompt, in both `clerk auth login` (milestone 3) and a person's `clerk link` (milestone 4), naming the destination the claim will actually use: the signed-in account's email, or "the workspace your `CLERK_PLATFORM_API_KEY` belongs to" when that key is set. When the key is set, the prompt doesn't offer "sign in as someone else", because signing in again wouldn't change where the claim goes. Default Yes. Declining stops `link` without showing the picker. Agents can't answer prompts, so they claim silently, as `clerk auth login` does today.
  - **Scope** (settled by the orchestrator as following from Shane's decision): "any claim" means every claim a person triggers. That includes a signed-out person's direct `clerk auth login` (the prompt comes after the browser sign-in), `clerk migrate --app` (which keeps login's own claim), and a person with only `CLERK_PLATFORM_API_KEY` set. The prompt appears when either credential exists; with only the key, Yes claims with no browser step. The exceptions are `clerk auth login -y` and agent mode, which claim without the prompt.
- **Error and exit codes for `clerk link`'s new outcomes reuse existing codes:**
  - **An agent in an SDK-only folder with no matching app** (it stops and says to run `clerk open`): `usage_error`, exit 2, matching agent-mode `clerk link`'s existing error.
  - **An agent in an SDK-only folder whose app list failed** (signed out, expired session, server error): the same `usage_error`, exit 2, with the "list failed" reason in the wording (milestone 6). This keeps today's code at this site; settled by the orchestrator under the working rule that codes stay the same at existing sites.
  - **A folder whose SDK keyless file has no usable claim link** (no publishable key, no `claimUrl`, or one that isn't https), either mode: `usage_error`, exit 2.
  - **A refused claim** (managed workspace or no organization): `not_linked`, exit 1, because the folder stays unlinked.
  - **A temporary claim failure:** the original API or auth error, unchanged.
  - **A person in an SDK-only folder after `link` opened the claim page** (the "claim it, then rerun me" run): no thrown error, so no `error:` line and no JSON error. Exit 1, set through `process.exitCode` the way `clerk deploy status` reports an unfinished deploy (`deploy/status-command.ts`, `lib/telemetry.ts:295-317`). Telemetry records outcome `incomplete` with `error_code: not_linked`. Exit 1 because nothing was linked: `clerk link && clerk deploy` must stop there, since `deploy` would only fail with `not_linked`. It isn't a usage error (exit 2), because the person invoked the command correctly and it did its part. Agents never take this path, and nothing is printed on stdout, so a script sees only exit 1 and the text on stderr.
  - **A person who declines the claim prompt:** a user abort (exit 0, telemetry `abort`) via `throwUserAbort`. The reason for exit 1 above applies here too, since nothing was linked, but the CLI-wide convention wins: every declined prompt in the CLI exits 0 as a user abort, and this one shouldn't be the exception.
- **`clerk link` matches on the key the app actually loads, everywhere:** the shell env var, then `.env.local`, then `.env` (shared rule 2). This is a deliberate behavior change for existing folders with different keys in `.env` and `.env.local`. Tradeoff accepted: such a folder whose `.env` key is in the account but whose `.env.local` key isn't stops auto-linking. Its app runs on `.env.local`, so the old auto-link targeted the wrong app. It also prevents a sequence PR 1 would otherwise create: `.env` holds app A's key, `.env.local` holds app B's, the folder has an init token for A, the claim moves A into the account, the guard rejects A, and the old matcher then links A from `.env`.
- **SDK-only folder, when its key matches no app in the account:**
  - **A person's `clerk link`** opens the Dashboard claim page in the browser, using the claim URL from the SDK keyless file. It reuses `clerk open`'s reader, which accepts only https URLs (`commands/open/keyless-claim.ts:37-99`). It prints that the app isn't in an account yet, and to claim it into the account the rerun will search and then rerun `clerk link`. It never prints the URL.
  - **An agent's `clerk link`** stops and says to run `clerk open`.
  - No prompt and no picker in either mode. On the rerun, `link` matches the SDK file's key against the account and links the claimed app (milestone 4).
- **`whoami` is in PR 2's scope** (milestone 8).

**Recommended by the orchestrator, Shane to confirm at plan review:**

1. `doctor`'s output changes where it's wrong. GROW-1249's "byte-identical" rule is dropped. `doctor`'s check statuses (`pass`, `warn`, `fail`) and `fix` labels stay the same; only message and remedy text change.
2. Error codes and exit codes stay the same at every existing site. Agent-mode JSON errors gain an `examples` list with the runnable next command.
3. Classification uses local files and credential presence only. No new API call on any error path.
4. Telemetry is deferred to a follow-up ticket.
5. The extra message sites (the generic not-linked error in `lib/config.ts`, `clerk open`, the "covers fewer settings" warning, `lib/copy.ts`, `lib/keyless-target.ts:239`, `init/heuristics.ts:168`, and the `env pull` and `copy.ts:43-44` sites found in plan review) are in PR 2's scope. `whoami` is also in scope, by Shane's decision.

**Planner decisions inside the approved scope.** Reviewers can override any of these. Each must be recorded in a code comment where it's implemented, because none of them can be recovered from the code alone.

- **The guard runs after the claim, not before.** The init token file holds only `{ claimToken, createdAt }` (`lib/keyless.ts:21-24`), with no app identity, so it's impossible to know before claiming which app the token belongs to. Checking after the claim needs no file-format change and protects every token already on disk. The cost is that a mismatched old app still gets claimed into the account. That's harmless, because the app is the person's.
- **"Same app" means every key the folder holds matches the claimed app.** The publishable key matches when its Frontend API host equals the host of one of the claimed app's instances: decode both with `decodePublishableKey` (`lib/fapi.ts`), the identity rule `hasKeyPairMismatch` in `lib/keyless-target.ts:150-202` already documents. The secret key matches when it equals one instance's secret key exactly. That comparison happens in memory only; the secret key is never logged or put in a message. Checking both keys, not just the publishable one, stops a folder that pairs one app's secret key with another app's publishable key from passing. A key that can't be compared (undecodable, or the claimed app's instance lacks that key) is "couldn't tell", not "no key".
- **The lead sentences of not-linked errors stay verbatim**: "No Clerk project linked to this directory." and "Cannot select an application in agent mode." Only the advice after them changes. The skill's troubleshooting table keys on the first sentence, and agents match on both.
- **`examples` is attached only in agent mode.** In person mode, `reportError` (`cli-program.ts:302-321`) prints an "Examples:" block under the message, which would repeat the commands the message already names.
- **Error messages and `clerk link`'s output never print a claim URL.** The URL carries a credential-equivalent token (the skill's `auth.md:48` says the same). `clerk link` passes it only to the browser launcher. `clerk open` is the one command that shows it, and only when asked: it prints the URL in every mode, and `clerk open --print` prints only the URL. Messages that need a person to see the URL point at `clerk open --print`.
- **The classifier reads the current directory only.** That's how the init token reader and the local key lookup already work. Running from a subdirectory of a monorepo classifies as "no app", whose wording ("`clerk link` to choose an app, or `clerk init` to create one") is safe.
- **`clerk auth login -y` keeps today's order**: browser sign-in, then claim, with no prompt. Someone passing `-y` asked to sign in again, possibly as someone else, and to skip confirmations.

**Backward compatibility.** No stored data or token-file format changes. Agent JSON gains an additive `examples` field. These behavior changes are visible to callers, all decided by Shane:

- A person's `clerk link` in an SDK-only folder with no matching app opens the claim page and exits 1 instead of opening the picker. An agent's still exits 2 with `usage_error`, now with advice to run `clerk open`.
- A person's `clerk auth login` with an init token asks one question naming the claim's destination before any claim: in place of "Re-authenticate?" when already signed in, before any browser step when only `CLERK_PLATFORM_API_KEY` is set, and after the browser sign-in when signed out.
- A person's `clerk link` with an init token asks the same question before claiming. Declining stops `link` without the picker.
- `clerk link` in a folder with different keys in `.env` and `.env.local` matches on `.env.local`'s key instead of trying `.env` first.
- `clerk auth login` called by `init`, `migrate`, or `link` on their way to linking no longer claims by itself; `link` claims instead (milestone 4). A direct `clerk auth login` still claims, after the prompt above.

Internal signatures change (`AutoclaimResult`, the `lib/copy.ts` message functions). Nothing outside this package imports them.

## Read before starting

- `AGENTS.md`, `CONTRIBUTING.md`, and `docs/releasing.md` in this repo.
- `.claude/rules/errors.md`, `logging.md`, `debug-logging.md`, `commands.md`, `changesets.md`, `promises.md`.
- The READMEs of the commands this touches: `packages/cli-core/src/commands/{auth,link,deploy,doctor,open,init}/README.md`.
- The header comment of `packages/cli-core/src/test/integration/lib/harness.ts`, which explains how the harness mocks credentials, HTTP, OAuth, prompts, and the config directory.
- GROW-1249's evidence: [Walkthrough](https://app.notion.com/p/3db2b9ab44fe8198b7ddcd520562a49a) (Flag 5) and [Improvement plan](https://app.notion.com/p/3dc2b9ab44fe816ea395cd4c42e5cb6d) (Theme 1, item 2).
- Related tickets: [GROW-1235](https://linear.app/clerk/issue/GROW-1235/fix-misleading-and-missing-text-in-the-clerk-deploy-wizard-and-help) (deploy wording, done) and [GROW-1242](https://linear.app/clerk/issue/GROW-1242/clerk-init-and-clerk-doctor-dont-say-what-state-the-project-is-in-or) (backlog; it rewrites `printKeylessInfo` in the same file as milestone 9's `printExistingKeylessInfo` change).
- The first verifier's run log, if it still exists: `/tmp/clerk-cli-verification-2133e7ea3.txt`. It holds the captured output and request paths for the rows marked "ran (log)" below. Rows marked "ran (report)" come from the second verifier's written report, which kept no log.
- For open decision 1, the backend claim code in `~/repos/clerk_go` (files named there).

## The state table reviewers must check

Today, `clerk deploy` and `clerk deploy status` print the same error in every row below, in both modes, with exit 1 and error code `not_linked`: "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy`." (or `clerk deploy status`). Two verifiers ran all five starting states through the integration harness at `2133e7ea3`. They used mocked credentials, HTTP, OAuth, prompts, and browser, so nothing touched a real account. `deploy` made no API call in any of them.

In the Evidence column, "ran (log)" means the first verifier executed that cell through the harness and the run log holds the output. "Ran (report)" means the second verifier executed it and described the result in its report, with no log kept. "Read" means it's inferred from the code.

### What `clerk link` does today, after PR 1, and what `deploy` will advise after PR 2

| #   | Folder (not linked)                                                   | Signed in | Person runs `clerk link` today                                                                                             | Agent runs `clerk link` today                                                             | `clerk link` after PR 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `deploy` advises after PR 2                                                                                                                                              | Evidence                            |
| --- | --------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 1   | Init token, init's keys in `.env`                                     | No        | Works: signs in, sign-in claims the app, links it                                                                          | `usage_error`, exit 2. The suggested `clerk apps list --json` fails with `auth_required`. | Person: signs in, asks before claiming (naming the destination), then claims and links. Declining, a refused claim, or a failed claim stops; none falls through to the picker. Agent: unchanged (it can't sign in); PR 2 rewords.                                                                                                                                                                                                                                                           | People: `clerk link` (it signs in, claims, and links). Agents: `clerk auth login`.                                                                                       | ran (log)                           |
| 2   | Init token, init's keys in `.env`                                     | Yes       | Picker without the app. Picking another app links it; `.env` keeps the original keys; `deploy` then targets the other app. | `usage_error`, exit 2                                                                     | Claims first and links the init app. A person is asked first (declining stops); an agent claims silently. No picker.                                                                                                                                                                                                                                                                                                                                                                        | `clerk link` (after PR 1 it claims the app first)                                                                                                                        | ran (log)                           |
| 3   | SDK keyless file only                                                 | No        | Signs in, nothing to claim, picker, links another app                                                                      | `usage_error`, exit 2                                                                     | Person: signs in, then matches the SDK file's key against the account. A match is linked. No match after a successful app list: opens the claim page in the browser without printing its URL, says to rerun `clerk link` after claiming, and exits 1. A failed app list: stops with the original error, never the picker. Agent: it can't sign in, so its app list fails; it still exits 2 with `usage_error` as today, and PR 2's wording names the failed list and says to sign in first. | People: `clerk link` (it opens the claim page; rerun it after claiming). Agents: `clerk open` for a person to claim the app, then `clerk auth login`, then `clerk link`. | today ran (log); after PR 1 read    |
| 4   | SDK keyless file only                                                 | Yes       | Picker, links another app                                                                                                  | `usage_error`, exit 2, no API call                                                        | Matches the SDK file's key. A match is linked. No match after a successful app list: a person's `link` opens the claim page (no URL printed) and exits 1; an agent's stops and says to run `clerk open`. A failed app list: a person gets the original error; an agent gets `usage_error`, exit 2, with wording that names the failed list. Never the picker.                                                                                                                               | People: `clerk link`, as row 3. Agents: `clerk open` for a person to claim the app, then `clerk link`.                                                                   | today: agent ran (log), person read |
| 5   | Plain keys including a publishable key; the app is in the account     | No        | Works: signs in, detects the key, confirms, links                                                                          | `usage_error`, exit 2                                                                     | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `clerk link` (it finds the app by its publishable key). Agents: `clerk auth login` first.                                                                                | ran (log)                           |
| 6   | Plain keys including a publishable key; the app is in the account     | Yes       | Detects the key, confirms, links                                                                                           | Auto-links ("Auto-linked to My SaaS App")                                                 | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | same as row 5                                                                                                                                                            | agent ran (log), person read        |
| 7   | Plain keys including a publishable key; the app is not in the account | Either    | Picker; can link another app                                                                                               | `usage_error`, exit 2                                                                     | unchanged (open decision 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | same as row 5, plus "if `clerk link` finds no match, no app in this account uses this key; link one with `clerk link --app <app_id>`"                                    | read                                |
| 8   | Plain secret key only (no publishable key)                            | Either    | Picker; key detection never runs, because it reads only publishable keys                                                   | `usage_error`, exit 2                                                                     | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | People: `clerk link`, then choose the app from the list. Agents: `clerk apps list --json`, then `clerk link --app <app_id>` (signed out: `clerk auth login` first).      | read                                |
| 9   | No keys                                                               | No        | Signs in, then picker (pick or create)                                                                                     | `usage_error`, exit 2. `clerk apps list --json` fails with `auth_required`.               | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `clerk link` to choose an app, or `clerk init` to create one. Agents: `clerk auth login` first.                                                                          | ran (log)                           |
| 10  | No keys                                                               | Yes       | Picker                                                                                                                     | `usage_error`, exit 2. Its `clerk apps list --json` advice works.                         | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Agents: `clerk apps list --json`, then `clerk link --app <app_id>`, or `clerk init` to create an app. People: as row 9.                                                  | read                                |

Rows 5, 6, and 7 look identical to the CLI without an API call, so PR 2 gives them one message: the "ownership unknown" wording for a folder with a publishable key. A folder with only a publishable key belongs in rows 5 to 7. Row 8 gets its own wording because `clerk link` matches only publishable keys (`lib/autolink.ts:21-55`). `deploy` has no `--app` option (ran (log): `error: unknown option '--app'`), so no `deploy` message may suggest `deploy --app`.

### Claims and `init` reruns that currently link or overwrite the wrong app

| Situation                                                                                                                   | Today                                                                                          | After PR 1                                                                                                                                                                                                  | Evidence           |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Person, signed in, init token, runs `clerk auth login` and answers No to "Re-authenticate?"                                 | Exit 0, no claim, token kept                                                                   | Asks one question naming the destination, in place of "Re-authenticate?"; Yes claims with the current session                                                                                               | ran (log)          |
| Person, signed in, init token, `clerk auth login -y`                                                                        | Signs in again in the browser, then claims and links                                           | unchanged                                                                                                                                                                                                   | ran (log)          |
| Agent, signed in, init token, `clerk auth login`                                                                            | Claims and links, no prompt                                                                    | unchanged, plus the guard                                                                                                                                                                                   | ran (report)       |
| Folder linked to app B and `.env` holds app B's keys; a leftover init token belongs to app A; agent runs `clerk auth login` | Claims A, relinks the folder to A, and `.env` flips to A's keys                                | Claims A, leaves the link and `.env` on B, and says so                                                                                                                                                      | ran (log)          |
| Dashboard keys pasted into `.env`; a leftover init token; signed-in agent runs `clerk auth login`                           | Claims the old app, relinks to it, and replaces the pasted keys                                | Claims the old app, leaves the link and `.env` alone, and says so                                                                                                                                           | ran (report)       |
| Person, signed in, init token, reruns `clerk init`                                                                          | Picker, links another app, and writes its keys over `.env.local`                               | Claims and links the init app. No picker.                                                                                                                                                                   | ran (log)          |
| Agent, signed in, init token, reruns `clerk init` (Next.js)                                                                 | Creates a new app, links it, writes its keys; a later `clerk auth login` flips everything back | Claims and links the init app. No create call.                                                                                                                                                              | ran (report)       |
| Agent, signed in, SDK keyless file only, runs `clerk init` (Next.js)                                                        | Creates a new app                                                                              | Links the SDK app if it's in the account; otherwise stops with "`clerk open` to claim it" (`usage_error`, exit 2). A failed app list stops the same way, naming the failed list. No create call either way. | today ran (report) |
| Person, signed in, SDK keyless file only, runs `clerk init`                                                                 | Picker; links another app, then writes its keys into the env file                              | Links the SDK app if it's in the account. Otherwise `link` opens the claim page, and `init` stops with exit 1 before pulling keys. No picker, no create call.                                               | today read         |
| Agent, signed in, no keys, runs `clerk init` (Next.js)                                                                      | Creates a new app (no app list call); on React, prints manual setup                            | unchanged (creating is what `init` is for here)                                                                                                                                                             | ran (log)          |

### Other messages that are wrong today

| Site                                                                                                                            | Situation                            | Today                                                                                                                                                                                                                                                  | Evidence     |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `doctor`                                                                                                                        | Signed out, Dashboard keys in `.env` | Both checks call the app "the unclaimed accountless application" and say "Claim it from the Clerk Dashboard"                                                                                                                                           | ran (log)    |
| `doctor`                                                                                                                        | Signed in, init token                | "Project linked" warns with remedy "Run `clerk link` to use the full account configuration", which leads to row 2's picker                                                                                                                             | ran (log)    |
| `config pull` warning                                                                                                           | Signed in, an unclaimed app's keys   | "Run `clerk link` (or pass --app <app_id>)"                                                                                                                                                                                                            | ran (report) |
| `clerk open`                                                                                                                    | Plain keys, no claim link on disk    | Advises `clerk init --accountless` to "regenerate a claim link". That creates a new app and overwrites the `.env` keys, because `init`'s keep-the-existing-app check only looks for the init token and the SDK keyless file (`init/index.ts:651-697`). | read         |
| `lib/copy.ts:33, 43-44, 50, 54, 58, 62`, `lib/keyless-target.ts:239`, `init/heuristics.ts:168`, `commands/env/pull.ts:149, 166` | Any folder without an init token     | "Run `clerk auth login` to claim it" (or "claim it first with `clerk auth login`"), which doesn't claim an SDK-created app or prove anything about plain keys. Several of these also open with "unclaimed" when the only evidence is a plain key.      | read         |
| `whoami` (in PR 2)                                                                                                              | Signed out, any local key            | Calls the app "an unclaimed accountless application" and suggests `clerk open`                                                                                                                                                                         | read         |

## Conventions both PRs share

Four shared rules come first. Each fixes a class of defect the plan review found more than once, so every milestone follows them and none reinvents them.

1. **Every check has three outcomes: yes, no, or couldn't tell.** "Couldn't tell" covers missing data, a failed API call, a key that can't be decoded, and an app list that came back empty because of a server error. "Couldn't tell" never relinks a folder, never overwrites keys, and never tells someone the app isn't in their account. Each check in milestones 2, 4, and 5 states what it does on "couldn't tell".
2. **One reader for the folder's keys, by source.** Milestone 2 adds it; milestones 4 and 5 reuse it.
   - It returns the folder's publishable key and secret key separately, each with where it came from.
   - Plain keys come in the order the app itself loads them: the env var first, then `.env.local` over `.env`, framework-specific names over generic ones. This is the order `findKeyInProject` in `lib/keyless-target.ts:85-117` already uses.
   - The SDK keyless file counts only when the folder has no plain key of either kind. Then both keys come from that file. The reader never pairs a plain key with a key from the SDK file.
   - It lives in a leaf module that doesn't import `lib/config.ts`, directly or through `lib/keyless-target.ts`, because milestone 8 calls it from `lib/config.ts`. Moving the existing local-key helpers there and re-exporting them from `keyless-target.ts` keeps existing importers unchanged.
   - `clerk link`'s key matcher uses this reader for every folder (decided by Shane; see "What's decided").
3. **The list of message sites comes from a search, not by hand.** PR 2's definition of done reruns these three searches from the repo root and accounts for every hit: fixed, or listed with the reason it's out of scope (see "PR 2 wrap-up").

   ```sh
   git grep -nE 'clerk link`' -- packages/cli-core/src ':!*.test.ts' ':!*.md'
   git grep -niE 'auth login.{0,80}claim|claim.{0,80}auth login' -- packages/cli-core/src ':!*.test.ts' ':!*.md'
   git grep -n 'unclaimed' -- packages/cli-core/src ':!*.test.ts' ':!*.md'
   ```

   The second search catches reversed wording such as "claim it first with `clerk auth login`" (`lib/copy.ts:44`).

4. **Advice is tested by following it.** For each situation in the state table, one integration test runs the commands the new advice names, in order, and asserts where the folder ends up: linked to the right app, or still unlinked with a next step that isn't the command that just ran.

The remaining conventions:

- **Tests.** Every new test that reproduces a bug from the tables above must be run against `origin/main` first and seen to fail. Note the failure in the PR description. A test that has never failed may not be checking anything.
- **Browser.** The integration harness doesn't stub `lib/open.ts` today. Milestone 1 adds that stub. Any test that walks through sign-in must run with it.
- **Credentials in unit tests.** `deploy`'s unit tests use a real temporary config directory and don't mock the credential store. Code that checks sign-in on those paths must be tested with `_setTokenOverride` (`lib/credential-store.ts:459`) or a module mock. Otherwise the test reads the developer's real keychain.
- **Name the credential in every "signed in" test.** The integration harness sets both `CLERK_PLATFORM_API_KEY` and a stored session by default (`test/integration/lib/harness.ts:586-590`), which hides behavior that differs between them: `clerk auth login` checks only for a stored session (`commands/auth/login.ts:36-47`), while the claim uses the API key when it's set. Each test says which credential it uses: stored session, API key, or both.
- **Rationale in code.** Each non-obvious rule in this plan goes into a comment at the code that enforces it. Examples: why the guard runs after the claim, why "same app" means the same Frontend API host, and why the lead sentences stay verbatim.
- **Checks before handing over each PR.** Run `bun run format`, `bun run lint`, `bun run typecheck`, `bun run test`, and `bun changeset status --since=origin/main`. The E2E suite (`bun run test:e2e:op`) doesn't exercise any of these paths: its fixtures pre-link with `clerk link --app`, and nothing in it claims. Don't count it as coverage.
- **Changesets.** Each PR is a user-facing fix. Create its changeset with the repo's `changesets` skill (`/changesets create`), as `.claude/rules/changesets.md` requires.
- **Working rules.** Don't commit, push, or open a PR until Shane approves after review. PR 1 needs its own branch from `origin/main`, named after the new ticket. PR 2 continues on `shane/grow-1249-clerk-deploy-deploy-status-and-link-tell-unclaimed-apps-to`, rebased onto PR 1's branch.
- **Real runs.** A from-source run on macOS uses the `clerk-cli-dev` keychain namespace, which may hold a real session. Don't run `link`, `auth login`, `init`, `open`, or `doctor` from source against a real account. Use the integration harness for every state. A real claim needs Shane's approval and a throwaway account.

---

## PR 1: `link`, `auth login`, and `init` claim or match the folder's own app

### Milestone 1: the integration harness stubs the browser launcher

This milestone is small. It makes two harness changes; no integration test references `openBrowser` or a soft exit code today, so nothing else changes.

- **A browser stub.** The harness gains a module mock for `lib/open.ts` whose `openBrowser` records the URL and returns success without launching anything. A test can also make it report failure.
- **Soft exit codes.** `execCLI` (`test/integration/lib/harness.ts:478-523`) takes the exit code only from a thrown error or a `process.exit` call, so a command that sets `process.exitCode` and returns (milestone 4's claim-page run) would read as exit 0. The result must read `process.exitCode` when neither happened. Setup and teardown reset `process.exitCode` to 0 (Bun ignores assigning `undefined`; `commands/deploy/status-command.test.ts:128-152` shows the pattern), so one test's soft exit can't leak into the next test or fail the whole `bun test` run.

**Done when:**

- A harness test that runs `clerk auth login` signed out completes.
- The stub recorded the authorize URL.
- No browser opened on the developer's machine.
- A harness test of a command that sets `process.exitCode = 1` and returns reads exit 1, and the next test starts at 0.
- It's a test-only change, so no changeset is needed for it.

### Milestone 2: the shared claim step never relinks a folder or overwrites its keys

**Goal and outcome.** `attemptAutoclaim` in `lib/autoclaim.ts` is the one routine that claims an init app, links the folder, and pulls its keys. Both `clerk auth login` and (after milestone 4) `clerk link` call it. After this milestone:

- A claim whose app matches the folder's keys links the folder and pulls keys, as today.
- A claim whose app doesn't match the folder's keys still claims (the token is spent) but leaves the folder's link and env files untouched, and the command says so and names the next step.
- A claim in a folder already linked to a different app leaves that link and the env files untouched, and says so.
- A failed or refused claim behaves as today.

**Implementation outline.**

1. **Add the shared key reader** (shared rule 2) in its own leaf module.
2. After a successful claim and before `linkApp` and `pull`, decide whether to set up the folder. In this order:
   - **The folder is linked to a different app** (`resolveProfile(cwd)` returns a profile whose `appId` differs from the claimed app): leave it, with reason "linked elsewhere".
   - **The claim response lacks the keys to compare** (no `instances` array, which `login.ts` already tolerates, see `login.test.ts:729`; or an instance without the key kind needed): fetch the app once, which returns keys. If the fetch fails or still lacks them: leave the folder, with reason "unverified".
   - **Read the folder's keys** with the shared reader and compare every key it returns, using the identity rule under "What's decided":
     - Any key that doesn't match: leave the folder, with reason "different keys".
     - Any key that can't be compared (an undecodable publishable key, for example): leave it, with reason "unverified". This is shared rule 1: "couldn't tell" never overwrites keys.
     - Every key matches: link and pull.
     - The folder holds no Clerk key of either kind: link and pull, as today. A folder with no keys is what a claim should set up.
   - A folder holding only a secret key that matches the claimed app now links; one that doesn't match keeps its key.
3. Clear the init token after any successful claim, matched or not, as today. The token is spent either way.
4. Keep `attemptAutoclaim`'s never-throws contract.
5. Extend the result so callers can say what happened. The contract is the point here; the names are the implementer's:

   ```ts
   type Claimed = {
     status: "claimed";
     app: Application;
     local:
       | { kind: "linked"; envPulled: boolean }
       | { kind: "unchanged"; reason: "linked_elsewhere" | "different_keys" | "unverified" };
   };
   ```

6. Update `handleAutoclaim` and `loginNextSteps` in `commands/auth/login.ts` to print the unchanged case:
   - It names the claimed app and where it now lives (the Dashboard URL line printed today).
   - It says the folder's link and keys were left alone, and why.
   - It gives the next step: "Run `clerk link` to link the app this folder's keys belong to" for different keys. For linked elsewhere: "This folder stays linked to `<other>`; run `clerk link --app <claimed id>` to switch". For unverified: it says the CLI couldn't confirm the folder's keys belong to the claimed app, then gives both choices: `clerk link` to link by the folder's keys, or `clerk link --app <claimed id>` to use the claimed app.
   - Add matching `NEXT_STEPS` entries in `lib/next-steps.ts`.

**Definition of done.**

- Unit tests for the shared key reader, over real temporary directories:
  - `.env` and `.env.local` with different keys: `.env.local` wins.
  - An env var beats both files.
  - A plain secret key plus an SDK keyless file: the reader returns the plain secret key and no publishable key; it never pairs it with the SDK file's publishable key.
  - SDK keyless file only: both keys come from it.
- Unit tests in `lib/autoclaim.test.ts`:
  - Matching keys (publishable and secret) link and pull.
  - A different publishable key, or a different secret key, leaves both link and env files alone and reports `different_keys`.
  - A plain secret key for app B next to a stale SDK keyless file for app A, with a claim of A: reports `different_keys`, and B's secret key is unchanged.
  - A secret-key-only folder whose key matches links; one whose key doesn't match keeps its key.
  - An undecodable publishable key reports `unverified` without linking.
  - A folder linked elsewhere leaves both alone.
  - A claim response without keys fetches once and links on a match.
  - A failed fetch, or an instance still missing the key, reports `unverified` without linking.
  - No local key at all links.
  - Each existing failure status is unchanged.
- Integration tests through the harness, reproducing the two "ran" rows. Each must fail on `origin/main` first.
  - **Folder linked to B with B's keys, leftover token for A, agent `clerk auth login`.** Assert:
    - the claim request was sent;
    - the profile in the temporary config still names B;
    - `.env` still holds B's keys;
    - the token file is gone;
    - stderr names A as claimed and says the folder was left alone.
  - **Dashboard keys plus a leftover token, signed-in agent `clerk auth login`.** Assert the pasted keys are unchanged in `.env`.
- `commands/auth/README.md` describes the guard in its autoclaim step.

**What could go wrong.**

- **If the deployed claim endpoint ever issued new keys, the guard would refuse every legitimate link.** The backend source says it doesn't (open decision 1). No harness test can detect this, because the harness returns whatever its mock says; only the owning team or a real claim can.
- **A secret key is compared in memory.** It must never reach a log line, an error message, or telemetry. Say so in the comment at the comparison.
- **A key the reader takes from an env var** set by a parent shell counts as the folder's key. That matches how the rest of the CLI resolves keys, so leave it.
- **The fetch for a response without keys is a new network call** on the claim path. It runs only after a successful claim, so it adds no call on error paths.

### Milestone 3: `clerk auth login` asks before claiming with the current session, and callers can sign in without claiming

**Goal and outcome.** A person whose folder has an init token is asked before `clerk auth login` claims anything, and the question names where the app will go. A signed-in person can claim without signing in again. Commands that sign in on their way to `link` (`init`, `migrate`, and `link` itself) can sign in without the claim, so `link` alone applies the claim policy (milestone 4).

- **The rule** (decided by Shane; scope settled under "What's decided"): in person mode without `-y`, every claim `clerk auth login` makes comes after the destination prompt. Default Yes. With an init token present:
  - **A stored session, no API key:** the prompt replaces "Re-authenticate?": "Claim `<project>` into `<email>`'s account? (No signs you in as someone else first.)". Yes claims with the current session. No runs today's browser sign-in, then asks again, naming the account just signed into.
  - **A stored session and `CLERK_PLATFORM_API_KEY`:** the prompt replaces "Re-authenticate?": "Claim `<project>` into the workspace your `CLERK_PLATFORM_API_KEY` belongs to?". Signing in again wouldn't change the destination, so the prompt doesn't offer it. No ends without claiming (a user abort) and says the key decides where claims go.
  - **Only `CLERK_PLATFORM_API_KEY`, no stored session:** the same key-workspace prompt comes before any browser step. Yes claims with the key, with no browser step. No continues with today's browser sign-in but skips the claim, because a claim would still go to the key's workspace. The token stays on disk, and a line says claims go to the key's workspace while the key is set.
  - **Signed out:** today's browser sign-in runs first, then the prompt names the account just signed into. Yes claims.
  - **Declining after a sign-in has happened** (the last two cases, or the second question in the first case): the sign-in stands, so `clerk auth login` finishes as a success with the claim skipped. The token stays on disk, and the next steps say `clerk link` will claim it later. Declining before anything happened is a user abort.
- **`clerk migrate --app`** keeps login's own claim (milestone 4), so it gets the same prompt in person mode. `migrate` signs in only when it can prompt.
- **Person, no init token:** unchanged. "Re-authenticate?" is asked as today when signed in, and answering No still ends as a user abort.
- **`-y` and agent mode:** unchanged, with no prompt. `-y` signs in again in the browser, then claims.
- **A caller option to skip the claim:** `login()` accepts an option that skips its own claim step and its prompt, and returns without touching the folder. A direct `clerk auth login` never sets it.

**Implementation outline.**

- **One prompt helper.** Put the destination wording and the question in one helper, because milestone 4's prompt in `clerk link` uses the same rule. The wording depends on the effective claim credential: `CLERK_PLATFORM_API_KEY` wins over the stored session for every Platform API call (`lib/plapi.ts:41-49`). Don't change that precedence; it would be a compatibility change.
- **Three places in `runLogin`** (`commands/auth/login.ts:206-275`) ask it, when the mode is person, `yes` is false, and an init token is present (`peekKeylessBreadcrumb(process.cwd())`):
  - an existing stored session: in place of the "Re-authenticate?" confirm;
  - only `CLERK_PLATFORM_API_KEY` (`getExistingSession` finds no stored session, `login.ts:36-47`): before `performOAuthFlow`;
  - after `performOAuthFlow`: before `handleAutoclaim`.
- **Yes** runs `handleAutoclaim` and finishes with `loginNextSteps(claimResult)`. After a `failed` or `managed_workspace` result the token is kept, so the next claim attempt retries, which is today's retry behavior.
- **The skip-claim option** skips the prompt and `handleAutoclaim` in every place `runLogin` would run them.

**Definition of done.**

- Update `login.test.ts`:
  - Person, session, and token: the prompt replaces "Re-authenticate?", defaults to Yes, and names the email (stored session only) or the API key's workspace (API key set). Yes claims with the current session; no browser flow runs.
  - Stored session only, No: the browser flow runs, then a second prompt names the new account; Yes claims, No finishes as a success with the token kept.
  - Both credentials set: the wording names the API key's workspace, "sign in as someone else" isn't offered, and No ends as a user abort with no claim request.
  - API key only, with a token: the prompt comes before any browser step. Yes claims with no browser flow (`performOAuthFlow` isn't called). No runs the browser flow, sends no claim request, and keeps the token.
  - Signed out, with a token: the prompt comes after the browser flow and names the account just signed into. No finishes as a success with the token kept and no claim request.
  - Person, session, and no token still asks "Re-authenticate?" and throws on decline (keep the test at `login.test.ts:613`).
  - `-y` with a token claims after the browser flow, not before.
  - Agent mode is unchanged.
  - The skip-claim option: no claim request, the token stays on disk.
- An integration test reproducing "person, signed in, init token" must fail on `origin/main` first. It answers Yes to the destination prompt. Assert:
  - the claim request was sent;
  - the profile names the init app;
  - the token file is gone;
  - the exit code is 0.
- An integration test with only `CLERK_PLATFORM_API_KEY` and a token, answering Yes: the browser stub (milestone 1) recorded no authorize URL, and the claim request was sent.
- `commands/auth/README.md` describes the new behavior.

**What could go wrong.**

- **A person who answers Yes without reading** claims into the named account. The prompt names it so that this is a choice, not a surprise; that's the cost of defaulting to Yes.
- **The prompt text is a new contract for anyone driving the CLI through a TTY** (an expect-style script). Note the changed prompt in the PR description.

### Milestone 4: `clerk link` claims first, matches the key the app loads, and sends SDK-created apps to the claim page instead of guessing

**Goal and outcome.** `clerk link` links the app the folder actually runs on, or tells the person how to claim it. `clerk init` and `clerk migrate` link through `link()`, so they get the same protection. Every error and exit code below follows Shane's decision under "What's decided".

- **Not linked, init token, no `--app`, signed in:** `link` claims the init app and links it. This fixes row 2 and both `init` rerun rows.
  - A person first gets the destination prompt, using milestone 3's wording helper. Default Yes. Declining is a user abort: `link` stops without the picker. Agents claim silently.
- **Not linked, init token, person signed out:** `link` signs in with login's claim skipped (milestone 3's option), then asks and claims as above. One claim policy applies whatever the starting sign-in state, so declining, a refused claim, or a failed claim never reaches the picker. An agent that isn't signed in can't sign in from `link`; its error is unchanged here and reworded in PR 2.
- **What `link` does with each claim result:**
  - **Linked:** success.
  - **Unchanged ("different keys" or "unverified"):** print the claim notice, then continue with key detection on the folder's own keys. Detection is a separate yes-or-no about the folder's own key, so it can still link the right app.
  - **Refused (managed workspace, no organization):** stop with the claim warning, never the picker: `not_linked`, exit 1.
  - **Failed temporarily:** stop with the original error, unchanged.
  - **Stale token (claim returns not found):** continue normally, because the app may already be in the account and detection finds it.
- **Key matching** (decided by Shane): detection matches only the folder's own publishable key from the shared reader, in every folder. That's the key the app loads: the shell env var, then `.env.local`, then `.env`. The matcher no longer tries `.env` after `.env.local` fails to match.
- **SDK-only folder** (decided by Shane). Detection uses the SDK keyless file's publishable key, and only in this case. One test decides "SDK-only" here and in the classifier (milestone 5): no init token, no plain key, and a publishable key in the SDK keyless file.
  - **A match after a successful app list:** links, as for any detected key. This is also what happens when the person reruns `clerk link` after claiming.
  - **No match after a successful app list, person:** `link` opens the Dashboard claim page in the browser, using the claim URL from the SDK keyless file. It prints:
    - that this folder's app was created by the Clerk SDK and isn't in an account yet;
    - that the claim page is open in the browser;
    - to claim it into the account the rerun will search, and then run `clerk link` again. The account comes from milestone 3's destination helper: the signed-in email, or the workspace of `CLERK_PLATFORM_API_KEY` when it's set. Claiming into any other account or workspace leaves the rerun with no match, and it would open the claim page again.
    - It never prints the URL. No prompt and no picker. It ends with exit 1, no thrown error, and telemetry outcome `incomplete` with `error_code: not_linked`.
  - **When no browser can be shown.** `openBrowser` reports failure only when no launcher is on PATH, or when the launcher exits non-zero within 150 ms (`lib/open.ts:124-195`). It can also report success while the person sees nothing: over SSH to a Mac, `open` succeeds and opens the browser on the remote machine's screen.
    - So `link` always adds one line: "If no browser opened on your screen, run `clerk open --print` to print the claim link, open it on any device, then run `clerk link` again."
    - When `openBrowser` reports failure, `link` leads with "Couldn't open a browser here" and gives the same line.
    - Neither message includes the URL. The exit code and telemetry are the same as when the browser opened.
  - **No match after a successful app list, agent:** stops and says to run `clerk open` (which prints the claim link as JSON for a person to open), then `clerk link` once the app is claimed. No browser launch. `usage_error`, exit 2.
  - **No usable claim link:** the SDK keyless file has no publishable key, no `claimUrl`, or a `claimUrl` that isn't https. The CLI can't tell how to claim (shared rule 1). An SDK keyless file without a publishable key lands here even when no other key exists, so `link` never falls through to the picker with nothing to match. Both modes stop with a message that the SDK keyless file has no usable claim link, and offer `clerk link --app <app_id>` to link an existing app instead. No browser launch. `usage_error`, exit 2.
  - **A failed app list** (signed out, expired session, server error): never fall through to the picker or to "create a new app". Today a server error makes the person picker offer only "create a new application" (`lib/app-picker.ts:30-42`), which links a new app while the SDK keeps running the old one.
    - **Person:** stop with the original API or auth error, which says to sign in again or retry.
    - **Agent:** `usage_error`, exit 2, as agent-mode `clerk link` exits today, with the "list failed" reason passed to the wording (milestone 6) so it says to sign in or retry. Row 3 of the state table and milestone 6 describe the same outcome.
  - This applies to a person's detection step, an agent's auto-link, and `init`'s create-if-missing path, before any create call.
- **`link()` tells its callers when it didn't link.** Today `link()` returns nothing either way, and its callers carry on as if the folder were linked; `init` would go on to pull keys (`init/index.ts:182-194, 588-591`). After this milestone `link()` returns an outcome that separates "linked" from "claim page opened, not linked yet".
  - The `clerk link` command maps "claim page opened" to exit 1, as above.
  - `init` and `migrate` stop with the same message and exit code instead of continuing.
  - `doctor --fix` reports the fix as not applied.
- **`--app` given or folder already linked:** no claim, no SDK check. Explicit targets win.

**Implementation outline.**

1. **Auto-link reports why it didn't link.** `autolink()` returns `undefined` today for no keys, a failed app list, and no match alike, and swallows the list error (`lib/autolink.ts:107-147`). Return a result that tells these apart, carrying the list error when there is one. The person path needs the same distinction: `fetchAppsTolerantly` turns a server error into an empty list. This is shared rule 1 applied to detection. PR 2's wording (milestone 6) reads the same result.
2. **Claim-first position.** In `link()` (`commands/link/index.ts:33-111`), right after the existing-profile handling and before the `autolink` call at lines 50-53, add the claim step. It runs when there's no profile, no `options.app`, and an init token is present.
   - **Signed in** (the sense `ensureAuth` already uses: `CLERK_PLATFORM_API_KEY` or a stored token): claim now.
   - **A person not signed in:** call `ensureAuth` with login's claim skipped, then claim.
   - **An agent not signed in:** skip the claim step; the existing agent error follows.
   - The step must come before `autolink`, `createApplication`, and the agent-mode usage error, because `init` calls `link({ skipIfLinked: true, createIfMissing })`.
3. **Reuse the claim routine.** Use `attemptAutoclaim` from milestone 2, and map each result as listed in the outcomes. In person mode, ask the destination prompt (milestone 3's wording helper) before calling it; a declined prompt calls `throwUserAbort()`.
4. **Callers that sign in before calling `link()` pass the skip-claim option**, so `link` alone applies the claim policy:
   - `init` signs in at `resolveAuthLabel` (`init/index.ts:603-610`) before `authenticateAndLink` calls `link()` (`init/index.ts:618-634`).
   - `migrate` signs in at `migrate/run.ts:229-230` before calling `link()` at `:235-237`. It passes the option only on the path that calls `link()` next (no `--app`, folder not linked). With `--app` it keeps login's own claim, which milestone 2's guard protects.
   - Without this, a person whose claim fails during `init`'s sign-in reads "It will be retried on your next `clerk auth login`" (`login.ts:281-282`) and then watches `link` retry immediately.
5. **Match on the folder's own key.** Replace the candidate list in `findClerkKeys` (`lib/autolink.ts:21-55`) with the one publishable key the shared reader returns. For an SDK-only folder, that key comes from the SDK keyless file; otherwise from the plain sources. Never keep a list of fallback candidates: the matcher returns the first candidate that matches (`lib/autolink.ts:72-75`), which is how an unmatched `.env.local` key falls back to `.env`, and how a stale SDK key could follow an unmatched plain key. Both auto-link and the person's detection step (`tryDetectApp`, `commands/link/index.ts:173-183`) use the same key. `link` is the only caller of `findClerkKeys` and `autolink` today.
6. **SDK-only, no match after a successful list.** Act before `pickOrCreateApp`, before `createApplication`, and in place of the agent usage error.
   - **Read the claim URL with `clerk open`'s reader** (`findKeylessClaimUrl`, `commands/open/keyless-claim.ts:81-99`), which accepts only https URLs from the SDK keyless file. Import it or move it to `lib/`; don't write a second reader.
   - **Person:** call `openBrowser(url)` (`lib/open.ts`), print the messages from the outcomes (naming the account with milestone 3's destination helper), and return the "claim page opened" outcome.
   - **Agent:** throw the stop described in the outcomes. No browser launch.
   - **No usable claim link** (no publishable key in the SDK keyless file, or no usable URL): throw the "no usable claim link" stop in either mode. Check this before key detection, so a file without a publishable key never reaches the picker.
   - **Never pass the URL to `log` or into an error message.** `openBrowser` hands it to its launch wrapper as a diagnostics target (`lib/host-execution.ts:81-102, 198-216`). That target can only reach a debug line in agent mode, and agents never launch here, so person-mode `link` is safe. Say so in a comment, and don't add the URL to any new debug line.
7. **Return an outcome from `link()`** and update its callers as listed in the outcomes: the `clerk link` action sets `process.exitCode` and declares the soft-exit telemetry (`declareSoftExitOutcome`, `lib/telemetry.ts:295-302`); `init`, `migrate`, and `doctor --fix` stop or report not applied. Update the comment on `TelemetryOutcome` (`lib/telemetry.ts:39-45`), which says only `clerk deploy status` sends `incomplete`.

**Definition of done.**

- Unit tests in `link/index.test.ts`, which already mocks the credential store, login, autolink, and the API. Each "signed in" test names its credential.
  - Signed in with a token claims before autolink and before the picker, in both modes, once with a stored session only and once with an API key only.
  - A signed-out person with a token signs in with the claim skipped, then `link` claims. A managed-workspace refusal and a server error (500) on that claim never reach `pickOrCreateApp` or `createApplication`.
  - Each claim result maps as listed, including "unchanged" continuing to detection.
  - `--app` and an existing profile skip the claim.
  - A person gets the destination prompt before the claim, with the wording rule from milestone 3. Declining throws a user abort and never calls `pickOrCreateApp`.
  - SDK-only with a match links.
  - SDK-only, person, no match after a successful list: `openBrowser` is called once, with the SDK keyless file's claim URL. Captured stdout and stderr contain neither the URL nor its token. `link()` returns "claim page opened", the command exits 1 without an `error:` line, and no profile is written.
  - The same with `openBrowser` reporting failure: the output leads with "Couldn't open a browser here", names `clerk open --print`, and contains no URL.
  - The claim-page message names the account the rerun will search: the email with a stored session only, the API key's workspace when the key is set.
  - SDK-only, agent, no match: stops with `usage_error`, exit 2, never calls `openBrowser`, `pickOrCreateApp`, or `createApplication`.
  - SDK-only, agent, failed app list: `usage_error`, exit 2, with the "list failed" reason. SDK-only, person, failed app list: the original error. Neither calls `pickOrCreateApp`.
  - SDK keyless file with a `claimUrl` that isn't https, with no `claimUrl`, or with a secret key but no publishable key: stops in both modes with `usage_error`, exit 2, never calls `openBrowser` or `pickOrCreateApp`.
  - SDK-only with a failed list stops with the failure's advice and never calls `openBrowser`, `pickOrCreateApp`, or `createApplication`.
  - An unmatched plain `.env` publishable key next to a stale SDK keyless file whose key matches an account app: `link` doesn't link the SDK app.
  - `.env` holds a key for app A, which is in the account, and `.env.local` holds a key for app B, which isn't: `link` doesn't link A (the decided behavior change).
  - `.env` holds app A's key, `.env.local` holds app B's, init token for A: after the claim leaves the folder unchanged, `link` doesn't link A.
- `init` and `migrate` stop with exit 1 when `link()` returns "claim page opened"; `init` never reaches its key pull.
- Unit tests in `lib/autolink.test.ts`:
  - Each not-linked reason (no keys, list failed, no match).
  - `findClerkKeys` returns only the shared reader's publishable key: `.env.local` over `.env`, and the SDK keyless file's key only for SDK-only folders.
- `init` and `migrate` tests: their sign-in passes the skip-claim option on the paths named above.
- Integration tests reproducing the "ran" rows, each failing on `origin/main` first. Tests that walk through sign-in run with milestone 1's browser stub.
  - **Row 2 (person, signed in, init token, `clerk link`):** assert the claim request, the profile names the init app, `.env` unchanged, and no applications list request.
  - **Person `clerk init` rerun, signed in, init token:** assert the profile names the init app and `.env.local` still holds its keys.
  - **Agent `clerk init` rerun, signed in, init token, Next.js:** assert no `POST /v1/platform/applications`.
  - **Agent `clerk init`, signed in, SDK keyless file only, Next.js:** assert no `POST /v1/platform/applications`, and `usage_error` with exit 2.
  - **Agent `clerk link`, signed in, SDK keyless file whose key matches an account app:** assert it links that app.
  - **Person `clerk link`, signed in, SDK keyless file, no matching app, then a rerun after the app is added to the mocked account:** the first run's browser stub (milestone 1) recorded the claim URL, its output contains no URL, it exits 1, and no profile is written. The rerun links the claimed app.
  - **Person `clerk init`, signed out, init token, claim refused:** assert no picker and no create call.
- `commands/link/README.md` describes the claim prompt, matching on the key the app loads, the SDK claim page and its exit code, and the stops.
- `commands/init/README.md` (its rerun-protection section near line 341) says signed-in reruns are protected through `link`.

**What could go wrong.**

- **Every caller of `link()` inherits the new behavior:** `init`, `migrate` (interactive only, `migrate/run.ts:235-237`), and `doctor --fix`. `init`'s own tests replace `link` with a stand-in (`test/lib/init-harness.ts`), so they won't catch `init` regressions; the integration tests above are what does.
- **Callers of `login()` that go on to link** must pass the skip-claim option: today that's `init` and `migrate`. A future caller that forgets gets login's own claim policy, which milestone 2's guard still protects.
- **A claim with only `CLERK_PLATFORM_API_KEY` set (no OAuth session) is untested against the real API.** If the endpoint rejects API keys, `link` stops with that error. That's acceptable, but say so in the PR description.
- **A folder whose `.env` key is in the account but whose `.env.local` key isn't stops auto-linking.** Shane decided this deliberately; say so in the PR description and the changeset, because it changes behavior for existing folders.
- **`openBrowser` succeeding doesn't prove the person saw the page** (SSH to a Mac). The `clerk open --print` line covers that case; keep it in every run, not only on failure.
- **A person-mode script that chains `clerk link && …`** now stops at exit 1 after the claim page opens. That's intended: nothing was linked.
- **`clerk init --app <id>` in a folder with an init token still links the named app and overwrites `.env`.** That is an explicit choice, so leave it. Record it in the PR description as a known limitation.
- **The SDK keyless file may still exist after its app was claimed in the Dashboard.** Matching its key against the account handles that case correctly.

### PR 1 wrap-up

- **Changeset:** a user-facing fix, created with `/changesets create`.
- **READMEs:** `auth`, `link`, `init` (milestones 2 to 4).
- **Checks:** the commands in "Conventions both PRs share".
- **Prove it works:**
  - Run the integration tests above and paste their names and pass output into the PR description, with each one's failing output from `origin/main`.
  - For each "ran" row, read the actual side effects in the test, not the command's output: the temporary config file's profile, the `.env` contents, whether the token file exists, and the harness's recorded request list.
  - No real-account run unless Shane approves one on a throwaway account.

---

## PR 2: one classifier decides the advice for every unlinked folder

### Milestone 5: a shared classifier and next-step wording, next to `lib/keyless-target.ts`

**Goal and outcome.** One module answers "this folder isn't linked: what does it hold, and what should the person run next?" Every message site uses it, so the same folder gets the same advice from every command. Nothing user-visible changes in this milestone.

**Implementation outline.**

1. **Contract.** Types and names are illustrative; the shape is the decision:

   ```ts
   // A folder with no linked application, classified from local files only.
   export type UnlinkedFolder = {
     // Precedence: init token, then plain keys, then the SDK keyless file, then nothing.
     kind: "init_app" | "unknown_owner" | "sdk_app" | "no_app";
     signedIn: boolean;
     // For unknown_owner: which plain keys exist, and where, from the shared key reader.
     publishableKeySource?: string; // ".env.local", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY env var", for display
     secretKeySource?: string;
   };

   // Pure: decides the kind from facts. doctor calls this with its memoized facts.
   export function classifyUnlinkedFolder(facts: UnlinkedFolderFacts): UnlinkedFolder;

   // Reads the facts for `cwd`. Never throws. No side effects.
   export async function readUnlinkedFolder(cwd: string): Promise<UnlinkedFolder>;

   // The step text for one situation, plus runnable commands for agent JSON.
   // `detection` is set only by a caller that already ran key detection (agent-mode `clerk link`).
   export function unlinkedFolderNextStep(
     folder: UnlinkedFolder,
     context: { agent: boolean; rerun?: string; detection?: "no_match" | "list_failed" },
   ): { text: string; examples: Example[] };
   ```

2. **The four kinds.**
   - `init_app`: an init token is present, whatever else the folder holds. The token is the strongest signal, and the claim guard from milestone 2 makes acting on it safe even when the folder's keys belong to another app.
   - `unknown_owner`: a plain publishable key or a plain secret key (or both), from an env var, `.env`, or `.env.local`, and no init token. A folder with only a publishable key belongs here, not in `no_app`. The app may be in this account, in another one, or unclaimed with its token lost. The wording must never call it unclaimed.
   - `sdk_app`: no init token, no plain key of either kind, and the SDK keyless file holds a publishable key. This is the same SDK-only test milestone 4 uses. An SDK keyless file without a publishable key isn't `sdk_app`; with nothing else in the folder it classifies as `no_app`, and `clerk link` itself gives the "no usable claim link" stop for it.
   - `no_app`: none of the above.
3. **Reading the facts.**
   - **Init token:** use `peekKeylessBreadcrumb` (no side effects; `readKeylessBreadcrumb` deletes a malformed file).
   - **Keys and their sources:** use the shared key reader from milestone 2 (shared rule 2). It reports the publishable and secret keys separately. It must not throw, so a malformed key can't turn a `not_linked` error into `invalid_key_format`.
   - **Signed in:** use `hasAccountCredentials`. A credential read failure, such as a sandboxed keychain, counts as signed out. That wording only adds a sign-in step, which is harmless.
4. **Avoid an import cycle.** `lib/config.ts` will call the reader (milestone 8), and `lib/keyless-target.ts` imports `lib/config.ts`. The shared key reader is already a leaf module (shared rule 2). Put the classifier in its own module too, and make sure it doesn't import `lib/config.ts` directly or through `keyless-target.ts`.
5. **Next-step wording.** These are drafts for review. The implementer may polish wording but not change which commands each cell names. Every site supplies its own lead sentence, and `rerun` appends "then rerun `<command>`".

   | Kind                                     | Person (signed in or not; `clerk link` signs in itself)                                                                                                                                                                         | Agent, signed in                                                                                        | Agent, signed out                                                                                                 |
   | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
   | `init_app`                               | This folder's app was created by `clerk init` and isn't in an account yet. Run `clerk link`; it claims the app into your account and links this folder.                                                                         | same                                                                                                    | `clerk auth login` (it opens a browser, so a person must finish sign-in); it claims the app and links this folder |
   | `sdk_app`                                | This folder runs on an app the Clerk SDK created during development, which isn't in an account yet. Run `clerk link`: it opens the Clerk Dashboard page to claim the app. After claiming, run `clerk link` again.               | `clerk open` (it prints the claim link for a person to open), then `clerk link` once the app is claimed | `clerk open`, then `clerk auth login`, then `clerk link`                                                          |
   | `unknown_owner`, publishable key present | This folder has a Clerk key in `<publishableKeySource>`. Run `clerk link`; it finds the app in your account by that key. If it finds no match, no app in this account uses this key: link one with `clerk link --app <app_id>`. | same                                                                                                    | `clerk auth login`, then `clerk link`                                                                             |
   | `unknown_owner`, secret key only         | This folder has a Clerk secret key in `<secretKeySource>` but no publishable key, so `clerk link` can't match it automatically. Run `clerk link` and choose the app this key belongs to.                                        | `clerk apps list --json`, then `clerk link --app <app_id>`                                              | `clerk auth login`, then as signed in                                                                             |
   | `no_app`                                 | Run `clerk link` to choose one of your apps, or `clerk init` to create one.                                                                                                                                                     | `clerk apps list --json`, then `clerk link --app <app_id>`; or `clerk init` to create an app            | `clerk auth login` first, then as signed in                                                                       |

   Why `clerk link`, not `clerk auth login`, for `init_app`: after PR 1, `clerk link` claims the app itself. `clerk auth login` checks only for a stored session (`commands/auth/login.ts:36-47`). An agent whose only credential is `CLERK_PLATFORM_API_KEY` counts as signed in, but `clerk auth login` would start a browser sign-in it can't finish. Only a signed-out agent needs `clerk auth login`.

   When `detection` is set (agent-mode `clerk link`, which just ran key detection), the advice changes so it never sends the agent back to the command that just failed:
   - `no_match`: no app in this account uses the folder's key. Advise `clerk apps list --json`, then `clerk link --app <app_id>`. The first example is never `clerk link`.
   - `list_failed`: the app list failed, so ownership is unknown (shared rule 1). Advise the failure's own step, such as `clerk auth login` for an expired session or retrying after a server error. Never say the app isn't in this account.

   `examples` lists the same commands in order, each with a one-line description, ending with the `rerun` command when given. Sites attach `examples` to the error only in agent mode.

**Definition of done.**

- A table test over real temporary directories (files written to disk, credentials toggled with `_setTokenOverride` and `CLERK_PLATFORM_API_KEY`). Rows, each run signed in and signed out:
  - init token only;
  - init token with `.env` keys;
  - init token with only the SDK keyless file;
  - SDK keyless file only;
  - SDK keyless file with a secret key but no publishable key (expect `no_app`, matching milestone 4's SDK-only test);
  - SDK keyless file with `.env` keys (expect `unknown_owner`);
  - a plain secret key next to an SDK keyless file (expect `unknown_owner`, secret key only; the SDK file's publishable key isn't used);
  - `.env` only;
  - `.env.local` only;
  - publishable key only (expect `unknown_owner`, not `no_app`);
  - secret key only (expect `unknown_owner`, secret key only);
  - secret key in an env var only;
  - a malformed key (expect `unknown_owner`, no throw);
  - nothing.
  - A run from a subdirectory of a folder with keys expects `no_app`, which documents the limitation.
  - A malformed token file is still on disk after reading.
- Unit tests for the wording that assert which commands are named, not whole strings:
  - `init_app` names `clerk link` for people and signed-in agents, and `clerk auth login` only for signed-out agents.
  - `sdk_app` names `clerk link` for people (it opens the claim page), and `clerk open` before `clerk link` for agents. No cell contains a claim URL.
  - `unknown_owner` never contains "unclaimed". With a publishable key it promises detection; with a secret key only it doesn't.
  - `no_app` names both `clerk link` and `clerk init`.
  - With `detection: "no_match"`, the first example is never `clerk link`. With `detection: "list_failed"`, the text never says the app isn't in this account.
  - No output ever contains `deploy --app`, `init --accountless`, or a URL.
  - Every agent signed-out cell starts with `clerk auth login`, except `sdk_app`, which starts with `clerk open`.
- Each test is seen failing at least once, for example by temporarily breaking the precedence.

**What could go wrong.**

- **An import cycle through `lib/config.ts`.** Run `bun run typecheck` and `bun run lint`, and check that `lib/config.ts` doesn't import the classifier module transitively.
- **Wording drift.** Later milestones must not write their own step text. Any site that needs something new extends `unlinkedFolderNextStep`.

### Milestone 6: `deploy`, `deploy status`, and agent-mode `link` use the classifier

**Goal and outcome.** The messages from the state table's "`deploy` advises after PR 2" column, per row.

- `clerk deploy` and `clerk deploy status` still exit 1 with `not_linked` and still start with "No Clerk project linked to this directory.", then give the classified step and "then rerun `clerk deploy`" (or `clerk deploy status`).
- When agent-mode `clerk link` reaches its existing generic error (no keys to match, no match, or a failed app list, including in an SDK-only folder), it still exits 2 with `usage_error` and still starts with "Cannot select an application in agent mode.", then gives the classified step with `detection` set from milestone 4's auto-link result. It never advises `clerk link` again. The signed-in `no_app` case keeps today's "Pass --app <id>, or run `clerk apps list --json` and retry." Agent `link`'s other outcomes come from milestone 4: a signed-in agent with an init token claims and links (exit 0), and the SDK and claim stops use the codes decided under "What's decided".
- Agent JSON includes `examples`.

**Implementation outline.**

- Replace the three inline throws with one helper in the `deploy` command folder that calls `readUnlinkedFolder` only on the failure path. The throws are at `deploy/index.ts:134` (agent handoff), `deploy/index.ts:148` (person), and `deploy/status-command.ts:48`. A successful run reads nothing extra.
- Leave `resolveDeployContext` (`deploy/status.ts:191`) as it is.
- `deploy/errors.ts:86-91` (the linked app no longer exists) stays as it is; its "re-link" advice is right for that case.
- For agent-mode `link`, reuse the classifier at `link/index.ts:55-59`, passing `detection` from the auto-link result (no match, or list failed).

**Definition of done.**

- One or two mapping tests per command: given a classified folder, the error has the expected lead sentence, code, exit code, and first example command. Update the existing assertions at `deploy/index.test.ts:2663-2677` and in `status-command.test.ts`. They use a real temporary config directory, so set credentials with `_setTokenOverride`.
- In the integration harness, one table-driven test per command (`deploy`, `deploy status`, agent `link`) over the four kinds, with `unknown_owner` run once with a publishable key and once with a secret key only. Assert the JSON `error.code`, the exit code, and `error.examples[0].command`. For agent `link`, the signed-in `init_app` cell expects success: exit 0, the folder linked, and no error JSON, because PR 1 claims and links it. Every other agent `link` cell that reaches the generic error asserts `usage_error`, exit 2, and an `error.examples[0].command` that is never `clerk link`. Assert that person-mode output has no "Examples:" block. Each test names its credential; the `init_app` cases run once with a stored session only and once with an API key only.
- Follow-the-advice tests (shared rule 4), one per situation in the state table: starting from the `deploy` error, run the commands its `examples` name, in order, and assert the folder ends linked to the app its keys belong to, or still unlinked with a next step that isn't the command that just ran. The agent API-key-only `init_app` case must end linked without any browser sign-in. For `sdk_app`, the test stands in for the person's Dashboard claim by adding the app to the mocked account between the first `clerk link` (or `clerk open`) and the rerun.
- The existing telemetry assertions (`not_linked`, stage `null`) still pass unchanged.
- `commands/deploy/README.md` and `commands/link/README.md` describe the advice per situation.

**What could go wrong.**

- **Changing the lead sentence** breaks the skill's troubleshooting lookup. The integration tests should assert it verbatim.

### Milestone 7: `doctor` uses the classifier

**Goal and outcome.**

- **Signed out with plain keys:** `doctor` no longer calls the app unclaimed. Its message says the folder uses the secret key from `<source>` and isn't linked, then gives the `unknown_owner` step.
- **Signed in with an init token:** "Project linked" names the claim step.
- **SDK-only folder:** gives the `sdk_app` step: `clerk link` for people (it opens the claim page), `clerk open` for agents.
- Statuses and `fix` labels are unchanged. `doctor --fix` still runs `link`, which after PR 1 does the right thing in each case.

**Implementation outline.**

- `doctor` already holds most of the facts in its memoized context (`doctor/context.ts`: `getKeylessTarget`, `hasClaimBreadcrumb`, `hasAccountCredentials`). Add the shared key reader's result as one more memoized getter, because the classifier needs the publishable key separately from the secret key. Build `UnlinkedFolderFacts` from them and call the pure `classifyUnlinkedFolder`, so `doctor` keeps its no-side-effects and one-read-per-fact guarantees.
- Replace `claimHint` (`checks.ts:88`) and the keyless branches of `checkLoggedIn` (`checks.ts:134-141`) and `checkProjectLinked` (`checks.ts:272-293`). Keep the words "unclaimed accountless application" only for `init_app` and `sdk_app`.

**Definition of done.**

- Update the `doctor.test.ts` cases that assert "unclaimed accountless application" and "Claim it". Add cases for:
  - signed out with plain keys (must not contain "unclaimed");
  - signed in with an init token (names the claim step; no test covers the token branch today);
  - SDK-only (names `clerk link` in person mode and `clerk open` in agent mode).
- Run `doctor` in the integration harness for the two "ran" `doctor` rows and assert the new text.
- `commands/doctor/README.md` (lines 53-55 describe the claim hint).

**What could go wrong.**

- **Agents read `doctor`'s `message` and `remedy`.** The skill tells them to. Text changes are the point, but statuses must not move, so assert them in the tests.

### Milestone 8: the remaining "run `clerk link`" sites use the classifier

**Goal and outcome.** Commands other than `deploy` and `doctor` give the same advice for the same folder.

**Implementation outline.** At each site, keep the lead sentence and replace the advice with `unlinkedFolderNextStep`:

- **`lib/config.ts:430-438`** (the generic not-linked error for account commands): keep "or pass `--app <app_id>`", because these commands accept `--app`.
- **`commands/open/index.ts:121-134`:**
  - The key-but-no-claim-link branch gets the `unknown_owner` step. Remove the `clerk init --accountless` advice entirely, because it creates a new app and overwrites the keys.
  - The no-keys branch gets the `no_app` step.
  - The subpath error at `:138-142` stays as it is.
- **`lib/keyless-target.ts` `warnKeylessCoversLess` (`:265-286`)**, printed by `config pull` and the feature toggles: the step for the classified kind. Keep the expired-session variant for `unknown_owner`.
- **`whoami`** (in scope by Shane's decision): the signed-out keyless branch (`commands/whoami/index.ts:200-208`) says "unclaimed" only for `init_app` and `sdk_app`. For `unknown_owner` it says the folder uses the key from `<source>` and isn't linked. The next steps come from `unlinkedFolderNextStep` in place of the fixed `NEXT_STEPS.WHOAMI_KEYLESS` (`lib/next-steps.ts:68-72`).

**Definition of done.**

- One test per site asserting the named commands. For `open`, also assert that `init --accountless` no longer appears. For `whoami`, assert it doesn't say "unclaimed" for plain keys.
- One harness run of `clerk config pull` signed in with an unclaimed app's keys and an init token, asserting the warning names `clerk link` as the claim step.
- Update `commands/open/README.md` if it describes the removed advice.

**What could go wrong.**

- **`lib/config.ts` gaining the classifier** is the import-cycle risk from milestone 5.

### Milestone 9: messages that say "`clerk auth login` will claim it" use the classifier

**Goal and outcome.** Advice to claim gives the `init_app` step (`clerk link`, or `clerk auth login` for a signed-out agent) only when an init token exists. Otherwise it gives the `sdk_app` step for an SDK-created app (`clerk link` for people, `clerk open` for agents) or the `unknown_owner` step, and never calls a plain-key app unclaimed.

**Implementation outline.**

- **`lib/copy.ts:33, 43-44, 50, 54, 58, 62`**: add a parameter carrying the classified folder (or its step text). Their callers already know they're in an unlinked, keyless context: `config/push.ts:63`, `config/schema.ts:20`, `config/keyless.ts:137` and `:177`, `users/open.ts:85`, `billing/index.ts:68`.
- **First sentences follow the kind.** Several of these messages open with "unclaimed" (for example, "an unclaimed accountless application can't reach them"). For `unknown_owner` that's unproven, so the first sentence depends on the kind too. Only the two not-linked prefixes under "What's decided" stay word for word; every other statement about who owns the app depends on what the classifier found.
- **`commands/env/pull.ts:149` and `:166`** (the key-pair mismatch error and the missing-publishable-key warning on `env pull`'s keyless path): both say "run `clerk auth login` to claim". Same treatment.
- **`lib/keyless-target.ts:239`** (`--instance` on an unclaimed app): same treatment.
- **`init/heuristics.ts:168` `printExistingKeylessInfo`**:
  - Its caller (`init/index.ts:676-680`) knows whether it kept an init-token app or an SDK-created one.
  - The SDK variant gives the `sdk_app` step (`clerk link` for people, which opens the claim page; `clerk open` for agents) and says the keys are in `.clerk/.tmp/keyless.json`, not the env file.
  - `printKeylessInfo` (`:156`) stays as it is; it runs right after `init` wrote a token.
  - GROW-1242 plans to rewrite `printKeylessInfo` in the same file, so expect a trivial merge.

**Definition of done.**

- Tests for each changed message asserting `clerk auth login` appears only for `init_app` (signed-out agents) and "unclaimed" never appears for `unknown_owner`.
- An `init` test where the existing app is SDK-created asserts the `sdk_app` step in each mode: `clerk link` for people, `clerk open` for agents.
- An `env pull` test for each of its two messages with plain keys and with an SDK keyless file.

**What could go wrong.**

- **Missed callers of the changed `copy.ts` functions.** `bun run typecheck` catches them, because the signatures change.

### PR 2 wrap-up

- **Changeset:** a user-facing fix, created with `/changesets create`.
- **READMEs:** `deploy`, `link`, `doctor`, `open`, `env`, and `whoami` (milestones 6 to 9), wherever they describe a changed message.
- **Checks:** the commands in "Conventions both PRs share".
- **The site inventory (shared rule 3).** Rerun the three searches and put the result in the PR description: every hit either fixed by this PR or listed with its reason. At `2133e7ea3`, these hits are expected to stay as they are, each for the reason given. Recheck each one against the code at the time; this list is a starting point, not a substitute for the search.
  - `lib/bapi-command.ts:119` and `commands/api/fapi.ts:38`: they fire only when the folder has no local key, and those commands accept `--app`, so "`clerk link`, or pass `--app`" is right.
  - `commands/deploy/errors.ts:89`: the linked app no longer exists, so "re-link" is right.
  - `commands/doctor/checks.ts:297, 325, 371, 469`: no keys at all, or a linked app with a problem, so `clerk link` is right.
  - `commands/open/index.ts:41`: a linked profile without a development instance.
  - `commands/users/open.ts:128, 201`: `--secret-key` with no app target.
  - `commands/migrate/run.ts:218`: signed-out agent, "`clerk auth login`, then `clerk link`". After PR 1 that's right for init apps and plain keys, and for SDK-only folders `link` itself opens the claim page (person) or says to run `clerk open` (agent).
  - `commands/whoami/index.ts:222`: signed in, a local secret key, not linked. After PR 1, `clerk link` claims an init app, and for SDK-only folders opens the claim page (person) or says to run `clerk open` (agent).
  - `commands/auth/login.ts:282` and `lib/next-steps.ts:33`: the retry message after a failed claim during a direct `clerk auth login`, which is right.
  - `commands/init/heuristics.ts:156`: printed right after `init` wrote an init token, so "`clerk auth login` claims it" is right.
  - `lib/next-steps.ts` entries for `LOGIN`, `LOGIN_LINKED`, `CREATE`, `AUTOCLAIM_*`, `WHOAMI`, and `WHOAMI_LINKED`: general next steps outside the unlinked-folder errors.
  - Code comments.
- **Prove it works:**
  - Run the integration tests, including the follow-the-advice tests, and paste the per-command, per-kind output (JSON error and exit code) into the PR description.
  - Also run the real CLI from source for the signed-in agent column of `deploy` and `deploy status`. That path makes no API call, and `CLERK_PLATFORM_API_KEY` set to a fake value makes "signed in" deterministic without reading the keychain:
    - Seed one temporary folder per kind.
    - From inside it, run `CLERK_CONFIG_DIR=$(mktemp -d) CLERK_PLATFORM_API_KEY=ak_fake bun <repo>/packages/cli-core/src/cli.ts --mode agent deploy`.
    - Read stderr and `$?`.
  - Bun loads `.env` from the current folder when run from source, so plain keys there report their source as an env var; the shipped binary doesn't. Don't run the signed-out column from source: the `clerk-cli-dev` keychain namespace may hold a real session. The harness covers it.

---

## The skills PR (`clerk/skills`, under GROW-1249)

**What changes.** The `clerk-cli` skill stops treating `not_linked` as proof that `clerk link` is the fix. Instead it tells agents to:

- first follow the step the error names, if it names one other than `clerk link` (newer CLIs will);
- otherwise inspect the folder:
  - `.clerk/keyless.json` present: run `clerk auth login`, but only when the folder isn't linked and the person confirms they haven't replaced the keys `clerk init` wrote. An agent can't tell `init`'s keys from keys pasted from the Dashboard, so it asks the person. On CLIs without PR 1, a leftover token otherwise relinks the folder and overwrites its keys.
  - Only `.clerk/.tmp/keyless.json` present: ask the person to claim the app with `clerk open`, then run `clerk link`.
  - Neither present: `clerk link`, signing in first if needed.
- Agents with `deploy` never pass `--app`; they link first with `clerk link --app <id>`.

**Passages (at `origin/main` 8482d43):**

- `skills/clerk-cli/references/auth.md:95` and `:171`;
- `skills/clerk-cli/references/agent-mode.md:274` and `:71`;
- plus the three passages in open decision 3 if Shane agrees.

**Process.** Read the skills repo's `AGENTS.md` and `STYLEGUIDE.md` first. Run `npm test` and `npm run check`. The PR needs an approval from a code owner in `@clerk/docs`, `@clerk/ai-enablement`, or `@clerk/growth` (`.github/CODEOWNERS`); say so in the PR description. The PR template requires a review deadline (or "No rush") and a link to the CLI PR. Apply the `do not merge` label if it must wait for a CLI release. Ship order is Shane's call (open decision 4).

## Follow-up: telemetry can tell the unlinked kinds apart

Out of scope for both PRs. The draft ticket is below. It would touch:

- a new property on the `CLI_COMMAND_EXECUTED` event in `lib/telemetry.ts`, from a fixed list (the four kinds);
- the warehouse model that reads that event;
- the first-run disclosure text in `lib/telemetry.ts:492-500`, which lists exactly what is collected;
- the public page at https://clerk.com/docs/telemetry.

## Draft ticket text

Drafts only. Nobody creates or edits a Linear ticket without Shane.

### New bug ticket (PR 1)

**Title:** `clerk link`, `clerk auth login`, and `clerk init` link the wrong app or overwrite keys when the folder holds an unclaimed app

**Body:**

`clerk link` links a different app than the one a folder runs on whenever that folder's app isn't in the person's account yet. `clerk auth login` and `clerk init` can do the same, and both can overwrite the folder's keys.

For example: a person runs `clerk init` signed out, which creates an unclaimed app and writes its keys to `.env.local`. Later, signed in, they run `clerk link`. The picker can't list the unclaimed app; they pick another one; the folder is now linked to it while `.env.local` keeps the original keys. `clerk deploy` then prepares the other app for production.

Reproduced through the CLI's integration harness at `2133e7ea3` (mocked credentials, API, and browser):

- **Signed in, init token (`.clerk/keyless.json`), `clerk link`:** links the picked app; no claim; `.env.local` unchanged; `deploy` sent `POST /v1/platform/applications/app_B/instances`.
- **Signed in, init token, person reruns `clerk init`:** links the picked app and writes its keys over `.env.local`.
- **Signed in, init token, agent reruns `clerk init` (Next.js):** creates a new app; a later `clerk auth login` claims the original and flips the link and `.env.local` back.
- **Signed in, only the SDK's `.clerk/.tmp/keyless.json`, agent `clerk init` (Next.js):** creates a new app.
- **Folder linked to app B with B's keys, leftover init token for app A, agent `clerk auth login`:** claims A, relinks the folder to A, replaces the keys.
- **Person, signed in, init token, `clerk auth login`, answers No to "Re-authenticate?":** exits 0 without claiming.

**Fix:**

- **The shared claim step** (`lib/autoclaim.ts`) sets up the folder only when every key it holds matches the claimed app, or it holds no keys. Otherwise it leaves the folder's link and keys alone and says so. That includes a folder linked elsewhere, and any case it can't verify.
- **`clerk auth login`** asks a person one question naming where the claim goes (default Yes) before every claim: in place of "Re-authenticate?" when already signed in, before any browser step when only `CLERK_PLATFORM_API_KEY` is set, and after the browser sign-in when signed out. `-y` and agent mode claim without asking.
- **`clerk link`** claims first when the folder has an init token, whether the person started signed in or not, after asking the same question. Declining, a refused claim, or a failed claim stops instead of falling through to the picker. Agents claim without a prompt.
- **`clerk init` and `clerk migrate`** sign in without claiming on their way to `link`, so `link` applies the same policy.
- **`clerk link` also matches the SDK keyless file's key** against the account, but only when the folder has no plain keys. When nothing matches after a successful app list, a person's `clerk link` opens the Dashboard claim page without printing its link and says to rerun `clerk link` after claiming; an agent's says to run `clerk open`. Neither shows the picker. A failed app list stops with its own advice.
- **`clerk link` matches only on the key the app loads:** the shell env var, then `.env.local`, then `.env`. This deliberately changes behavior for folders with different keys in `.env` and `.env.local`.

**Tests:** integration tests that reproduce each case above, failing on `main` before the fix.

**Not in this ticket:**

- Message wording for unlinked folders (GROW-1249).
- `clerk init --app <id>` in a folder with an init token (an explicit choice).
- The picker for plain keys that match no account app.

### GROW-1249, rewritten

**Title:** `clerk deploy`, `deploy status`, `link`, and `doctor` give one piece of advice for four different unlinked folders

**Body:**

On a folder that isn't linked to an app, `clerk deploy` and `clerk deploy status` always say "run `clerk link`", and agent-mode `clerk link` always says "pass `--app <id>`". The right step depends on what the folder holds:

- An app `clerk init` created needs claiming. After the new bug ticket's fix, `clerk link` does that; an agent that isn't signed in needs `clerk auth login`.
- An app a Clerk SDK created needs claiming in the Dashboard. After the new bug ticket's fix, a person's `clerk link` opens the claim page (agents: `clerk open`), and `clerk link` links it once claimed.
- A publishable key from an app already in the account needs `clerk link`. A secret key alone can't be matched, so the person picks the app (agents: `clerk apps list --json`, then `clerk link --app <app_id>`).
- No keys at all needs `clerk link` or `clerk init`.

`doctor` is wrong in two of these: it calls Dashboard keys "unclaimed", and it tells a signed-in person with an init token to run `clerk link`. About 620 `deploy` runs a month end with `not_linked` (30 days to Sep 11); the count can't separate these folders. The `clerk-cli` skill repeats the same advice.

Split out of [GROW-1235](https://linear.app/clerk/issue/GROW-1235/fix-misleading-and-missing-text-in-the-clerk-deploy-wizard-and-help) on 2026-09-16. Observed on CLI 3.3.0; reverified on `main` at `2133e7ea3` with the integration harness. Evidence: [Walkthrough](https://app.notion.com/p/3db2b9ab44fe8198b7ddcd520562a49a) (Flag 5) · [Improvement plan](https://app.notion.com/p/3dc2b9ab44fe816ea395cd4c42e5cb6d) (Theme 1, item 2). Depends on the new bug ticket, whose fixes make several of these messages true.

**1. CLI (PR 2).**

- One classifier of unlinked folders, from local files only: init token, then plain keys (ownership unknown; publishable and secret keys tracked separately), then the SDK keyless file, then nothing.
- Every site that says "run `clerk link`" or "`clerk auth login` will claim it" uses it. A repeatable search finds the sites, and the PR accounts for every hit:
  - `deploy` (two sites), `deploy status`, and agent-mode `link` (which never advises `clerk link` again after its own detection failed);
  - `doctor` (both checks; text changes, statuses don't);
  - the generic not-linked error in `lib/config.ts`;
  - `clerk open`, dropping its `clerk init --accountless` advice, which creates a new app and overwrites keys;
  - the "covers fewer settings" warning;
  - `lib/copy.ts`, `lib/keyless-target.ts:239`, `init/heuristics.ts:168`, and `env pull`'s two claim messages;
  - `whoami`.
- Error codes, exit codes, and the lead sentences stay the same. Agent JSON errors gain an `examples` list with the next command. `deploy` advice never suggests `deploy --app`, which doesn't exist.

**2. Skills (`clerk/skills`).**

- `skills/clerk-cli/references/auth.md:95` and `:171`, and `agent-mode.md:274` and `:71`, get per-folder advice that works with today's CLI.
- The PR needs an approval from a Docs, AI Enablement, or Growth code owner.

**Not in this ticket:**

- Wizard and help wording: GROW-1235.
- `deploy` in person mode starting the sign-in itself (a behavior change).
- `clerk init`'s closing message naming the claim step: [GROW-1242](https://linear.app/clerk/issue/GROW-1242/clerk-init-and-clerk-doctor-dont-say-what-state-the-project-is-in-or).
- The `link`, `auth login`, and `init` behavior fixes: the new bug ticket.
- Telemetry that tells these folders apart: the telemetry follow-up.

### Telemetry follow-up

**Title:** Telemetry can't tell why a `clerk deploy` run ended with `not_linked`

**Body:**

Every `deploy` and `deploy status` run in an unlinked folder sends `error_code: not_linked` with `app_id: null`, so the warehouse can't tell an unclaimed `init` app from an SDK-created app, keys from an app already in the account, or a folder with no app. After GROW-1249 ships, the only way to see whether its messages helped is a property that says which of the four the run hit.

The change touches:

- the `CLI_COMMAND_EXECUTED` payload in `packages/cli-core/src/lib/telemetry.ts` (a fixed list, set only on `not_linked` exits);
- the warehouse model for that event;
- the first-run disclosure text in the same file, which lists exactly what is collected;
- https://clerk.com/docs/telemetry.

**Until then:** splitting last month's `not_linked` deploy events by `mode` and `ai_agent` (filtered to `app_id` null) shows whether agents or people hit it more. [Clerk CLI #522](https://github.com/clerk/cli/pull/522) (2026-10-07) moved Codex runs into agent mode, so compare windows on either side of it.
