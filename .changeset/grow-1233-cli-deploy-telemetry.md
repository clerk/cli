---
"clerk": patch
---

Record `clerk deploy status` on an unfinished deploy as incomplete rather than an error in usage telemetry, and give the ways a `clerk deploy` run can end their own error codes — a skipped step, an interrupted prompt and a wait on Clerk's provisioning were previously indistinguishable. Every `clerk deploy` and `clerk deploy status` event now also records the state the deploy was in when the run ended, so a run that stopped short says where, and which of DNS, SSL, email DNS and OAuth had been verified at that point — recorded only from a read that actually succeeded, so a failed status call is never reported as a failed check. Output and exit codes are unchanged.

`clerk doctor` now names the check that crashed instead of printing an anonymous "Check crashed" line (which `--json` labelled "Unknown check"), and reports a crashed check as `doctor_check_crashed` rather than `doctor_failed`, so a bug in the CLI is distinguishable from a real problem with your integration. Its `--json` results carry `crashed: true` on that check. The exit code is unchanged.
