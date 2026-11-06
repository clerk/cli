/** Reference source for the Keyhole export, JSON or CSV. */
type U = Record<string, any>;
const yes = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";

export default {
  key: "keyhole",
  label: "Keyhole",
  description: "Keyhole user export, JSON or CSV",
  carries: {
    passwords: { level: "yes", note: "bcrypt hashes" },
    mfa: { level: "no", note: "not exported" },
    metadata: { level: "yes", note: "public, private and unsafe map 1:1" },
  },
  transformer: {
    id: "userId",
    email: "email",
    email_verified: "emailVerified",
    phone_number: "phone",
    phone_verified: "phoneVerified",
    username: "username",
    first_name: "firstName",
    last_name: "lastName",
    password_hash: "password",
    public_metadata: "publicMetadata",
    private_metadata: "privateMetadata",
    unsafe_metadata: "unsafeMetadata",
    created_at: "createdAt",
    banned: "banned",
  },
  postTransform(user: U) {
    if (user.password) user.passwordHasher = "bcrypt";
    if (user.email && !yes(user.emailVerified)) {
      user.unverifiedEmailAddresses = user.email;
      delete user.email;
    }
    if (user.phone && !yes(user.phoneVerified)) {
      user.unverifiedPhoneNumbers = user.phone;
      delete user.phone;
    }
    delete user.emailVerified;
    delete user.phoneVerified;
  },
};
