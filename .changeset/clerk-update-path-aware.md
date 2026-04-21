---
"clerk": minor
---

Fix `clerk update` silently writing to the wrong installer when multiple `clerk` binaries exist on PATH. The command now walks PATH to identify the binary the user's shell will actually execute, determines which installer owns that specific path (via a new `ownerOfBinary()` check), and runs the corresponding installer. Binaries installed outside any known package manager (e.g. via `install.sh`) are refused with reinstall guidance rather than silently updated via npm. Also fixes bun detection, which previously matched the shim dir (`~/.bun/bin`) instead of the install dir (`~/.bun/install/global/node_modules`) and fell through to the npm fallback. Adds a `--all` flag to update every `clerk` install on PATH in one run, skipping Homebrew on non-stable channels and unknown-owner binaries with a warning. Prints a `hash -r` / `rehash` hint based on `$SHELL` after a successful update.
