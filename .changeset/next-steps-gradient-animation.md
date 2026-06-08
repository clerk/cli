---
"clerk": minor
---

Render the "Next steps" header in a dusty mauve and sweep a white reflex highlight across it once after `clerk deploy`, `clerk link`, and `clerk auth login`, then settle on the flat color. The animation only runs on an interactive color terminal and falls back to plain styling when piped, in CI, or when `NO_COLOR` is set.
