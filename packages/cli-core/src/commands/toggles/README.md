# toggles

Registrar for the `enable` and `disable` feature-toggle command groups.

This directory contains **no command logic of its own**. It exists because the
`enable` and `disable` parent commands are each shared by multiple feature
folders (`orgs`, `billing`, `branch`), so neither feature folder cleanly owns the
parent. `registerToggles(program)` builds both parents and wires each feature's
enable/disable handlers under them, grouping by parent rather than by feature.

## Commands wired here

| Command                  | Handler           | Documented in                                  |
| ------------------------ | ----------------- | ---------------------------------------------- |
| `clerk enable orgs`      | `orgsEnable`      | [`../orgs/README.md`](../orgs/README.md)       |
| `clerk enable billing`   | `billingEnable`   | [`../billing/README.md`](../billing/README.md) |
| `clerk enable branches`  | `branchesEnable`  | [`../branch/README.md`](../branch/README.md)   |
| `clerk disable orgs`     | `orgsDisable`     | [`../orgs/README.md`](../orgs/README.md)       |
| `clerk disable billing`  | `billingDisable`  | [`../billing/README.md`](../billing/README.md) |
| `clerk disable branches` | `branchesDisable` | [`../branch/README.md`](../branch/README.md)   |

The handlers, their options, and the Clerk API endpoints they call live in the
`orgs/`, `billing/`, and `branch/` folders — see those READMEs for behavior and
mocking details. Activation joins the verb-first `enable`/`disable` family
deliberately: there is no `clerk branch enable` subcommand.
