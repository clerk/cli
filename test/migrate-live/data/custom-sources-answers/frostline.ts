// Reference source for the made-up Frostline export (holdout). What a correct
// agent should produce; test:custom must grade it A+.
const CODES: Record<string, string> = { GB: "44", DE: "49", FR: "33", ES: "34", IT: "39", NL: "31", SE: "46", IE: "353", CA: "1", US: "1" };

function e164(raw: string, iso: string): string | undefined {
  const code = CODES[iso];
  if (!code) return undefined;
  let digits = raw.replace(/\D/g, "");
  if (code !== "1" && iso !== "IT") digits = digits.replace(/^0/, "");
  return `+${code}${digits}`;
}

// passlib's base64: "." for "+", no padding.
const b64 = (ab64: string) => {
  const s = ab64.replace(/\./g, "+");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
};

const obj = (v: unknown) => (typeof v === "string" ? (v ? JSON.parse(v) : null) : v) as Record<string, unknown> | null;

export default {
  key: "frostline",
  label: "Frostline",
  description: "Frostline member exports (JSON result.members, or the flat CSV).",
  preTransform: (filePath: string, fileType: string) => {
    if (fileType !== "application/json") return { filePath };
    const parsed = JSON.parse(require("node:fs").readFileSync(filePath, "utf-8"));
    const data = parsed.result.members.map(({ contact, ...m }: any) => ({
      ...m,
      ...Object.fromEntries(Object.entries(contact).map(([k, v]) => [`contact_${k}`, v])),
    }));
    return { filePath, data };
  },
  transformer: {
    member_no: "userId",
    contact_email: "fl_email",
    contact_email_status: "fl_email_status",
    contact_mobile: "fl_mobile",
    contact_country_iso: "fl_iso",
    contact_mobile_status: "fl_mobile_status",
    login_name: "username",
    given_name: "firstName",
    surname: "lastName",
    pw: "fl_pw",
    state: "fl_state",
    frozen_until: "fl_frozen_until",
    billing: "fl_billing",
    settings: "fl_settings",
    joined: "createdAt",
  },
  carries: {
    passwords: { level: "yes", note: "passlib pbkdf2_sha256 → pbkdf2_sha256; $2y$ bcrypt." },
    mfa: { level: "no", note: "Not exported." },
    metadata: { level: "yes", note: "billing.plan → public; stripe_id, seats → private; settings → unsafe." },
  },
  postTransform: (user: Record<string, any>) => {
    if (user.fl_email) {
      if (user.fl_email_status === "confirmed") user.email = user.fl_email;
      else user.unverifiedEmailAddresses = user.fl_email;
    }
    if (user.fl_mobile) {
      const p = e164(String(user.fl_mobile), String(user.fl_iso));
      if (p) {
        if (user.fl_mobile_status === "confirmed") user.phone = p;
        else user.unverifiedPhoneNumbers = p;
      }
    }
    const pw = user.fl_pw ? String(user.fl_pw) : "";
    const m = pw.match(/^\$pbkdf2-sha256\$(\d+)\$([^$]+)\$([^$]+)$/);
    if (m) {
      user.password = `pbkdf2_sha256$${m[1]}$${b64(m[2])}$${b64(m[3])}`;
      user.passwordHasher = "pbkdf2_sha256";
    } else if (/^\$2[aby]\$/.test(pw)) {
      user.password = pw;
      user.passwordHasher = "bcrypt";
    } else if (pw) {
      user.passwordDropped = true;
    }
    if (user.fl_state === "frozen") user.banned = true;
    if (user.fl_state === "closed") user.skipReason = "closed in Frostline";
    const billing = obj(user.fl_billing) ?? {};
    const { plan, ...rest } = billing;
    if (plan !== undefined) user.publicMetadata = { plan };
    if (Object.keys(rest).length) user.privateMetadata = rest;
    const settings = obj(user.fl_settings);
    if (settings) user.unsafeMetadata = settings;
    for (const k of Object.keys(user)) if (k.startsWith("fl_")) delete user[k];
    if (!user.username) delete user.username;
    if (!user.firstName) delete user.firstName;
    if (!user.lastName) delete user.lastName;
  },
};
