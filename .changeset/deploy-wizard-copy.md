---
"clerk": patch
---

`clerk deploy` copy fixes:

- `clerk deploy --help` describes what the bare command does and the JSON report it prints under an agent.
- The preamble says a hosting provider's generated URL can't be the production domain.
- The confirmation screen lists all five DNS record hosts, including DKIM, and says DNS records will be needed for them once the instance exists.
- The DNS check reports records as "not found yet" with a minutes-not-days expectation, tells you what to do based on what's actually pending, and links the Dashboard Domains page for changing the domain.
- `clerk auth login` prints the claimed app's Dashboard URL; the wizard prints the new production instance's URL and its next steps say the pulled keys go on the host alongside the other Clerk variables.
- The Google walkthrough adds a tip explaining that the OAuth consent screen's app name is what users see when they sign in, and to choose the name they should see.
- The DNS check footer points at the "Check again" prompt that follows it instead of telling you to quit and re-run; the closing screen no longer says "Production ready", "sign up at your domain", or "Success" when DNS verification was skipped.
- Resuming the wizard shows only the DNS records still outstanding, not ones Clerk already verified.
- Each DNS record host is named the same way on every screen, the note about what Clerk manages moved off the rows the user has to add, the Domains-page pointer carries its link, and the closing line says what happens next instead of implying that skipping the check finishes the deploy, and no longer promises an OAuth step on resume when OAuth has already run.
- Agent-mode `nextAction` tells the agent to add pending DNS records instead of polling, at `complete` says the production keys still have to reach the host, and names OAuth providers the CLI could not configure so an agent doesn't report OAuth as done. Human-mode `clerk deploy status` prints the pending records, never says "ask the user", and resumes with `clerk deploy` rather than a flag that only affects agents.
