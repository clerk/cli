---
"clerk": patch
---

Harden the dependency-install step of `clerk init`. Previously, the package-manager spawn in attacker-controlled cwd could execute arbitrary JavaScript via pnpm's `.pnpmfile.cjs` autoload or via lifecycle scripts (`preinstall`/`install`/`postinstall`) in the project's `package.json`. The install command now passes `--ignore-pnpmfile` (pnpm) and `--ignore-scripts` (all package managers).
