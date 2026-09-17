---
"clerk": patch
---

`clerk deploy` copy fixes: `--help` describes what the bare command does and its agent-mode JSON report; the preamble says a host-generated URL can't be the production domain; the confirmation screen lists all five DNS record hosts, including DKIM; the DNS check reports records as "not found yet" with a minutes-not-days expectation; the wizard and `clerk auth login` print the app's Dashboard URL; the Google walkthrough includes the consent-screen app name. Agent-mode `nextAction` tells the agent to add pending DNS records instead of polling, and at `complete` says the production keys still have to reach the host alongside the other Clerk variables.
