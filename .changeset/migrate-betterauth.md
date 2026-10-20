---
"clerk": minor
---

Add `clerk migrate export betterauth`, and let `clerk migrate import` read Better Auth exports. The export reads a Better Auth database over `--db-url` (Postgres, MySQL, libsql/Turso or SQLite), including schemas Drizzle generated with snake_case columns or plural tables, and detects plugin columns. Better Auth's scrypt, bcrypt and argon2 passwords carry across, and anonymous users are skipped. A user any source skips, such as Supabase's soft-deleted users, no longer stops the import: it's recorded as skipped, and `--allow-partial` is only for real rejects. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
