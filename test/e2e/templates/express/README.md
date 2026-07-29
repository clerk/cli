# Express e2e fixture

Minimal TypeScript Express server used to verify that `clerk init` wires
`clerkMiddleware()` into a real project. There is no official Express
scaffolder, so this template is checked in by hand; the fixture refresh script
copies it and resolves the `latest` dependency specs to exact pins.

Notes:

- `index.ts` parses the `--port` / `--host` flags the e2e dev-server helper
  appends, and is run with `node --env-file=.env.local index.ts` (Node >= 23
  strips types natively; `erasableSyntaxOnly` in tsconfig keeps that true).
- The tsconfig deliberately has no `include`, so the `types/globals.d.ts`
  request-type augmentation created by `clerk init` is picked up by `tsc`.
