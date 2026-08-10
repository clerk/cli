---
"clerk": patch
---

Fix `clerk auth login` in WSL2, SSH, and headless environments: the sign-in URL is now always printed as a copy-friendly manual fallback, WSL launches the Windows host browser via PowerShell interop when `wslview` is not installed, and the authentication timeout error now explains how to recover.
