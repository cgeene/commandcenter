# Codex worker migration plan

## Target architecture

Command Center remains the orchestrator. The main agent and independent reviewers continue to run in Claude Code, while implementation workers can run in either Claude Code or Codex. Every task records its worker provider, every agent records the runtime that owns its session, and resume commands are provider-aware.

The initial Codex integration uses the interactive Codex CLI inside the existing tmux/worktree lifecycle. This preserves live steering, permission prompts, session continuity, verification, review, and PR feedback without replacing Command Center's orchestration model.

## Safety and compatibility rules

- Keep `claude` as the migration default until the Codex path passes the full regression suite.
- Run Codex workers with `workspace-write`, `on-request`, and Codex auto-review;
  never use `danger-full-access`, `--yolo`, or approval bypasses. Auto-review
  changes the reviewer, not the sandbox boundary.
- Keep main-agent and reviewer providers on Claude. Preserve a Claude task's
  reviewer-model behavior unless `CC_REVIEWER_MODEL` or a manual override is
  supplied; never pass a Codex model slug to a Claude reviewer.
- Never resume a session with a different provider than the provider that created it.
- Preserve transcript auditing for both providers. Parse Codex JSONL
  defensively, validate it under the isolated sessions directory, and skip
  unknown records because its format is not a stable API.
- Generate Command Center's Codex configuration under its own `CODEX_HOME`; do
  not rewrite the user's normal Codex configuration. Optional MCP inheritance
  may read explicit MCP tables and flatten plugin-provided MCP transports, but
  must not enable source plugins or share auth, session, history, hook, trust,
  model, or sandbox state.
- Require a one-time explicit trust review for Command Center's static Codex lifecycle hooks.
- Route explicit interactive tasks through Claude main before worker spawn.
  Repository selection is server allow-listed; portfolio parents decompose into
  isolated repository children; investigation tasks use Command Center-owned
  non-Git scratch directories. Existing tasks, crons, and legacy API calls keep
  the historical direct dispatch default.

## Implementation checklist

1. Add a provider allow-list (`claude | codex`) and additive database migrations for tasks, agents, and crons.
2. Preserve Claude reviewer-model behavior while preventing Codex model slugs
   from leaking into the Claude reviewer runtime; allow `CC_REVIEWER_MODEL` as
   an explicit override.
3. Generate a static Command Center Codex profile, MCP registration, and lifecycle hook configuration.
4. Add a provider-aware worker command builder and safe Codex resume behavior.
5. Map Codex `SessionStart`, `PermissionRequest`, and `Stop` events into the existing lifecycle state machine; use `PreToolUse` as the fail-closed publishing guard before shell execution.
6. Expose provider selection through REST, MCP, CLI, recurring tasks, and the dashboard.
7. Expose provider-specific session metadata and manual resume commands without exposing sensitive values in logs.
8. Add provider-aware transcript/token and transient-error adapters while
   preserving the structured pane, audit, escalation, and Needs You features.
9. Add migration, command-construction, hook, resume, reviewer-isolation, API, scheduler, and UI regression tests.
10. Run typecheck, unit tests, and production builds; then perform a disposable-repository end-to-end test before switching the default worker provider to Codex.

## Rollout

1. Install/build locally and run `agp codex setup`.
2. Log in once inside Command Center's isolated `CODEX_HOME`; normal Codex credentials are not copied automatically.
3. Review and trust the static Command Center hooks once in the Codex CLI.
4. Run `agp codex doctor` until all checks pass.
5. Dispatch one low-risk task with `--provider codex` and verify session capture, MCP calls, commit/push, Claude review, and resume.
6. Exercise verification failure, reviewer rejection, PR feedback, daemon restart, kill/requeue, and concurrent workers.
7. Set `CC_WORKER_PROVIDER=codex` only after those checks pass; retain per-task `claude` fallback.

Security hardening of Command Center's local HTTP/WebSocket surface is a separate follow-up. The migration must not weaken the current boundary while that work is pending.
