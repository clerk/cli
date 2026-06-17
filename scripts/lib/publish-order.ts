/**
 * A package publish step that may also wait for registry availability.
 */
export type PublishStep = {
  publish: () => Promise<void>;
  waitUntilAvailable: (() => Promise<void>) | undefined;
};

/**
 * Publishes dependency packages before publishing the dependent package.
 */
export async function publishDependenciesBeforePackage(
  dependencies: PublishStep[],
  dependent: PublishStep,
): Promise<void> {
  await Promise.all(
    dependencies.map(async (dependency) => {
      await dependency.publish();
      if (dependency.waitUntilAvailable) {
        await dependency.waitUntilAvailable();
      }
    }),
  );
  await dependent.publish();
}
