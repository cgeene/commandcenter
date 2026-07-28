/**
 * The triage-ack half of the `get_task` tool.
 *
 * Reading a queued task's FULL record is the triage action itself — it is the
 * only way to see the prompt — so that read doubles as the orchestrator's
 * acknowledgement, and the daemon stops re-delivering a task it has already
 * read. Kept out of index.ts (which connects a stdio transport on import, so it
 * cannot be imported by a test) purely so this decision is unit-testable.
 *
 * A projection via `fields` is a lookup, not triage: it cannot return the prompt,
 * so it must never ack. The daemon applies the rest of the conditions — only a
 * queued, orchestrated task can be acked at all.
 */
export function taskReadPath(
  id: number,
  opts: { verbose?: boolean; fields?: string[] } = {},
): string {
  const fullRead = opts.verbose === true && !(opts.fields && opts.fields.length > 0);
  return `/api/tasks/${id}${fullRead ? "?triage_ack=1" : ""}`;
}
