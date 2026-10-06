---
"clerk": minor
---

Add `clerk migrate export betterauth`, and let `clerk migrate import` read Better Auth exports. The export reads a Better Auth database over `--db-url` (Postgres, MySQL, libsql/Turso or SQLite), including schemas Drizzle generated with snake_case columns or plural tables, and detects plugin columns. Better Auth's scrypt, bcrypt and argon2 passwords carry across, and anonymous users are skipped. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
