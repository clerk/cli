/**
 * Pulling a user's identifiers out of any provider's export row, so a user can
 * be recognised across two seedings of the same provider (which give it new
 * IDs): emails and usernames as they are, phones as E.164.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The row's source ID, under whichever key its provider uses. */
export const sourceIdOf = (row: Record<string, unknown>) =>
  String(row.user_id ?? row.id ?? row.localId ?? row.uid ?? "");

/** Lowercased emails, usernames and E.164 phones anywhere in the row. */
export function rowIdentifiers(row: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key = "") => {
    if (typeof v === "string") {
      if (EMAIL.test(v)) out.add(v.toLowerCase());
      // Only phone-named fields: plenty of other digit strings (timestamps) look like numbers.
      else if (/phone/i.test(key) && /^\+?\d{8,15}$/.test(v)) out.add(`+${v.replace(/^\+/, "")}`);
      else if (/^(username|display_username)$/i.test(key) && v) out.add(v.toLowerCase());
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(row);
  return [...out];
}

// Self-check (from test/migrate-live/): bun lib/identifiers.ts
if (process.argv[1]?.endsWith("identifiers.ts")) {
  const { default: assert } = await import("node:assert");
  assert.deepEqual(
    rowIdentifiers({
      id: "u1",
      email: "A@Example.com",
      phone: "14165550142",
      created_at: "1790977093227",
      raw_user_meta_data: { username: "Ada_L" },
    }).sort(),
    ["+14165550142", "a@example.com", "ada_l"],
  );
  assert.deepEqual(
    rowIdentifiers({
      verified_email_addresses: ["x@y.io"],
      primary_phone_number: "+447836887904",
    }).sort(),
    ["+447836887904", "x@y.io"],
  );
  assert.equal(sourceIdOf({ localId: "abc" }), "abc");
  console.log("identifiers: ok");
}
