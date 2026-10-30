---
"clerk": patch
---

`clerk init` now wraps a `<body>` that shares its line with other markup, such as `<html lang="en"><body>{children}</body></html>`, in `<ClerkProvider>`. When it can't wrap the body, it says manual wrapping is needed instead of reporting a wrap.
