export const PUBLICATION_MODES = ["agent", "human"] as const;
export type PublicationMode = (typeof PUBLICATION_MODES)[number];

export const PUBLICATION_STATES = [
  "editing",
  "reviewing",
  "awaiting_human",
  "published",
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export function isPublicationMode(value: unknown): value is PublicationMode {
  return typeof value === "string" &&
    (PUBLICATION_MODES as readonly string[]).includes(value);
}

export function isPublicationState(value: unknown): value is PublicationState {
  return typeof value === "string" &&
    (PUBLICATION_STATES as readonly string[]).includes(value);
}
