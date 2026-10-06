---
"clerk": minor
---

Add `clerk migrate sources`, and let `clerk migrate import --source` take the path to a source you wrote. `clerk migrate sources` lists the built-in sources with the passwords, MFA and metadata each brings across, and `clerk migrate sources <source>` shows where each field lands, how to export, and any caveats. A source you wrote is a `.ts` or `.js` file in your project, checked before use, so a platform with no built-in source can be imported without rebuilding the CLI. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
