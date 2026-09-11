# Clerk's Legibility Problem

_Playbook, 11 September 2026. Companion to [neon-agent-distribution.md](./neon-agent-distribution.md)._

Artifact: https://claude.ai/code/artifact/50982a4f-4dff-44eb-9c34-0bd39cca53aa

**Thesis.** Neon's lead came from making one mechanic unmissable at every layer an agent touches.
Clerk has built more agent machinery than Neon — and made none of it unmissable. That is the gap,
and it is cheaper to close than a feature gap.

Agent Tasks — Clerk's runtime agent-identity primitive, the exact ground Vercel is claiming with
Better Auth — is documented at `docs/guides/development/testing/agent-tasks.mdx`. It is filed
under testing.

## How Neon actually built the lead — six moves

1. **Picked a fight where the leader's shape was the liability.** Postgres had already won as an
   engine, so the open question was only who hosts it. Neon answered the *narrow* question (a
   Postgres); Supabase answered the broad one (a backend). An agent changing one thing wants the
   narrow answer. Supabase's bundle — its greatest strength with humans — became the stated reason
   it lost the database slot.
2. **Removed the human from the critical path before anyone asked.** Dec 2024 `instagres`
   ("Instant Postgres. No signup required.") → `neondb` → `neon-new` → `neon claim create`. No
   account, no card, no browser; 72h expiry unless claimed. Two years on one idea, uncopied.
3. **Made idle free, then spent that on everyone else's free tier.** Scale-to-zero drove Neon's own
   marginal cost of an idle database to ~zero. That funded free tier 1 → 10 → 100 projects and the
   Agent Plan, where **Neon sponsors the platform's free-tier org at zero cost to the platform**. A
   product property converted into commercial leverage.
4. **Sold platforms, early, on economics — not developers on features.** Replit Jan 2023, Vercel
   May 2023, both pre-agent, both won on provisioning speed and usage-based pricing. The agent wave
   amplified a position already held.
5. **Treated agent discovery as a tested product surface.** Nine `.well-known` endpoints with CI
   validators. Docs as markdown at predictable URLs. UA detection fingerprinting `axios` ("Used by
   Claude Code") and `got` ("Used by Cursor"). 177 typed MCP tools with per-tool safety annotations.
6. **Made one sentence unmissable at six layers.** "Provision with no human present" is the first
   task in `llms.txt`, the second paragraph of the agent landing page, a claimed trigger phrase in
   the skill, a CLI command, an MCP tool, and an open-protocol implementation. **This is the move
   Clerk has not made.**

Through-line: every one of those is about being *completable*, not about being *liked*.

## Clerk's inventory is stronger than the story

Read from `clerk/cli` and a clone of `clerk/clerk-docs`. Three of these were recorded as gaps in the
earlier analysis, when clerk.com was egress-blocked. They are not gaps.

| | Status |
| --- | --- |
| Accountless applications | **Shipped.** `POST /v1/accountless_applications`, no auth header, returns keys + claim URL. Four templates. Neon's crown jewel, and Clerk has it. |
| Agent Tasks | **Shipped.** Authenticated sessions on behalf of a user without the sign-in flow. This *is* runtime agent identity — filed under testing. |
| Machine auth | **Shipped.** API keys, M2M tokens, token formats. Documented outside the AI guides. |
| Auth for MCP servers | **Shipped.** CIMD, dynamic client registration, consent screens, SDK support. Clerk as the auth layer *for* other people's MCP servers. |
| Per-page markdown | **Shipped.** `.md` routes are generated. |
| CLI agent mode | **Shipped.** `--mode agent`, `--input-json`, `clerk api` (200+ endpoints), MCP installers for 11 clients, 20+ skills. |
| Accountless framework coverage | **Partial.** 5 of 14. Bolt/Lovable/v0 emit Vite + React. |
| One unmissable sentence | **Missing.** No agent landing page, no training-override page, no `auth.md`, primitives scattered across four doc trees. |

Better Auth owns the "Agent Auth" narrative because Vercel said the words in July 2026 — not because
it shipped more. Clerk's Agent Tasks, M2M tokens, API keys and MCP-server auth are a larger claim on
that ground, published earlier, and invisible. A positioning gap wearing a capability gap's clothes.

## Ten plays, ranked

Organising sentence, borrowed from Neon's: **"Add working auth to this app with no account, no keys,
and no human."** Already true for five frameworks. Everything below makes it true more often, or
makes it findable.

- **P0 — Extend accountless to Vite/React, Vue, Expo.** 5 of 14 is the most expensive number in the
  inventory. The platforms generating the most application code emit Vite + React, exactly where the
  accountless path stops and an agent must ask a human for keys. In the independent selection study
  **48% of auth recommendations are custom/DIY**, the stated reason being that AI tools cannot
  scaffold a working hosted-auth integration without credentials. This is the difference between
  competing with Better Auth and losing to a hand-rolled session.
- **P1 — Publish the accountless contract, and make failure recoverable.** Neon publishes 72h
  expiry, 100 MB, 1 GB transfer, 15-minute claim codes, and a `pending → accepted → reconciled`
  state machine. Clerk's CLI stores only a claim token and timestamp; whether unclaimed apps expire
  is invisible to an agent. Document the limits machine-readably; make `clerk doctor` detect a dead
  keyless app and re-provision.
- **P2 — Collapse the agent surface into one page an agent will read.** Primitives live in four
  trees (`guides/ai/`, `guides/development/machine-auth/`, `guides/development/testing/agent-tasks`,
  CLI docs). Publish `clerk.com/index.md`: current version, the one command, how to detect existing
  credentials, what changed since training-data versions, links to every primitive. Make it the
  first entry in `llms.txt`. Worth more to Clerk than Neon — Clerk's API moved across majors, and
  stale recall produces code that looks right and fails.
- **P3 — Implement `auth.md`.** WorkOS's open protocol for agents to discover how to register on a
  user's behalf; Neon implements it. Clerk's accountless endpoint is functionally what the protocol
  describes and is reachable only by knowing the CLI exists. Serve `clerk.com/auth.md`.
- **P4 — Reposition Agent Tasks and machine auth as the agent-identity product.** Give it a
  top-level home and a name. Move or alias Agent Tasks out of `testing/`. Answer the Better Auth
  acquisition with the inventory Clerk already has.
- **P5 — Beat DIY, not Auth0.** The competitor in an agent loop is a 200-line hand-rolled session
  chosen 48% of the time because the agent can finish it. Ship a skill and page naming what you must
  get right rolling your own — session fixation, rotation on privilege change, CSRF on callback,
  reset-token entropy and expiry, account enumeration, timing-safe comparison — then show Clerk in
  fewer lines. Source questions from real support and agent-session logs.
- **P6 — Claim the trigger words.** Neon's router skill claims "postgres", "database", "backend"
  outright. Rewrite Clerk skill descriptions as trigger-phrase lists in the words developers type:
  "add login", "sign in", "protected route", "middleware", "session", "current user", "roles and
  permissions", "org invites".
- **P7 — Work the registry checklist.** WorkOS publishes theirs: MCP registry, GitHub registry
  feeding Copilot, Anthropic connectors directory, OpenAI apps directory, Cursor marketplace,
  aggregators. Clerk's CLI installs into 11 clients — the harder half. The listings half is a
  spreadsheet with no owner. Also chase carriage: Vercel's CLI auto-installs a Marketplace
  provider's agent skills when an integration is added.
- **P8 — Price an agent-platform tier.** Neon's dual-org plan is why platforms integrate it. You
  cannot win a platform default if that platform's free users cost it money. Auth has a friendlier
  cost curve than compute, which makes this easier for Clerk than it was for Neon.
- **P9 — Run the auth scoreboard before someone else does.** No cross-vendor measurement of what
  agents pick for auth exists. The only auth-adjacent benchmarks are vendor-run and score the
  vendor's own implementation accuracy — Clerk's LLM Leaderboard included, which answers the wrong
  question. Armature has an auth run open with no results. First credible scoreboard sets the
  framing, becomes the cited source in the retrieval pipelines this memo is about, and tells you
  whether P0–P8 worked. Instrument agent-originated `clerk init` runs that survive to a claimed
  application — that is the funnel, not mentions.

## What not to copy

- **The comparison-page farm.** Neon never built one. And `llms.txt` — the tactic everyone credits —
  is at 93% adoption by Neon's own scan of 250+ doc sites. Copying visible artifacts copies table
  stakes.
- **The AI-native feature.** `pg_embedding`, `pgrag`, the AI rules repo, the app generator, the
  agent toolkit — all retired. What survived was a fast provisioning API and two contracts.
- **The vanity denominator.** "80% agent-created" is substantially an artifact of free, sponsored,
  short-lived databases. The auth equivalent is only worth counting net of claims.
- **Optimising for the recommendation itself.** Auth carries a guaranteed human override before
  production. What agent selection buys is *being in the diff* when the human first looks — won by
  the provisioning path, not share of voice.

## Confidence

Clerk-side facts are read from the `clerk/cli` working tree and a fresh clone of `clerk/clerk-docs`
and are solid; they correct three items the earlier analysis recorded as gaps, which were wrong
because clerk.com was egress-blocked. Neon-side facts are read from `neondatabase/website`. Armature
figures come from search summaries, never the source page. The 48% DIY figure is from an independent
open-data study of 2,430 recommendations, not from Armature. The ranking and weightings here are
judgement, not measurement — which is what P9 is for.
