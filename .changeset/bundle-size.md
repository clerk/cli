---
"clerk": patch
---

Reduce the size of the published `clerk` binary and JS bundle by enabling minification during the build. The compiled binary shrinks by ~1 MB across all platforms, and the bundled `cli.js` artifact shrinks by ~41% (2.37 MB → 1.40 MB), with no change to behavior.
