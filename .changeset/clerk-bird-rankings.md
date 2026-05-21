---
"clerk": patch
---

Add a local leaderboard to the hidden `clerk bird` easter egg: from the GAME OVER screen, press `N` to enter your name and `L` to view the top scores. On the leaderboard, use `↑`/`↓` (or `j`/`k`) to select a row and `D` to delete it (with `Y`/`N` confirmation). `k` now also flaps in-game, alongside `SPACE`, `↑`, `W`, and `ENTER`. Rankings are stored as JSON in `~/.flap-rankings.json` (top 10, ties broken by older entry). The existing `~/.flap-best` file is unchanged. Pipe-passes and the death event now emit a short bell tone (ASCII BEL) so the `+1` and the GAME OVER moment each have audio feedback; terminals with the bell disabled stay silent and the host terminal handles cross-platform behavior on Windows, macOS, Linux, and any POSIX TTY. The `bird` command is no longer hidden and now appears at the bottom of `clerk --help` (after the `help` row) so the easter egg is discoverable without cluttering the main command surface.
