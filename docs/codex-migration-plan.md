# Codex worker migration plan

## Target architecture

Command Center remains the orchestrator. The main agent and independent reviewers continue to run in Claude Code, while implementation workers can run in either Claude Code or Codex. Every task records its worker provider, every agent records the runtime that owns its session, and resume commands are provider-aware.

The initial Codex integration uses the interactive Codex CLI inside the existing tmux/worktree lifecycle. This preserves live steering, permission prompts, session continuity, verification, review, and PR feedback without replacing Command Center's orchestration model.

## Safety and compatibility rules

- Keep `claude` as the migration default until the Codex path passes the full regression suite.
- Run Codex workers with `workspace-write` and `on-request`; never use `danger-full-access`, `--yolo`, or approval bypasses.
- Keep main-agent and reviewer models independent from worker models.
- Never resume a session with a different provider than the provider that created it.
- Treat Codex transcript files as diagnostic-only because their format is not a stable API.
- Generate Command Center's Codex configuration under its own `CODEX_HOME`; do not rewrite the user's normal Codex configuration.
- Require a one-time explicit trust review for Command Center's static Codex lifecycle hooks.

## Implementation checklist

1. Add a provider allow-list (`claude | codex`) and additive database migrations for tasks, agents, and crons.
2. Preserve Claude behavior while separating `CC_REVIEWER_MODEL` from the worker model.
3. Generate a static Command Center Codex profile, MCP registration, and lifecycle hook configuration.
4. Add a provider-aware worker command builder and safe Codex resume behavior.
5. Map Codex `SessionStart`, `PermissionRequest`, and `Stop` events into the existing lifecycle state machine.
6. Expose provider selection through REST, MCP, CLI, recurring tasks, and the dashboard.
7. Expose provider-specific session metadata and manual resume commands without exposing sensitive values in logs.
8. Gate Claude-specific pane parsing, stall detection, and transcript/token parsing by provider.
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
