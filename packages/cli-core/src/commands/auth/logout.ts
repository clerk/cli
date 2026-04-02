import { deleteToken } from "../../lib/credential-store.ts";
import { clearAuth } from "../../lib/config.ts";

export async function logout(): Promise<void> {
  await deleteToken();
  await clearAuth();
  console.log("Logged out successfully");
}
