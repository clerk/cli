/** Reference source for the Gatekeep export, JSON or CSV. */
import fs from "node:fs";

type U = Record<string, any>;
type Identity = { kind: string; value: string; region?: string; confirmed_at?: string | null; primary?: boolean | string };

const PUBLIC_KEYS = new Set(["plan", "locale", "theme"]);

/** Country calling code for every region Gatekeep exports. */
const CALLING_CODE: Record<string, string> = {
  US: "1", CA: "1", GB: "44", DE: "49", FR: "33", ES: "34", IT: "39", NL: "31", SE: "46", IE: "353",
};

/**
 * National format + region → E.164: "07911 123456" + GB → +447911123456.
 * The leading 0 is a trunk prefix, dropped once the country code goes on.
 * Italian mobiles start with 3, so they never hit it.
 */
function e164(national: string, region = ""): string {
  const code = CALLING_CODE[region];
  if (!code) throw new Error(`Gatekeep region "${region}" has no calling code here`);
  return `+${code}${national.replace(/\D/g, "").replace(/^0/, "")}`;
}

export default {
  key: "gatekeep",
  label: "Gatekeep",
  description: "Gatekeep account export, JSON ({ data: { accounts } }) or CSV",
  carries: {
    passwords: { level: "yes", note: "argon2id, and pbkdf2-sha256 rebuilt in Django format" },
    mfa: { level: "no", note: "not exported" },
    metadata: { level: "partial", note: "attrs is one blob: known profile keys → public, the rest → private" },
  },
  transformer: { account_ref: "userId" },
  preTransform(filePath: string, fileType: string) {
    if (fileType !== "application/json") return { filePath };
    return { filePath, data: JSON.parse(fs.readFileSync(filePath, "utf8")).data.accounts };
  },
  postTransform(user: U) {
    // JSON nests identities in an array; the CSV flattens them to id1_..id4_ columns.
    let ids: Identity[] = user.identities ?? [];
    if (!user.identities) {
      for (let k = 1; k <= 4; k++) {
        if (user[`id${k}_kind`]) {
          ids.push({
            kind: user[`id${k}_kind`],
            value: user[`id${k}_value`],
            region: user[`id${k}_region`],
            confirmed_at: user[`id${k}_confirmed_at`] || null,
            primary: user[`id${k}_primary`],
          });
        }
      }
    }
    const isPrimary = (i: Identity) => i.primary === true || i.primary === "true";
    ids = [...ids].sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)));

    const emails = ids.filter((i) => i.kind === "email");
    user.email = emails.filter((i) => i.confirmed_at).map((i) => i.value);
    user.unverifiedEmailAddresses = emails.filter((i) => !i.confirmed_at).map((i) => i.value);
    const phones = ids.filter((i) => i.kind === "sms");
    user.phone = phones.filter((i) => i.confirmed_at).map((i) => e164(i.value, i.region));
    user.unverifiedPhoneNumbers = phones.filter((i) => !i.confirmed_at).map((i) => e164(i.value, i.region));
    const handle = ids.find((i) => i.kind === "handle");
    if (handle) user.username = handle.value;

    const given = user.person?.given ?? user.person_given;
    const family = user.person?.family ?? user.person_family;
    if (given) user.firstName = given;
    if (family) user.lastName = family;

    const secret = user.secret ?? {
      scheme: user.secret_scheme, rounds: user.secret_rounds, salt: user.secret_salt, digest: user.secret_digest,
    };
    if (secret.scheme === "argon2id") {
      user.password = secret.digest;
      user.passwordHasher = "argon2id";
    } else if (secret.scheme === "pbkdf2-sha256") {
      user.password = `pbkdf2_sha256$${secret.rounds}$${secret.salt}$${secret.digest}`;
      user.passwordHasher = "pbkdf2_sha256_django";
    }

    const attrs = typeof user.attrs === "string" && user.attrs ? JSON.parse(user.attrs) : (user.attrs ?? {});
    const split = (pub: boolean) => Object.fromEntries(Object.entries(attrs).filter(([k]) => PUBLIC_KEYS.has(k) === pub));
    user.publicMetadata = split(true);
    user.privateMetadata = split(false);

    const flags = Array.isArray(user.flags) ? user.flags : String(user.flags ?? "").split("|");
    user.banned = flags.includes("locked");
    if (user.ts_created) user.createdAt = new Date(Number(user.ts_created)).toISOString();

    for (const k of Object.keys(user)) {
      if (/^(id\d_|person|secret|identities|attrs|flags|ts_created)/.test(k)) delete user[k];
    }
  },
};
