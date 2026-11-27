/** Reference source for the Vaultrun export, JSON or CSV. */
type U = Record<string, any>;

const isEmail = (s: string) => s.includes("@");
const isPhone = (s: string) => /^[\d\s()+.-]+$/.test(s) && s.replace(/\D/g, "").length >= 10;
const e164 = (s: string) => `+${s.replace(/\D/g, "")}`;

/** vf bitmask. */
const EMAIL_VERIFIED = 1;
const PHONE_VERIFIED = 2;
const DISABLED = 4;

export default {
  key: "vaultrun",
  label: "Vaultrun",
  description: "Vaultrun user export, JSON or CSV",
  carries: {
    passwords: { level: "yes", note: "bcrypt, and pbkdf2:sha256 rebuilt in Django format" },
    mfa: { level: "no", note: "not exported" },
    metadata: { level: "partial", note: "xa (JSON) → public, xb (k=v;k=v) → private" },
  },
  transformer: { rid: "userId", xa: "publicMetadata", born: "createdAt" },
  postTransform(user: U) {
    user.userId = String(user.userId);
    const vf = Number(user.vf ?? 0);
    const login = String(user.login ?? "").trim();
    const alt = String(user.alt_contact ?? "").trim();
    const put = (field: string, value: string) => (user[field] = [...(user[field] ?? []), value]);

    for (const id of [login, alt].filter(Boolean)) {
      if (isEmail(id)) put(vf & EMAIL_VERIFIED ? "email" : "unverifiedEmailAddresses", id);
      else if (isPhone(id)) put(vf & PHONE_VERIFIED ? "phone" : "unverifiedPhoneNumbers", e164(id));
      else user.username = id;
    }

    const nm = String(user.nm ?? "").trim();
    if (nm.includes(",")) {
      const [last, first] = nm.split(",").map((s) => s.trim());
      user.firstName = first;
      user.lastName = last;
    } else if (nm) user.firstName = nm;

    const cred = String(user.cred ?? "");
    if (cred.startsWith("bcrypt:")) {
      user.password = cred.slice("bcrypt:".length);
      user.passwordHasher = "bcrypt";
    } else if (cred.startsWith("pbkdf2:sha256:")) {
      const [, , rounds, salt, hash] = cred.split(":");
      user.password = `pbkdf2_sha256$${rounds}$${salt}$${hash}`;
      user.passwordHasher = "pbkdf2_sha256_django";
    }

    if (user.xb) {
      user.privateMetadata = Object.fromEntries(String(user.xb).split(";").map((kv) => kv.split("=")));
    }
    // "2023-10-05 10:43:51" carries no zone; Vaultrun stores UTC.
    if (user.createdAt) user.createdAt = `${String(user.createdAt).replace(" ", "T")}Z`;
    user.banned = Boolean(vf & DISABLED);
    if (String(user.del) === "1") user.skipReason = "deleted in Vaultrun";

    for (const k of ["vf", "login", "alt_contact", "nm", "cred", "xb", "del"]) delete user[k];
  },
};
