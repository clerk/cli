import type { Attribute, AttributeDataJSON, UserSettingsJSON } from "@clerk/shared/types";

export type AttributeName = Attribute;

function attribute(settings: UserSettingsJSON, name: AttributeName): AttributeDataJSON | undefined {
  const attrs = settings.attributes as Record<string, AttributeDataJSON | undefined>;
  return attrs[name];
}

export function isEnabled(settings: UserSettingsJSON, name: AttributeName): boolean {
  return attribute(settings, name)?.enabled === true;
}

export function isRequired(settings: UserSettingsJSON, name: AttributeName): boolean {
  const attr = attribute(settings, name);
  return attr?.enabled === true && attr.required === true;
}

export function enabledAttributes(settings: UserSettingsJSON): AttributeName[] {
  return (
    Object.entries(settings.attributes) as Array<[AttributeName, AttributeDataJSON | undefined]>
  )
    .filter(([, data]) => data?.enabled === true)
    .map(([name]) => name);
}
