---
"clerk": minor
---

Add specialized user mutation commands: `clerk users metadata` patches public/private/unsafe metadata from JSON input, `clerk users profile-image` uploads or removes the profile image, `clerk users password --verify` verifies a supplied password, and `clerk users mfa` disables MFA, removes TOTP or backup codes, or verifies a TOTP code.
