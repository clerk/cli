import { runUserLifecycleCommand, type UserLifecycleOptions } from "./lifecycle-runner.ts";

export async function remove(userId: string, options: UserLifecycleOptions = {}): Promise<void> {
  await runUserLifecycleCommand(
    {
      method: "DELETE",
      path: `/users/${userId}`,
      spinnerMessage: "Deleting user...",
      destructiveWarning: "This will permanently delete the user.",
      successMessage: `Deleted user ${userId}`,
      errorMessage: `Failed to delete user ${userId}`,
    },
    options,
  );
}
