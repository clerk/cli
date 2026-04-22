---
"clerk": patch
---

Fix shell completion install tips so they work on fresh systems. The `clerk doctor` zsh remedy now leads with `eval "$(clerk completion zsh)"` and points to `clerk completion --help` for the file-based install method, and the fish remedy prefixes `mkdir -p ~/.config/fish/completions` before writing. The zsh completion script's install banner now tells users to `mkdir -p ~/.zfunc` before writing the completion file.
