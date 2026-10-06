---
"clerk": minor
---

Add `clerk migrate export authjs`, and let `clerk migrate import` read Auth.js exports. The export reads an Auth.js database over `--db-url` (Postgres, MySQL, libsql/Turso or SQLite), finding the user table whether Prisma or Drizzle named it. Auth.js stores no passwords, so imported users sign in with OAuth or an email link, or set a password. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
