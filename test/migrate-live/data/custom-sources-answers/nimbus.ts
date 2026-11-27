// Reference source for the made-up Nimbus export (holdout). What a correct
// agent should produce; test:custom must grade it A+.
export default {
  key: "nimbus",
  label: "Nimbus",
  description: "Nimbus user exports (flat JSON array or CSV).",
  transformer: {
    uid: "userId",
    contacts: "nb_contacts",
    nick: "username",
    name: "nb_name",
    secret: "nb_secret",
    st: "nb_st",
    props: "nb_props",
    ctime: "nb_ctime",
  },
  carries: {
    passwords: { level: "partial", note: "$2a$ bcrypt and {SSHA}; $6$ sha512-crypt has no Clerk hasher and is dropped." },
    mfa: { level: "no", note: "Not exported." },
    metadata: { level: "yes", note: "props: plan, lang → public; ref, acct_note → private." },
  },
  postTransform: (user: Record<string, any>) => {
    user.userId = String(user.userId);
    const verifiedEmails: string[] = [];
    const unverifiedEmails: string[] = [];
    const verifiedPhones: string[] = [];
    const unverifiedPhones: string[] = [];
    for (const c of String(user.nb_contacts ?? "").split("|").filter(Boolean)) {
      const i = c.indexOf(":");
      const j = c.lastIndexOf(":");
      const kind = c.slice(0, i);
      let value = c.slice(i + 1, j);
      const ok = c.slice(j + 1) === "1";
      if (kind === "tel") value = value.replace(/^00/, "+");
      (kind === "email" ? (ok ? verifiedEmails : unverifiedEmails) : ok ? verifiedPhones : unverifiedPhones).push(value);
    }
    if (verifiedEmails.length) user.email = verifiedEmails;
    if (unverifiedEmails.length) user.unverifiedEmailAddresses = unverifiedEmails;
    if (verifiedPhones.length) user.phone = verifiedPhones;
    if (unverifiedPhones.length) user.unverifiedPhoneNumbers = unverifiedPhones;

    const name = String(user.nb_name ?? "").trim();
    if (name) {
      const k = name.indexOf(" ");
      user.firstName = k < 0 ? name : name.slice(0, k);
      if (k >= 0) user.lastName = name.slice(k + 1);
    }

    const secret = String(user.nb_secret ?? "");
    if (/^\$2[aby]\$/.test(secret)) {
      user.password = secret;
      user.passwordHasher = "bcrypt";
    } else if (secret.startsWith("{SSHA}")) {
      user.password = secret;
      user.passwordHasher = "ldap_ssha";
    } else if (secret) {
      user.passwordDropped = true;
    }

    if (user.nb_st === "S") user.banned = true;
    if (user.nb_st === "X") user.skipReason = "erased in Nimbus";

    const pub: Record<string, string> = {};
    const priv: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(String(user.nb_props ?? ""))) (k === "plan" || k === "lang" ? pub : priv)[k] = v;
    if (Object.keys(pub).length) user.publicMetadata = pub;
    if (Object.keys(priv).length) user.privateMetadata = priv;

    if (user.nb_ctime) user.createdAt = new Date(Number(user.nb_ctime) * 1000).toISOString();
    for (const k of Object.keys(user)) if (k.startsWith("nb_")) delete user[k];
    if (!user.username) delete user.username;
  },
};
