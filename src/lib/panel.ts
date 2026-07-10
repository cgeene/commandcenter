/**
 * Pure, dependency-free reducer for the dashboard's single side panel.
 *
 * The board can only ever show ONE side drawer at a time — a task's detail, an
 * agent's terminal, or a session transcript. Modeling that as one union (rather
 * than three independent `useState`s) makes "last click wins" the default: any
 * panel-opening click replaces whatever's open, so panels can never stack.
 *
 * Kept free of any DB/node/web imports so both the node test suite and the
 * (separately built) web bundle can import it.
 */

/** The one panel currently open, or null when the board is bare. Each variant
 *  carries only the identity needed to render it; heavier payloads (e.g. fetched
 *  transcript entries) live in component state keyed off this. */
export type Panel =
  | { kind: "task"; id: number }
  | { kind: "terminal"; agentId: number }
  | { kind: "transcript"; sessionId: string }
  | null;

/** A stable identity string for a panel, so two "open" requests can be compared
 *  for sameness (same kind + same target) regardless of object identity. */
export function panelKey(panel: Panel): string | null {
  if (!panel) return null;
  switch (panel.kind) {
    case "task":
      return `task:${panel.id}`;
    case "terminal":
      return `terminal:${panel.agentId}`;
    case "transcript":
      return `transcript:${panel.sessionId}`;
  }
}

/**
 * Reducer for a panel-opening click. Opening `next` replaces whatever is open —
 * one panel at a time, last click wins — EXCEPT that clicking the control for
 * the panel that's already open toggles it closed (returns null). That toggle
 * makes the same button both open and dismiss its panel.
 */
export function openPanel(current: Panel, next: NonNullable<Panel>): Panel {
  return panelKey(current) === panelKey(next) ? null : next;
}
