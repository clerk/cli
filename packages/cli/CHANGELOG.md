# clerk

## 0.0.2

### Patch Changes

- Enrich changelog entries with PR links, commit links, and contributor handles. Generated CHANGELOG.md sections now include `(#123)` PR references and `by @user` attribution alongside each release line. ([#167](https://github.com/clerk/cli/pull/167)) by [@wyattjoh](https://github.com/wyattjoh)

- Fix biased character distribution in PKCE code verifier generation. Replaces `byte % CHARSET.length` with rejection sampling so every character in the 66-entry charset is equally likely, restoring full entropy. ([#171](https://github.com/clerk/cli/pull/171)) by [@wyattjoh](https://github.com/wyattjoh)
