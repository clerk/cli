# Unclaimed-app advice and claim-first `clerk link`: implementation plan

Date: 2026-10-17. Base: `origin/main` at `2133e7ea3` (CLI 4.0.0 plus canary commits). Status: draft for Shane's review. Covers two CLI PRs in this repo; the matching `clerk/skills` PR is summarized at the end.

## What this plan fixes

A folder that has a Clerk app but no link to one gets the same advice from every command, and following it often links the wrong app. For example, someone ran `clerk init` while signed out, so `init` created an unclaimed app and wrote its keys to `.env.local`. Later, signed in, they run `clerk deploy`. It prints "Run `clerk link`". They run `clerk link`, which shows a picker of the apps in their account. The app their code uses isn't in that list, because it was never claimed. They pick one, the folder is now linked to that other app, and `clerk deploy` prepares the other app for production while `.env.local` still holds the original app's keys.

Terms used throughout:

- **Linked**: the CLI's config file records which Clerk app this folder uses (`resolveProfile` in `lib/config.ts` finds it by git remote, git repo, or a parent directory).
- **Unclaimed app**: a Clerk app that belongs to no account yet. Claiming moves it into the signed-in person's account.
- **Init token**: the claim token `clerk init` saves in `.clerk/keyless.json` when it creates an unclaimed app. `clerk auth login` redeems it to claim the app (`lib/autoclaim.ts`).
- **SDK keyless file**: `.clerk/.tmp/keyless.json`, which a Clerk SDK such as `@clerk/nextjs` writes when it creates an unclaimed app for itself during `next dev`. It holds that app's keys and a full claim URL. The CLI can't claim it, because there is no token; the person claims it in the Dashboard (`clerk open` prints or opens that URL).
- **Plain keys**: a Clerk secret or publishable key in an env var, `.env`, or `.env.local`, with no init token. Nothing local says whether that app is in an account. The CLI's only call with the key, `GET /v1/instance`, can't tell either.
- **Signed in**: `hasAccountCredentials()` in `lib/credential-store.ts` returns true (a stored OAuth session or `CLERK_PLATFORM_API_KEY`). It checks presence only.
- **Person** and **agent**: the CLI's two modes (`src/mode.ts`). Agent mode is the default without a TTY and for Codex runs; it prints errors as one JSON line on stderr.

The work ships as two stacked PRs:

- **PR 1 (behavior)** makes `clerk link`, `clerk auth login`, and `clerk init` claim or match the folder's own app, and stop instead of linking a different one.
- **PR 2 (messages)** adds one shared classifier of unlinked folders and routes every "run `clerk link`" and "`clerk auth login` will claim it" message through it.

PR 2 depends on PR 1: several PR 2 messages are only true after PR 1 (for example, "run `clerk auth login`" for a signed-in person with an init token).

## Decisions still open

Each needs Shane's answer at plan review. None changes the milestone structure.

1. **What `clerk auth login` does for a signed-in person when the folder has an init token.** This changes only milestone 3.
   - **Option A (approved earlier):** claim with the current session first, then ask "Re-authenticate?". Risk: someone running `clerk auth login` to switch to a different account gets the app claimed into the old account before they're asked. That can't be undone from the CLI.
   - **Option B:** replace the prompt with one that names the account, such as "Claim `<project>` into `<email>`'s account? (No signs you in as someone else first.)". Yes claims with the current session. No runs today's browser sign-in, which then claims into the new account. It's the same number of prompts as today.
   - **Recommendation: B**, because it avoids an irreversible wrong-account claim at the cost of one reworded prompt. The plan is written for A; switching to B touches only milestone 3.
2. **Who confirms that claiming keeps the app's publishable key.** The guard in milestone 2 decides "is this the folder's app?" by comparing the claimed app's publishable key with the folder's. If claiming issued new keys, the guard would refuse to link every legitimate claim. The verifiers' mocks assumed keys stay the same. No real claim was run.
   - Options: ask the team that owns `POST /v1/platform/accountless_applications/claim`; run one real claim on a throwaway account with Shane's approval; or ship on the assumption.
   - **Recommendation: ask the owning team before PR 1 merges**, because a wrong assumption breaks the most common claim path.
3. **Error codes for the new stops in `clerk link`.**
   - **Recommendation:**
     - Folder runs on an SDK-created app that isn't in the account: `usage_error`, exit 2, in both modes. This matches agent-mode `clerk link`'s existing error, and the remedy names `--app`.
     - Claim refused (managed workspace or no organization): `not_linked`, exit 1, because the folder stays unlinked.
     - Temporary claim failure: rethrow the underlying API or auth error unchanged.
   - Alternative: a new code such as `claim_required`. Not recommended, because the working decision is that codes don't change.
4. **Whether `clerk link` keeps the picker for plain keys that match no app in the account.** A person can still link a different app there (row 7 of the state table).
   - **Recommendation: keep it and record it as a known limitation.** Plain keys are often Dashboard keys from another workspace, and the picker is how people deliberately switch apps.
5. **How far the skills PR goes.** Approved: `auth.md:95`, `auth.md:171`, `agent-mode.md:274`, `agent-mode.md:71`. The skills investigation found three more passages that say "`clerk auth login` claims it" with no condition: `clerk-setup/SKILL.md:203` and `:205`, and `clerk-cli/references/agent-mode.md:286`.
   - **Recommendation: include those three**, because they give the same wrong advice for SDK-created apps. Leave the passages that describe `clerk link --app <id>` as the deterministic path for agents, because they are accurate for apps already in an account.
6. **Ship order between the CLI PRs and the skills PR.** Shane decides. No recommendation.

## What's decided

**Approved by Shane:**

- Three tickets: a new bug ticket for PR 1, GROW-1249 rewritten for PR 2 and the skills PR, and a telemetry follow-up.
- Two CLI PRs and one skills PR, with one plan file covering both CLI PRs.
- The scope of PR 1 and PR 2 as listed in the milestones below.
- The verified state table below replaces GROW-1249's four-message model.

**Recommended by the orchestrator, Shane to confirm at plan review:**

1. `doctor`'s output changes where it's wrong. GROW-1249's "byte-identical" rule is dropped. `doctor`'s check statuses (`pass`, `warn`, `fail`) and `fix` labels stay the same; only message and remedy text change.
2. Error codes and exit codes stay the same at every existing site. Agent-mode JSON errors gain an `examples` list with the runnable next command.
3. Classification uses local files and credential presence only. No new API call on any error path.
4. Telemetry is deferred to a follow-up ticket.
5. The extra message sites (the generic not-linked error in `lib/config.ts`, `clerk open`, the "covers fewer settings" warning, `lib/copy.ts`, `lib/keyless-target.ts:239`, `init/heuristics.ts:168`) are in PR 2's scope.

**Planner decisions inside the approved scope.** Reviewers can override any of these. Each must be recorded in a code comment where it's implemented, because none of them can be recovered from the code alone.

- **The guard runs after the claim, not before.** The init token file holds only `{ claimToken, createdAt }` (`lib/keyless.ts:21-24`), with no app identity, so it's impossible to know before claiming which app the token belongs to. Checking after the claim needs no file-format change and protects every token already on disk. The cost is that a mismatched old app still gets claimed into the account. That's harmless, because the app is the person's.
- **"Same app" means the same Frontend API host.** Decode both publishable keys with `decodePublishableKey` (`lib/fapi.ts`) and compare hosts. This is the identity rule `hasKeyPairMismatch` in `lib/keyless-target.ts:150-202` already documents. A local publishable key that can't be decoded counts as "no local key".
- **The lead sentences of not-linked errors stay verbatim**: "No Clerk project linked to this directory." and "Cannot select an application in agent mode." Only the advice after them changes. The skill's troubleshooting table keys on the first sentence, and agents match on both.
- **`examples` is attached only in agent mode.** In person mode, `reportError` (`cli-program.ts:302-321`) prints an "Examples:" block under the message, which would repeat the commands the message already names.
- **Error messages never print a claim URL.** The URL carries a credential-equivalent token (the skill's `auth.md:48` says the same). Messages point at `clerk open`, which already prints it in agent mode and opens it in person mode.
- **The classifier reads the current directory only.** That's how the init token reader and the local key lookup already work. Running from a subdirectory of a monorepo classifies as "no app", whose wording ("`clerk link` to choose an app, or `clerk init` to create one") is safe.
- **`clerk auth login -y` keeps today's order**: browser sign-in, then claim. Someone passing `-y` asked to sign in again, possibly as someone else.

**Backward compatibility.** No stored data or token-file format changes. Agent JSON gains an additive `examples` field. Two approved behavior changes are visible to callers:

- A person's `clerk link` in a folder whose only key is in the SDK keyless file, with no matching app in the account, exits 2 with advice instead of opening the picker.
- A person's `clerk auth login` declining re-authentication after a claim now ends as success instead of a user abort. The exit code is 0 either way, and telemetry records `success` instead of `abort`.

Internal signatures change (`AutoclaimResult`, the `lib/copy.ts` message functions). Nothing outside this package imports them.

## Read before starting

- `AGENTS.md`, `CONTRIBUTING.md`, and `docs/releasing.md` in this repo.
- `.claude/rules/errors.md`, `logging.md`, `debug-logging.md`, `commands.md`, `changesets.md`, `promises.md`.
- The READMEs of the commands this touches: `packages/cli-core/src/commands/{auth,link,deploy,doctor,open,init}/README.md`.
- The header comment of `packages/cli-core/src/test/integration/lib/harness.ts`, which explains how the harness mocks credentials, HTTP, OAuth, prompts, and the config directory.
- GROW-1249's evidence: [Walkthrough](https://app.notion.com/p/3db2b9ab44fe8198b7ddcd520562a49a) (Flag 5) and [Improvement plan](https://app.notion.com/p/3dc2b9ab44fe816ea395cd4c42e5cb6d) (Theme 1, item 2).
- Related tickets: [GROW-1235](https://linear.app/clerk/issue/GROW-1235/fix-misleading-and-missing-text-in-the-clerk-deploy-wizard-and-help) (deploy wording, done) and [GROW-1242](https://linear.app/clerk/issue/GROW-1242/clerk-init-and-clerk-doctor-dont-say-what-state-the-project-is-in-or) (backlog; it rewrites `printKeylessInfo` in the same file as milestone 9's `printExistingKeylessInfo` change).
- The verifiers' run log, if it still exists: `/tmp/clerk-cli-verification-2133e7ea3.txt`. It holds the captured output and request paths behind every "ran" row below.

## The state table reviewers must check

Today, `clerk deploy` and `clerk deploy status` print the same error in every row below, in both modes, with exit 1 and error code `not_linked`: "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy`." (or `clerk deploy status`). Two verifiers ran all five starting states through the integration harness at `2133e7ea3`. They used mocked credentials, HTTP, OAuth, prompts, and browser, so nothing touched a real account. `deploy` made no API call in any of them.

In the Evidence column, "ran" means a verifier executed that cell through the harness. "Read" means it's inferred from the code.

### What `clerk link` does today, after PR 1, and what `deploy` will advise after PR 2

| #   | Folder (not linked)                       | Signed in | Person runs `clerk link` today                                                                                             | Agent runs `clerk link` today                                                             | `clerk link` after PR 1                                                                                                                                                       | `deploy` advises after PR 2                                                                                                   | Evidence                      |
| --- | ----------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | Init token, init's keys in `.env`         | No        | Works: signs in, sign-in claims the app, links it                                                                          | `usage_error`, exit 2. The suggested `clerk apps list --json` fails with `auth_required`. | Person: unchanged. Agent: unchanged (it can't sign in); PR 2 rewords.                                                                                                         | `clerk auth login` (claims the app and links this folder)                                                                     | ran                           |
| 2   | Init token, init's keys in `.env`         | Yes       | Picker without the app. Picking another app links it; `.env` keeps the original keys; `deploy` then targets the other app. | `usage_error`, exit 2                                                                     | Claims first and links the init app, in both modes. No picker.                                                                                                                | `clerk auth login` (after PR 1 it claims before asking anything)                                                              | ran                           |
| 3   | SDK keyless file only                     | No        | Signs in, nothing to claim, picker, links another app                                                                      | `usage_error`, exit 2                                                                     | Person: signs in, then matches the SDK file's key against the account. A match is linked; otherwise it stops with "`clerk open` to claim it". Agent: unchanged; PR 2 rewords. | `clerk open` to claim it, then `clerk link` (agents: `clerk auth login` before `clerk link`)                                  | today ran; after PR 1 read    |
| 4   | SDK keyless file only                     | Yes       | Picker, links another app                                                                                                  | `usage_error`, exit 2, no API call                                                        | Matches the SDK file's key. A match is linked; otherwise it stops with "`clerk open` to claim it". Both modes.                                                                | same as row 3                                                                                                                 | today: agent ran, person read |
| 5   | Plain keys; the app is in the account     | No        | Works: signs in, detects the key, confirms, links                                                                          | `usage_error`, exit 2                                                                     | unchanged                                                                                                                                                                     | `clerk link` (it finds the app by its key). Agents: `clerk auth login` first.                                                 | ran                           |
| 6   | Plain keys; the app is in the account     | Yes       | Detects the key, confirms, links                                                                                           | Auto-links ("Auto-linked to My SaaS App")                                                 | unchanged                                                                                                                                                                     | same as row 5                                                                                                                 | agent ran, person read        |
| 7   | Plain keys; the app is not in the account | Either    | Picker; can link another app                                                                                               | `usage_error`, exit 2                                                                     | unchanged (open decision 4)                                                                                                                                                   | same as row 5, plus "if `clerk link` can't find it, the app isn't in this account; link one with `clerk link --app <app_id>`" | read                          |
| 8   | No keys                                   | No        | Signs in, then picker (pick or create)                                                                                     | `usage_error`, exit 2. `clerk apps list --json` fails with `auth_required`.               | unchanged                                                                                                                                                                     | `clerk link` to choose an app, or `clerk init` to create one. Agents: `clerk auth login` first.                               | ran                           |
| 9   | No keys                                   | Yes       | Picker                                                                                                                     | `usage_error`, exit 2. Its `clerk apps list --json` advice works.                         | unchanged                                                                                                                                                                     | Agents: `clerk apps list --json`, then `clerk link --app <app_id>`, or `clerk init` to create an app. People: as row 8.       | read                          |

Rows 5, 6, and 7 look identical to the CLI without an API call, so PR 2 gives them one message: the "ownership unknown" wording. `deploy` has no `--app` option (ran: `error: unknown option '--app'`), so no `deploy` message may suggest `deploy --app`.

### Claims and `init` reruns that currently link or overwrite the wrong app

| Situation                                                                                                                   | Today                                                                                          | After PR 1                                                                                                 | Evidence  |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------- |
| Person, signed in, init token, runs `clerk auth login` and answers No to "Re-authenticate?"                                 | Exit 0, no claim, token kept                                                                   | Claims first, then asks (open decision 1)                                                                  | ran       |
| Person, signed in, init token, `clerk auth login -y`                                                                        | Signs in again in the browser, then claims and links                                           | unchanged                                                                                                  | ran       |
| Agent, signed in, init token, `clerk auth login`                                                                            | Claims and links, no prompt                                                                    | unchanged, plus the guard                                                                                  | ran       |
| Folder linked to app B and `.env` holds app B's keys; a leftover init token belongs to app A; agent runs `clerk auth login` | Claims A, relinks the folder to A, and `.env` flips to A's keys                                | Claims A, leaves the link and `.env` on B, and says so                                                     | ran       |
| Dashboard keys pasted into `.env`; a leftover init token; signed-in agent runs `clerk auth login`                           | Claims the old app, relinks to it, and replaces the pasted keys                                | Claims the old app, leaves the link and `.env` alone, and says so                                          | ran       |
| Person, signed in, init token, reruns `clerk init`                                                                          | Picker, links another app, and writes its keys over `.env.local`                               | Claims and links the init app. No picker.                                                                  | ran       |
| Agent, signed in, init token, reruns `clerk init` (Next.js)                                                                 | Creates a new app, links it, writes its keys; a later `clerk auth login` flips everything back | Claims and links the init app. No create call.                                                             | ran       |
| Agent, signed in, SDK keyless file only, runs `clerk init` (Next.js)                                                        | Creates a new app                                                                              | Links the SDK app if it's in the account; otherwise stops with "`clerk open` to claim it". No create call. | today ran |
| Agent, signed in, no keys, runs `clerk init` (Next.js)                                                                      | Creates a new app (no app list call); on React, prints manual setup                            | unchanged (creating is what `init` is for here)                                                            | ran       |

### Other messages that are wrong today

| Site                                                                                    | Situation                            | Today                                                                                                                                                                                                                                                  | Evidence |
| --------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `doctor`                                                                                | Signed out, Dashboard keys in `.env` | Both checks call the app "the unclaimed accountless application" and say "Claim it from the Clerk Dashboard"                                                                                                                                           | ran      |
| `doctor`                                                                                | Signed in, init token                | "Project linked" warns with remedy "Run `clerk link` to use the full account configuration", which leads to row 2's picker                                                                                                                             | ran      |
| `config pull` warning                                                                   | Signed in, an unclaimed app's keys   | "Run `clerk link` (or pass --app <app_id>)"                                                                                                                                                                                                            | ran      |
| `clerk open`                                                                            | Plain keys, no claim link on disk    | Advises `clerk init --accountless` to "regenerate a claim link". That creates a new app and overwrites the `.env` keys, because `init`'s keep-the-existing-app check only looks for the init token and the SDK keyless file (`init/index.ts:651-697`). | read     |
| `lib/copy.ts:33, 50, 54, 58, 62`, `lib/keyless-target.ts:239`, `init/heuristics.ts:168` | Any folder without an init token     | "Run `clerk auth login` to claim it", which doesn't claim an SDK-created app or prove anything about plain keys                                                                                                                                        | read     |

## Conventions both PRs share

- **Tests.** Every new test that reproduces a bug from the tables above must be run against `origin/main` first and seen to fail. Note the failure in the PR description. A test that has never failed may not be checking anything.
- **Browser.** The integration harness doesn't stub `lib/open.ts` today. Milestone 1 adds that stub. Any test that walks through sign-in must run with it.
- **Credentials in unit tests.** `deploy`'s unit tests use a real temporary config directory and don't mock the credential store. Code that checks sign-in on those paths must be tested with `_setTokenOverride` (`lib/credential-store.ts:459`) or a module mock. Otherwise the test reads the developer's real keychain.
- **Rationale in code.** Each non-obvious rule in this plan goes into a comment at the code that enforces it. Examples: why the guard runs after the claim, why "same app" means the same Frontend API host, and why the lead sentences stay verbatim.
- **Checks before handing over each PR.** Run `bun run format`, `bun run lint`, `bun run typecheck`, `bun run test`, and `bun changeset status --since=origin/main`. The E2E suite (`bun run test:e2e:op`) doesn't exercise any of these paths: its fixtures pre-link with `clerk link --app`, and nothing in it claims. Don't count it as coverage.
- **Changesets.** Each PR is a user-facing fix. Create its changeset with the repo's `changesets` skill (`/changesets create`), as `.claude/rules/changesets.md` requires.
- **Working rules.** Don't commit, push, or open a PR until Shane approves after review. PR 1 needs its own branch from `origin/main`, named after the new ticket. PR 2 continues on `shane/grow-1249-clerk-deploy-deploy-status-and-link-tell-unclaimed-apps-to`, rebased onto PR 1's branch.
- **Real runs.** A from-source run on macOS uses the `clerk-cli-dev` keychain namespace, which may hold a real session. Don't run `link`, `auth login`, `init`, `open`, or `doctor` from source against a real account. Use the integration harness for every state. A real claim needs Shane's approval and a throwaway account.

---

## PR 1: `link`, `auth login`, and `init` claim or match the folder's own app

### Milestone 1: the integration harness stubs the browser launcher

This milestone is small. The harness gains a module mock for `lib/open.ts` whose `openBrowser` records the URL and returns success without launching anything. No integration test references `openBrowser` today, so nothing else changes.

**Done when:**

- A harness test that runs `clerk auth login` signed out completes.
- The stub recorded the authorize URL.
- No browser opened on the developer's machine.
- It's a test-only change, so no changeset is needed for it.

### Milestone 2: the shared claim step never relinks a folder or overwrites its keys

**Goal and outcome.** `attemptAutoclaim` in `lib/autoclaim.ts` is the one routine that claims an init app, links the folder, and pulls its keys. Both `clerk auth login` and (after milestone 4) `clerk link` call it. After this milestone:

- A claim whose app matches the folder's keys links the folder and pulls keys, as today.
- A claim whose app doesn't match the folder's keys still claims (the token is spent) but leaves the folder's link and env files untouched, and the command says so and names the next step.
- A claim in a folder already linked to a different app leaves that link and the env files untouched, and says so.
- A failed or refused claim behaves as today.

**Implementation outline.**

1. After a successful claim and before `linkApp` and `pull`, decide whether to set up the folder. In this order:
   - **The folder is linked to a different app** (`resolveProfile(cwd)` returns a profile whose `appId` differs from the claimed app): leave it, with reason "linked elsewhere".
   - **The folder has a decodable local publishable key** (`findLocalPublishableKey(cwd)` in `lib/keyless-target.ts`: env var, then `.env` files, then the SDK keyless file) **whose Frontend API host matches none of the claimed app's instances**: leave it, with reason "different keys".
   - **The claim response has no `instances` array** (`login.ts` already tolerates this; see the test at `login.test.ts:729`): fetch the app once. If the fetch fails, leave it, with reason "unverified".
   - **No local publishable key:** link and pull as today. A folder with no keys is what a claim should set up.
2. Clear the init token after any successful claim, matched or not, as today. The token is spent either way.
3. Keep `attemptAutoclaim`'s never-throws contract.
4. Extend the result so callers can say what happened. The contract is the point here; the names are the implementer's:

   ```ts
   type Claimed = {
     status: "claimed";
     app: Application;
     local:
       | { kind: "linked"; envPulled: boolean }
       | { kind: "unchanged"; reason: "linked_elsewhere" | "different_keys" | "unverified" };
   };
   ```

5. Update `handleAutoclaim` and `loginNextSteps` in `commands/auth/login.ts` to print the unchanged case:
   - It names the claimed app and where it now lives (the Dashboard URL line printed today).
   - It says the folder's link and keys were left alone, and why.
   - It gives the next step: "Run `clerk link` to link the app this folder's keys belong to" for different keys. For linked elsewhere: "This folder stays linked to `<other>`; run `clerk link --app <claimed id>` to switch".
   - Add matching `NEXT_STEPS` entries in `lib/next-steps.ts`.

**Definition of done.**

- Unit tests in `lib/autoclaim.test.ts`:
  - Matching keys link and pull.
  - Different keys leave both alone and report `different_keys`.
  - A folder linked elsewhere leaves both alone.
  - Missing `instances` fetches once and links on a match.
  - Missing `instances` with a failed fetch reports `unverified` without linking.
  - No local key links.
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

- **If claiming changes the app's publishable key, the guard refuses every legitimate link** (open decision 2). Until that's confirmed, keep a harness test for the common case (keys from `init`, no link) so a regression is visible.
- **A key that `findLocalPublishableKey` reads from an env var** set by a parent shell counts as the folder's key. That matches how the rest of the CLI resolves keys, so leave it.
- **The fetch for a missing `instances` array is a new network call** on the claim path. It runs only after a successful claim, so it adds no call on error paths.

### Milestone 3: `clerk auth login` claims with the current session before asking to re-authenticate

**Goal and outcome.** A signed-in person whose folder has an init token can claim by running `clerk auth login` without signing in again.

- **Person, signed in, init token present, no `-y`:** the claim runs first with the current session, then the existing "Re-authenticate?" question is asked (this is Option A; under Option B, one question names the account instead). Answering No ends normally, with the claim's next steps.
- **Person, signed in, no init token:** unchanged. Answering No still ends as a user abort.
- **`-y` and agent mode:** unchanged.

**Implementation outline.**

- In `runLogin` (`commands/auth/login.ts:206-275`), when a session exists, the mode is person, `yes` is false, and an init token is present (`peekKeylessBreadcrumb(process.cwd())`), call `handleAutoclaim` before the confirm.
- If the person then declines, run the outro with `loginNextSteps(claimResult)` and return the existing session instead of calling `throwUserAbort()`.
- If they accept, continue to the browser flow. The post-sign-in autoclaim then finds no token and returns `not_keyless`. After a `failed` or `managed_workspace` result the token is kept, so the post-sign-in autoclaim retries, which is today's retry behavior.
- The decline path ends as success only when a claim ran. Record that in a comment, because telemetry reads the outcome.

**Definition of done.**

- Update `login.test.ts`:
  - Person, session, and token claims before the confirm, and declining doesn't throw `UserAbortError`.
  - Person, session, and no token still throws on decline (keep the test at `login.test.ts:613`).
  - `-y` with a token claims after the browser flow, not before.
  - Agent mode is unchanged.
- An integration test reproducing "person, signed in, init token, answers No" must fail on `origin/main` first. Assert:
  - the claim request was sent;
  - the profile names the init app;
  - the token file is gone;
  - the exit code is 0.
- `commands/auth/README.md` describes the new order.

**What could go wrong.**

- **Option A's wrong-account claim** (open decision 1).
- **Telemetry for that path changes from `abort` to `success`.** Note it in the PR description so nobody reads it as a drop in aborts.

### Milestone 4: `clerk link` claims first, matches the SDK keyless file, and stops instead of guessing

**Goal and outcome.** `clerk link` links the app the folder actually runs on, or stops and says how to claim it. Because `clerk init` links through `link()` (`init/index.ts:618-634`), `init` reruns get the same protection in both signed-in paths.

- **Signed in, not linked, init token, no `--app`:** `link` claims the init app and links it, in both modes. This fixes row 2 and both `init` rerun rows.
- **Signed in, claim leaves the folder unchanged because of different keys:** `link` prints the claim notice, then continues with its normal key detection, which finds the app the folder's keys belong to if it's in the account.
- **The claim is refused (managed workspace, no organization):** `link` stops with the claim warning (`not_linked`, exit 1, per open decision 3) instead of showing a picker.
- **The claim fails temporarily:** `link` rethrows the underlying error.
- **The token is stale and the claim returns not found:** `link` continues normally, because the app may already be in the account and detection finds it.
- **Signed out, person, init token:** unchanged. `ensureAuth` signs in, sign-in claims and links, and `link` then sees the folder is linked and finishes without asking "Link to this application?" again.
- **The folder's only key is in the SDK keyless file:** key detection includes that file's publishable key. A match links, as for any detected key. No match stops with `usage_error`, exit 2, and advice to claim with `clerk open` and then run `clerk link`, or to choose an app with `clerk link --app <app_id>`. This applies to:
  - an agent's auto-link;
  - a person's detection step, instead of the picker;
  - `init`'s create-if-missing path, before any create call.
- **`--app` given or folder already linked:** no claim, no SDK check. Explicit targets win.

**Implementation outline.**

1. **Claim-first position.** In `link()` (`commands/link/index.ts:33-111`), right after the existing-profile handling and before the `autolink` call at line 50-53, add the claim. It runs when there's no profile, no `options.app`, an init token is present, and the caller is signed in in the sense `ensureAuth` already uses (`CLERK_PLATFORM_API_KEY` or a stored token).
   - It must come before `autolink`, because `init` calls `link({ skipIfLinked: true, createIfMissing })` and `autolink` or `createApplication` would otherwise run first.
   - It must also come before the agent-mode usage error.
2. **Reuse the claim routine.** Use `attemptAutoclaim` from milestone 2. Map each result as described in the outcomes above.
3. **Finish if sign-in already linked the folder.** After `ensureAuth()`, if the folder is now linked (sign-in's autoclaim linked it), finish with the success line instead of running `resolveApp`.
4. **Include the SDK keyless file's key in detection.** In `findClerkKeys` (`lib/autolink.ts:21-55`), add the SDK keyless file's publishable key at the lowest priority, after env var, `.env`, and `.env.local`. Reuse `readSdkKeylessApp` from `lib/keyless-target.ts`.
5. **Stop instead of guessing.** A folder counts as "SDK-only" when the only detected key came from the SDK keyless file. When an SDK-only folder has no match, stop before `pickOrCreateApp`, before `createApplication`, and in place of the agent usage error. A folder with plain keys and an SDK keyless file is not SDK-only; its plain keys win, as they do everywhere else.

**Definition of done.**

- Unit tests in `link/index.test.ts`, which already mocks the credential store, login, autolink, and the API:
  - Signed in with a token claims before autolink and before the picker, in both modes.
  - Each claim result maps as described, including "unchanged, different keys" continuing to detection.
  - `--app` and an existing profile skip the claim.
  - Signed-out person with a token doesn't prompt again after sign-in linked the folder.
  - SDK-only with a match links.
  - SDK-only with no match stops in both modes, with `usage_error` and exit 2, and never calls `pickOrCreateApp` or `createApplication`.
- Unit test in `lib/autolink.test.ts` for the SDK key's position in `findClerkKeys`.
- Integration tests reproducing the "ran" rows, each failing on `origin/main` first:
  - **Row 2 (person, signed in, init token, `clerk link`):** assert the claim request, the profile names the init app, `.env` unchanged, and no applications list request.
  - **Person `clerk init` rerun, signed in, init token:** assert the profile names the init app and `.env.local` still holds its keys.
  - **Agent `clerk init` rerun, signed in, init token, Next.js:** assert no `POST /v1/platform/applications`.
  - **Agent `clerk init`, signed in, SDK keyless file only, Next.js:** assert no `POST /v1/platform/applications` and a `usage_error` with exit 2.
  - **Agent `clerk link`, signed in, SDK keyless file whose key matches an account app:** assert it links that app.
- `commands/link/README.md` describes claim-first, SDK matching, and the stop.
- `commands/init/README.md` (its rerun-protection section near line 341) says signed-in reruns are protected through `link`.

**What could go wrong.**

- **Every caller of `link()` inherits the new behavior:** `init`, `migrate` (interactive only, `migrate/run.ts:235-237`), and `doctor --fix`. `init`'s own tests replace `link` with a stand-in (`test/lib/init-harness.ts`), so they won't catch `init` regressions; the integration tests above are what does.
- **A claim with only `CLERK_PLATFORM_API_KEY` set (no OAuth session) is untested against the real API.** If the endpoint rejects API keys, `link` rethrows that error. That's acceptable, but say so in the PR description.
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
     keySource?: string; // for unknown_owner: ".env.local", "CLERK_SECRET_KEY env var", for display
   };

   // Pure: decides the kind from facts. doctor calls this with its memoized facts.
   export function classifyUnlinkedFolder(facts: UnlinkedFolderFacts): UnlinkedFolder;

   // Reads the facts for `cwd`. Never throws. No side effects.
   export async function readUnlinkedFolder(cwd: string): Promise<UnlinkedFolder>;

   // The step text for one situation, plus runnable commands for agent JSON.
   export function unlinkedFolderNextStep(
     folder: UnlinkedFolder,
     context: { agent: boolean; rerun?: string },
   ): { text: string; examples: Example[] };
   ```

2. **The four kinds.**
   - `init_app`: an init token is present, whatever else the folder holds. The token is the strongest signal, and the claim guard from milestone 2 makes acting on it safe even when the folder's keys belong to another app.
   - `unknown_owner`: a secret key from an env var, `.env`, or `.env.local`, and no init token. The app may be in this account, in another one, or unclaimed with its token lost. The wording must never call it unclaimed.
   - `sdk_app`: no init token, no plain key, and the SDK keyless file holds a key.
   - `no_app`: none of the above.
3. **Reading the facts.**
   - **Init token:** use `peekKeylessBreadcrumb` (no side effects; `readKeylessBreadcrumb` deletes a malformed file).
   - **Key and its source:** use `findLocalSecretKey`, which doesn't throw, so a malformed key can't turn a `not_linked` error into `invalid_key_format`.
   - **Signed in:** use `hasAccountCredentials`. A credential read failure, such as a sandboxed keychain, counts as signed out. That wording only adds a sign-in step, which is harmless.
4. **Avoid an import cycle.** `lib/config.ts` will call the reader (milestone 7), and `lib/keyless-target.ts` imports `lib/config.ts`. Put the classifier in its own module, and make sure it doesn't import `lib/config.ts` directly or through `keyless-target.ts`. One way is to move the local key readers it needs (`findLocalSecretKey`, `readSdkKeylessApp`, and their helpers) into a leaf module that `keyless-target.ts` re-exports, so existing importers don't change.
5. **Next-step wording.** These are drafts for review. The implementer may polish wording but not change which commands each cell names. Every site supplies its own lead sentence, and `rerun` appends "then rerun `<command>`".

   | Kind            | Person (signed in or not; `clerk link` signs in itself)                                                                                                                                              | Agent, signed in                                                                             | Agent, signed out                                                |
   | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
   | `init_app`      | This folder's app was created by `clerk init` and isn't in an account yet. Run `clerk auth login` to claim it; that also links this folder.                                                          | same                                                                                         | same, noting it opens a browser and a person must finish sign-in |
   | `sdk_app`       | This folder runs on an app the Clerk SDK created during development, which isn't in an account yet. Run `clerk open` to claim it in the Clerk Dashboard, then run `clerk link`.                      | same                                                                                         | `clerk open`, then `clerk auth login`, then `clerk link`         |
   | `unknown_owner` | This folder has a Clerk key in `<keySource>`. Run `clerk link`; it finds the app in your account by that key. If it can't, the app isn't in this account: link one with `clerk link --app <app_id>`. | same                                                                                         | `clerk auth login`, then `clerk link`                            |
   | `no_app`        | Run `clerk link` to choose one of your apps, or `clerk init` to create one.                                                                                                                          | `clerk apps list --json`, then `clerk link --app <app_id>`; or `clerk init` to create an app | `clerk auth login` first, then as signed in                      |

   `examples` lists the same commands in order, each with a one-line description, ending with the `rerun` command when given. Sites attach `examples` to the error only in agent mode.

**Definition of done.**

- A table test over real temporary directories (files written to disk, credentials toggled with `_setTokenOverride` and `CLERK_PLATFORM_API_KEY`). Rows, each run signed in and signed out:
  - init token only;
  - init token with `.env` keys;
  - init token with only the SDK keyless file;
  - SDK keyless file only;
  - SDK keyless file with `.env` keys (expect `unknown_owner`);
  - `.env` only;
  - `.env.local` only;
  - secret key in an env var only;
  - a malformed key (expect `unknown_owner`, no throw);
  - nothing.
  - A run from a subdirectory of a folder with keys expects `no_app`, which documents the limitation.
  - A malformed token file is still on disk after reading.
- Unit tests for the wording that assert which commands are named, not whole strings:
  - `init_app` names `clerk auth login`.
  - `sdk_app` names `clerk open` before `clerk link`.
  - `unknown_owner` never contains "unclaimed".
  - `no_app` names both `clerk link` and `clerk init`.
  - No output ever contains `deploy --app`, `init --accountless`, or a URL.
  - Agent signed-out cells start with `clerk auth login` (except `init_app`, where it is the step).
- Each test is seen failing at least once, for example by temporarily breaking the precedence.

**What could go wrong.**

- **An import cycle through `lib/config.ts`.** Run `bun run typecheck` and `bun run lint`, and check that `lib/config.ts` doesn't import the classifier module transitively.
- **Wording drift.** Later milestones must not write their own step text. Any site that needs something new extends `unlinkedFolderNextStep`.

### Milestone 6: `deploy`, `deploy status`, and agent-mode `link` use the classifier

**Goal and outcome.** The messages from the state table's "`deploy` advises after PR 2" column, per row.

- `clerk deploy` and `clerk deploy status` still exit 1 with `not_linked` and still start with "No Clerk project linked to this directory.", then give the classified step and "then rerun `clerk deploy`" (or `clerk deploy status`).
- Agent-mode `clerk link` still exits 2 with `usage_error` and still starts with "Cannot select an application in agent mode.", then gives the classified step. The signed-in `no_app` case keeps today's "Pass --app <id>, or run `clerk apps list --json` and retry."
- Agent JSON includes `examples`.

**Implementation outline.**

- Replace the three inline throws with one helper in the `deploy` command folder that calls `readUnlinkedFolder` only on the failure path. The throws are at `deploy/index.ts:134` (agent handoff), `deploy/index.ts:148` (person), and `deploy/status-command.ts:48`. A successful run reads nothing extra.
- Leave `resolveDeployContext` (`deploy/status.ts:191`) as it is.
- `deploy/errors.ts:86-91` (the linked app no longer exists) stays as it is; its "re-link" advice is right for that case.
- For agent-mode `link`, reuse the classifier at `link/index.ts:55-59`.

**Definition of done.**

- One or two mapping tests per command: given a classified folder, the error has the expected lead sentence, code, exit code, and first example command. Update the existing assertions at `deploy/index.test.ts:2663-2677` and in `status-command.test.ts`. They use a real temporary config directory, so set credentials with `_setTokenOverride`.
- In the integration harness, one table-driven test per command (`deploy`, `deploy status`, agent `link`) over the four kinds. Assert the JSON `error.code`, the exit code, and `error.examples[0].command`. Assert that person-mode output has no "Examples:" block.
- The existing telemetry assertions (`not_linked`, stage `null`) still pass unchanged.
- `commands/deploy/README.md` and `commands/link/README.md` describe the advice per situation.

**What could go wrong.**

- **Changing the lead sentence** breaks the skill's troubleshooting lookup. The integration tests should assert it verbatim.

### Milestone 7: `doctor` uses the classifier

**Goal and outcome.**

- **Signed out with plain keys:** `doctor` no longer calls the app unclaimed. Its message says the folder uses the secret key from `<source>` and isn't linked, then gives the `unknown_owner` step.
- **Signed in with an init token:** "Project linked" names the claim step.
- **SDK-only folder:** names `clerk open`.
- Statuses and `fix` labels are unchanged. `doctor --fix` still runs `link`, which after PR 1 does the right thing in each case.

**Implementation outline.**

- `doctor` already holds the facts in its memoized context (`doctor/context.ts`: `getKeylessTarget`, `hasClaimBreadcrumb`, `hasAccountCredentials`). Build `UnlinkedFolderFacts` from them and call the pure `classifyUnlinkedFolder`, so `doctor` keeps its no-side-effects and one-read-per-fact guarantees.
- Replace `claimHint` (`checks.ts:88`) and the keyless branches of `checkLoggedIn` (`checks.ts:134-141`) and `checkProjectLinked` (`checks.ts:272-293`). Keep the words "unclaimed accountless application" only for `init_app` and `sdk_app`.

**Definition of done.**

- Update the `doctor.test.ts` cases that assert "unclaimed accountless application" and "Claim it". Add cases for:
  - signed out with plain keys (must not contain "unclaimed");
  - signed in with an init token (names the claim step; no test covers the token branch today);
  - SDK-only (names `clerk open`).
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

**Definition of done.**

- One test per site asserting the named commands. For `open`, also assert that `init --accountless` no longer appears.
- One harness run of `clerk config pull` signed in with an unclaimed app's keys and an init token, asserting the warning names `clerk auth login`.
- Update `commands/open/README.md` if it describes the removed advice.

**What could go wrong.**

- **`lib/config.ts` gaining the classifier** is the import-cycle risk from milestone 5.

### Milestone 9: messages that say "`clerk auth login` will claim it" use the classifier

**Goal and outcome.** Advice to claim names `clerk auth login` only when an init token exists. Otherwise it names `clerk open` (SDK-created app) or the `unknown_owner` step.

**Implementation outline.**

- **`lib/copy.ts:33, 50, 54, 58, 62`**: add a parameter carrying the classified folder (or its step text). Their callers already know they're in an unlinked, keyless context: `config/push.ts:63`, `config/schema.ts:20`, `config/keyless.ts:177`, `users/open.ts:85`, `billing/index.ts:68`. Keep each message's first sentence.
- **`lib/keyless-target.ts:239`** (`--instance` on an unclaimed app): same treatment.
- **`init/heuristics.ts:168` `printExistingKeylessInfo`**:
  - Its caller (`init/index.ts:676-680`) knows whether it kept an init-token app or an SDK-created one.
  - The SDK variant names `clerk open` and says the keys are in `.clerk/.tmp/keyless.json`, not the env file.
  - `printKeylessInfo` (`:156`) stays as it is; it runs right after `init` wrote a token.
  - GROW-1242 plans to rewrite `printKeylessInfo` in the same file, so expect a trivial merge.

**Definition of done.**

- Tests for each changed message asserting `clerk auth login` appears only for `init_app`.
- An `init` test where the existing app is SDK-created asserts the `clerk open` wording.

**What could go wrong.**

- **Missed callers of the changed `copy.ts` functions.** `bun run typecheck` catches them, because the signatures change.

### PR 2 wrap-up

- **Changeset:** a user-facing fix, created with `/changesets create`.
- **READMEs:** `deploy`, `link`, `doctor`, `open` (milestones 6 to 8).
- **Checks:** the commands in "Conventions both PRs share".
- **Prove it works:**
  - Run the integration tests and paste the per-command, per-kind output (JSON error and exit code) into the PR description.
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
  - `.clerk/keyless.json` present: run `clerk auth login`, but only when the folder isn't linked and its env files hold no keys pasted from the Dashboard. On CLIs without PR 1, a leftover token otherwise relinks the folder and overwrites its keys.
  - Only `.clerk/.tmp/keyless.json` present: ask the person to claim the app with `clerk open`, then run `clerk link`.
  - Neither present: `clerk link`, signing in first if needed.
- Agents with `deploy` never pass `--app`; they link first with `clerk link --app <id>`.

**Passages (at `origin/main` 8482d43):**

- `skills/clerk-cli/references/auth.md:95` and `:171`;
- `skills/clerk-cli/references/agent-mode.md:274` and `:71`;
- plus the three passages in open decision 5 if Shane agrees.

**Process.** Read the skills repo's `AGENTS.md` and `STYLEGUIDE.md` first. Run `npm test` and `npm run check`. The PR needs an approval from a code owner in `@clerk/docs`, `@clerk/ai-enablement`, or `@clerk/growth` (`.github/CODEOWNERS`); say so in the PR description. The PR template requires a review deadline (or "No rush") and a link to the CLI PR. Apply the `do not merge` label if it must wait for a CLI release. Ship order is Shane's call (open decision 6).

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

- **The shared claim step** (`lib/autoclaim.ts`) leaves the folder's link and keys alone when the claimed app doesn't match the folder's publishable key or the folder is linked elsewhere, and says so.
- **`clerk auth login`** claims with the current session before asking to re-authenticate.
- **`clerk link`** claims first when signed in with an init token.
- **`clerk link` also matches the SDK keyless file's key** against the account, and stops with "claim it with `clerk open`" instead of the picker when nothing matches.
- **`clerk init` reruns** get the same protection through `link`.

**Tests:** integration tests that reproduce each case above, failing on `main` before the fix.

**Not in this ticket:**

- Message wording for unlinked folders (GROW-1249).
- `clerk init --app <id>` in a folder with an init token (an explicit choice).
- The picker for plain keys that match no account app.

### GROW-1249, rewritten

**Title:** `clerk deploy`, `deploy status`, `link`, and `doctor` give one piece of advice for four different unlinked folders

**Body:**

On a folder that isn't linked to an app, `clerk deploy` and `clerk deploy status` always say "run `clerk link`", and agent-mode `clerk link` always says "pass `--app <id>`". The right step depends on what the folder holds:

- An app `clerk init` created needs `clerk auth login`.
- An app a Clerk SDK created needs claiming in the Dashboard (`clerk open`), then `clerk link`.
- Keys from an app already in the account need `clerk link`.
- No keys at all needs `clerk link` or `clerk init`.

`doctor` is wrong in two of these: it calls Dashboard keys "unclaimed", and it tells a signed-in person with an init token to run `clerk link`. About 620 `deploy` runs a month end with `not_linked` (30 days to Sep 11); the count can't separate these folders. The `clerk-cli` skill repeats the same advice.

Split out of [GROW-1235](https://linear.app/clerk/issue/GROW-1235/fix-misleading-and-missing-text-in-the-clerk-deploy-wizard-and-help) on 2026-09-16. Observed on CLI 3.3.0; reverified on `main` at `2133e7ea3` with the integration harness. Evidence: [Walkthrough](https://app.notion.com/p/3db2b9ab44fe8198b7ddcd520562a49a) (Flag 5) · [Improvement plan](https://app.notion.com/p/3dc2b9ab44fe816ea395cd4c42e5cb6d) (Theme 1, item 2). Depends on the new bug ticket, whose fixes make several of these messages true.

**1. CLI (PR 2).**

- One classifier of unlinked folders, from local files only: init token, then plain keys (ownership unknown), then the SDK keyless file, then nothing.
- Every site that says "run `clerk link`" or "`clerk auth login` will claim it" uses it:
  - `deploy` (two sites), `deploy status`, and agent-mode `link`;
  - `doctor` (both checks; text changes, statuses don't);
  - the generic not-linked error in `lib/config.ts`;
  - `clerk open`, dropping its `clerk init --accountless` advice, which creates a new app and overwrites keys;
  - the "covers fewer settings" warning;
  - `lib/copy.ts`, `lib/keyless-target.ts:239`, and `init/heuristics.ts:168`.
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
