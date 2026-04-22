---
"clerk": patch
---

Fix the stable release Homebrew publish step so it awaits each release upload and tap repository command before moving to the next step. This prevents the Homebrew workflow from racing past `gh release upload`, `git clone`, and the follow-up git operations while publishing a release.
