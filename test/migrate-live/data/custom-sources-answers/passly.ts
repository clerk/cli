/** Reference source for the Passly export, JSON or CSV. */
import fs from "node:fs";

type U = Record<string, any>;
const yes = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";

export default {
  key: "passly",
  label: "Passly",
  description: "Passly user export, JSON ({ users: [...] }) or CSV",
  carries: {
    passwords: { level: "yes", note: "bcrypt and argon2id, named per user in credentials.algo" },
    mfa: { level: "no", note: "not exported" },
    metadata: { level: "yes", note: "profile → public, internal → private" },
  },
  transformer: {
    uid: "userId",
    primaryEmail: "email",
    emailConfirmed: "emailConfirmed",
    otherEmails: "emailAddresses",
    mobile: "phone",
    mobileConfirmed: "phoneConfirmed",
    handle: "username",
    "credentials.algo": "passwordHasher",
    "credentials.hash": "password",
    profile: "publicMetadata",
    internal: "privateMetadata",
  },
  // The JSON wraps the users; a CSV is read as-is.
  preTransform(filePath: string, fileType: string) {
    if (fileType !== "application/json") return { filePath };
    return { filePath, data: JSON.parse(fs.readFileSync(filePath, "utf8")).users };
  },
  postTransform(user: U) {
    if (user.email && !yes(user.emailConfirmed)) {
      user.unverifiedEmailAddresses = user.email;
      delete user.email;
    }
    if (typeof user.phone === "string") user.phone = user.phone.replace(/[^\d+]/g, "");
    if (user.phone && !yes(user.phoneConfirmed)) {
      user.unverifiedPhoneNumbers = user.phone;
      delete user.phone;
    }
    if (user.displayName) {
      const [first, ...rest] = String(user.displayName).trim().split(/\s+/);
      user.firstName = first;
      if (rest.length) user.lastName = rest.join(" ");
    }
    if (user.createdAt !== undefined) user.createdAt = new Date(Number(user.createdAt) * 1000).toISOString();
    user.banned = user.status === "suspended";
    for (const k of ["emailConfirmed", "phoneConfirmed", "displayName", "status"]) delete user[k];
  },
};
