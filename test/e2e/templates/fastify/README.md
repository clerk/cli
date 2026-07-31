# Fastify e2e fixture

Minimal TypeScript Fastify server used to verify that `clerk init` registers
`clerkPlugin` on a real instance. There is no official Fastify scaffolder, so
this template is checked in by hand; the fixture refresh script copies it and
resolves the `latest` dependency specs to exact pins.

Notes:

- `index.ts` parses the `--port` / `--host` flags the e2e dev-server helper
  appends, and is run with `node --env-file=.env.local index.ts` (Node >= 23
  strips types natively; `erasableSyntaxOnly` in tsconfig keeps that true).
