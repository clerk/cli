export type UsersActionTargeting = {
  app?: string;
  instance?: string;
  branch?: string;
  secretKey?: string;
};

export type UsersAction = {
  key: string;
  label: string;
  description: string;
  handler: (targeting: UsersActionTargeting) => Promise<void>;
};

const REGISTRY: UsersAction[] = [];

export function registerUsersAction(action: UsersAction): void {
  REGISTRY.push(action);
}

export function listUsersActions(): readonly UsersAction[] {
  return Object.freeze([...REGISTRY]);
}

/** Test-only: clear the registry between tests. Do not call from production code. */
export function __resetUsersActionRegistryForTesting(): void {
  REGISTRY.length = 0;
}
