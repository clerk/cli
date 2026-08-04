---
---

Unversioned builds now report a version derived from the checkout they run from (`3.0.0-dev.20260803.f51f1e4`, `.dirty` for an unclean tree) instead of a flat `0.0.0-dev`. Dev-only: release binaries are compiled with an explicit `CLI_VERSION`, so published behavior is unchanged.
