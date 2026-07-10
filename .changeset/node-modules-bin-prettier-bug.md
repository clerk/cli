---
"clerk": patch
---

Prevent `clerk init` from executing an attacker-planted `node_modules/.bin/{prettier,biome,skills}` binary from the project being set up. The formatter and skills steps now pin the package runner to the registry (`bunx --package <pkg>@latest -- …`, and the pnpm/yarn `dlx` equivalents) so it runs the real tool instead of a project-local bin shadow.
