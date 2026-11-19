/**
 * Better Auth's "config" for the migration tests: which plugins exist decides
 * which tables and columns the database has, and that is all the CLI's
 * exporter can see. So a variation's source config is "drop every table and
 * create the schema for this plugin set".
 *
 * Also holds the Auth.js schema (schema/authjs.sql, as drizzle-kit
 * wrote it): both are Turso databases the seed and the variations rebuild.
 */
import { readFileSync } from "node:fs";
import type { Client } from "@libsql/client";
import { getAuthTables } from "better-auth/db";
import { admin, anonymous, phoneNumber, twoFactor, username } from "better-auth/plugins";

export const PLUGINS = { username, phoneNumber, admin, twoFactor, anonymous } as const;
export type PluginName = keyof typeof PLUGINS;

/** The seeded Better Auth schema: username + phone plugins. */
export const APP_PLUGINS: PluginName[] = ["username", "phoneNumber"];

type Field = {
  fieldName?: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  references?: { model: string; field: string };
};

const SQL_TYPE: Record<string, string> = {
  string: "text",
  boolean: "integer",
  number: "integer",
  date: "date",
};

export type SchemaOptions = { plugins?: PluginName[]; userTable?: string };

export function createStatements({ plugins = [], userTable }: SchemaOptions) {
  const tables = getAuthTables({
    plugins: plugins.map((p) => (PLUGINS[p] as () => never)()),
    ...(userTable ? { user: { modelName: userTable } } : {}),
  } as never) as Record<string, { modelName: string; fields: Record<string, Field> }>;
  const tableFor = Object.fromEntries(Object.entries(tables).map(([k, t]) => [k, t.modelName]));

  return Object.values(tables).map((table) => {
    const defs = [
      `"id" text not null primary key`,
      ...Object.entries(table.fields).map(([name, f]) => {
        const ref = f.references
          ? ` references "${tableFor[f.references.model] ?? f.references.model}" ("${f.references.field}") on delete cascade`
          : "";
        return `"${f.fieldName ?? name}" ${SQL_TYPE[f.type] ?? "text"}${f.required ? " not null" : ""}${f.unique ? " unique" : ""}${ref}`;
      }),
    ];
    return `create table "${table.modelName}" (${defs.join(", ")})`;
  });
}

/** The Auth.js drizzle schema, one statement per entry. */
export const authjsStatements = () =>
  readFileSync("schema/authjs.sql", "utf8")
    .split("--> statement-breakpoint")
    .map((sql) => sql.trim())
    .filter(Boolean);

export async function tableNames(client: Client) {
  const { rows } = await client.execute(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '_litestream%'",
  );
  return rows.map((r) => String(r.name));
}

/** Drops every table, then creates the schema for `options`. Destroys all rows. */
export async function recreateSchema(client: Client, options: SchemaOptions) {
  const existing = await tableNames(client);
  // Children before parents, so foreign keys never block a drop.
  const parents = new Set(["user", "users", "organization"]);
  const order = [
    ...existing.filter((t) => !parents.has(t)),
    ...existing.filter((t) => parents.has(t)),
  ];
  for (const t of order) await client.execute(`drop table if exists "${t}"`);
  for (const sql of createStatements(options)) await client.execute(sql);
}

/**
 * Empties every table, whatever the current schema is. In 1,000-row chunks: a
 * single `delete` over a 10K seed (10,000 users + 8,500 accounts) is one long
 * HTTP request to Turso, and that is where the 10K run died with "fetch failed".
 */
export async function clearRows(client: Client) {
  const tables = await tableNames(client);
  const parents = new Set(["user", "users", "organization"]);
  for (const t of [
    ...tables.filter((t) => !parents.has(t)),
    ...tables.filter((t) => parents.has(t)),
  ])
    for (;;) {
      const { rowsAffected } = await retry(() =>
        client.execute(`delete from "${t}" where rowid in (select rowid from "${t}" limit 1000)`),
      );
      if (rowsAffected < 1000) break;
    }
}

/** Turso over HTTP drops the odd request ("fetch failed"); a statement is safe to repeat. */
async function retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i >= attempts || !String(error).includes("fetch failed")) throw error;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}
