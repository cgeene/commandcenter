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
  opts: { verbose?: boolean; fields?: string[]; agentId?: number } = {},
): string {
  const fullRead = opts.verbose === true && !(opts.fields && opts.fields.length > 0);
  if (!fullRead) return `/api/tasks/${id}`;
  // Who acked. An ack is one orchestrator session saying "I have this one", so a
  // replacement main still gets told about the task (see orchestration.ackedBy).
  const agent =
    Number.isSafeInteger(opts.agentId) && (opts.agentId as number) > 0
      ? `&agent_id=${opts.agentId}`
      : "";
  return `/api/tasks/${id}?triage_ack=1${agent}`;
}
