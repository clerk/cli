import { runUserLifecycleCommand, type UserLifecycleOptions } from "./lifecycle-runner.ts";

export async function lock(userId: string, options: UserLifecycleOptions = {}): Promise<void> {
  await runUserLifecycleCommand(
    {
      method: "POST",
      path: `/users/${userId}/lock`,
      spinnerMessage: "Locking user...",
    },
    options,
  );
}
