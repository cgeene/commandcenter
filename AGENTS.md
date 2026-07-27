# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the Node 22 TypeScript backend. Key areas are `src/daemon/` for the local daemon/API/worktree orchestration, `src/cli/` for `agp`, `src/mcp/` for the MCP server, `src/db/` for SQLite access, `src/lib/` for shared dependency-light logic, and `src/prompts/` for agent prompts. Tests live in `test/*.test.ts`. The dashboard is a separate Vite React package under `web/`, with source in `web/src/` and static assets in `web/public/`. Longer-form docs are in `docs/`.

## Build, Test, and Development Commands

- `npm run setup`: install root and `web/` dependencies, then build both packages.
- `npm run dev:daemon`: run `src/daemon/index.ts` through `tsx` for local daemon development.
- `npm --prefix web run dev`: run the Vite dashboard during frontend work.
- `npm run build`: compile backend TypeScript to `dist/`.
- `npm run build:web`: build the dashboard to `web/dist/`.
- `npm run build:all`: build backend plus dashboard; rerun after source changes before using compiled `agentd`, `agp`, or `cc-mcp`.
- `npm run typecheck`: strict TypeScript check without emitting files.
- `npm test`: run the Vitest suite.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules and two-space indentation. Prefer named exports and explicit `type` imports where practical. Keep shared, dependency-free helpers in `src/lib/` so Node tests and the web bundle can reuse them. Name tests after the behavior or module they cover, for example `test/worktree.test.ts`. Follow existing camelCase function names, PascalCase React components, and lower-case status strings.

## Testing Guidelines

Vitest is the test framework. Add focused tests under `test/` for backend, daemon, DB, and shared-library changes. For dashboard-only changes, at minimum run `npm --prefix web run build`; run `npm run build:all` when shared code crosses package boundaries.

## Commit & Pull Request Guidelines

Recent history uses conventional commits such as `feat(web): ...`, `fix(daemon): ...`, `style(web): ...`, and `chore: ...`. Branch from `main`, avoid direct pushes to `main`, and open PRs with `gh pr create`. PR descriptions should explain what changed, why, linked issue/task context when applicable, and verification performed. Include screenshots for visible dashboard changes.

## Security & Configuration Tips

Keep the daemon bound to `127.0.0.1`; it has no built-in auth. Never log secrets, tokens, session IDs, or sensitive internal values. Validate API, CLI, env, and database inputs with allow-lists or strict type/range checks, and fail closed on unsafe worker, reviewer, or publication permissions.
