export type IOSPrebuiltAuthEnvironmentAudit =
  | { apple: "required" }
  | { apple: "not-required" }
  | { apple: "blocked"; message: string };

const APPLE_PROVIDER_STRATEGY = "oauth_apple";
const BLOCKED_MESSAGE =
  "Clerk's Apple sign-in settings could not be safely determined. Review the Apple social connection before applying the prebuilt iOS authentication UI.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocked(): IOSPrebuiltAuthEnvironmentAudit {
  return { apple: "blocked", message: BLOCKED_MESSAGE };
}

/**
 * Determines whether AuthView will offer native Sign in with Apple without
 * retaining or returning any Frontend API environment data.
 */
export function auditIOSPrebuiltAuthEnvironment(
  settings: unknown,
): IOSPrebuiltAuthEnvironmentAudit {
  if (!isRecord(settings) || !isRecord(settings.social)) {
    return blocked();
  }

  let appleEnabled = false;
  for (const [key, provider] of Object.entries(settings.social)) {
    if (
      !isRecord(provider) ||
      typeof provider.enabled !== "boolean" ||
      typeof provider.authenticatable !== "boolean" ||
      typeof provider.strategy !== "string" ||
      provider.strategy.trim().length === 0
    ) {
      return blocked();
    }

    const keyIdentifiesApple = key === APPLE_PROVIDER_STRATEGY;
    const strategyIdentifiesApple = provider.strategy === APPLE_PROVIDER_STRATEGY;
    if (keyIdentifiesApple !== strategyIdentifiesApple) {
      return blocked();
    }
    if (strategyIdentifiesApple && provider.enabled && provider.authenticatable) {
      appleEnabled = true;
    }
  }

  return appleEnabled ? { apple: "required" } : { apple: "not-required" };
}
