---
"clerk": patch
---

Fix `clerk update` printing a new spinner line on every frame and tidy its output.
The spinner now wraps at the real terminal width instead of a fixed 80 columns, and its message no longer includes the install path.
The install path is shown as it appears on `PATH` (e.g. `/opt/homebrew/bin/clerk`) instead of the version-specific Homebrew Cellar folder that the upgrade removes.
The `hash -r` hint is skipped when only Homebrew installs were updated, and the duplicate "Checking for updates" line and extra blank line before the confirm prompt are gone.
