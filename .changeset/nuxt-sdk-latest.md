---
"clerk": patch
---

`clerk init --starter` now installs `@clerk/nuxt@latest` for new Nuxt projects instead of the pinned `@clerk/nuxt@2.2.0-snapshot.v20260413174426`. Keyless support shipped in stable `@clerk/nuxt@2.2.0`, so the snapshot pin (originally a workaround) is no longer needed.
