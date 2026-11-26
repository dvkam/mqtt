import type { UserProperty } from './wireProperties.js';

export function copyUserProperties(properties: readonly UserProperty[] | undefined): readonly UserProperty[] | undefined {
  if (properties === undefined) return undefined;
  return Object.freeze(Array.from(properties, ([key, value]) => Object.freeze([key, value] as const)));
}
