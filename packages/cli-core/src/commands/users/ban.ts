import { runUserLifecycleCommand, type UserLifecycleOptions } from "./lifecycle-runner.ts";

export async function ban(userId: string, options: UserLifecycleOptions = {}): Promise<void> {
  await runUserLifecycleCommand(
    {
      method: "POST",
      path: `/users/${userId}/ban`,
      spinnerMessage: "Banning user...",
    },
    options,
  );
}
