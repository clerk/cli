---
"clerk": minor
---

Add `clerk init --accountless` as the canonical flag and keep `--keyless` as a deprecated compatibility alias. `open` and `whoami` agent JSON now emit the canonical `accountless` key alongside the deprecated `keyless` alias.
