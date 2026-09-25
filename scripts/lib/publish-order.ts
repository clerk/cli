/**
 * A package publish step that may also wait for registry availability.
 */
export type PublishStep = {
  publish: () => Promise<void>;
  waitUntilAvailable: (() => Promise<void>) | undefined;
};

/**
 * Publishes dependency packages before publishing the dependent package.
 *
 * Every dependency runs to completion even when another fails: exiting while
 * an `npm publish` is mid-upload can still land that version, leaving the
 * registry in a state the next attempt has to reconcile. All failures are
 * reported together, and the dependent is only published if none failed.
 */
export async function publishDependenciesBeforePackage(
  dependencies: PublishStep[],
  dependent: PublishStep,
): Promise<void> {
  const results = await Promise.allSettled(
    dependencies.map(async (dependency) => {
      await dependency.publish();
      if (dependency.waitUntilAvailable) {
        await dependency.waitUntilAvailable();
      }
    }),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `${errors.length} dependency publishes failed:\n${errors.map((e) => `  - ${e instanceof Error ? e.message : String(e)}`).join("\n")}`,
    );
  }
  await dependent.publish();
}
