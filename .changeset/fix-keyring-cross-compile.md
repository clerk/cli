---
"clerk": patch
---

Store macOS credentials in the system Keychain instead of a plaintext file.

- Previously, macOS builds silently stored the OAuth token in `~/Library/Application Support/clerk-cli/credentials` because cross-compiled binaries were missing the native Keychain binding.
- Run `clerk login` after upgrading so the CLI writes a fresh token into the Keychain and removes the old plaintext file.
