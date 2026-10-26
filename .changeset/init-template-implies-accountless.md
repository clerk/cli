---
"clerk": minor
---

`clerk init --template <name>` now implies `--accountless`, so it creates a pre-configured accountless application even when you're signed in or the project is linked, instead of exiting with an error. It still errors with `--login`, `--app`, or a framework without accountless support.
