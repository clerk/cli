---
"clerk": minor
---

Add `clerk logs schema <event-type>` to show the payload fields of a log event type, with their types, whether each is optional, and the accepted values of enum fields. Pass a concrete type like `sign_in.completed`, a wildcard like `'sign_in.*'`, or a family like `sign_in` to see the fields every matched type shares. `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
