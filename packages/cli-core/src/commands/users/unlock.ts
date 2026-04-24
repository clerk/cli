import { runUserLifecycleCommand, type UserLifecycleOptions } from "./lifecycle-runner.ts";

export async function unlock(userId: string, options: UserLifecycleOptions = {}): Promise<void> {
  await runUserLifecycleCommand(
    {
      method: "POST",
      path: `/users/${userId}/unlock`,
      spinnerMessage: "Unlocking user...",
    },
    options,
  );
}
