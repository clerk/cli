import { runUserLifecycleCommand, type UserLifecycleOptions } from "./lifecycle-runner.ts";

export async function unban(userId: string, options: UserLifecycleOptions = {}): Promise<void> {
  await runUserLifecycleCommand(
    {
      method: "POST",
      path: `/users/${userId}/unban`,
      spinnerMessage: "Unbanning user...",
    },
    options,
  );
}
