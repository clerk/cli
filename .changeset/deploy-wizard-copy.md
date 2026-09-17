---
"clerk": patch
---

`clerk deploy` copy fixes:

- `clerk deploy --help` describes what the bare command does and the JSON report it prints under an agent.
- The preamble says a hosting provider's generated URL can't be the production domain.
- The confirmation screen lists all five DNS record hosts, including DKIM, and says a record will be needed for each.
- The DNS check reports records as "not found yet" with a minutes-not-days expectation, tells you what to do based on what's actually pending, and links the Dashboard Domains page for changing the domain.
- `clerk auth login` prints the claimed app's Dashboard URL; the wizard prints the new production instance's URL and its next steps say the pulled keys go on the host alongside the other Clerk variables.
- The Google walkthrough adds a tip with the app name to use on the OAuth consent screen.
- Agent-mode `nextAction` tells the agent to add pending DNS records instead of polling, and at `complete` says the production keys still have to reach the host. Human-mode `clerk deploy status` prints the pending records.
