/**
 * One-shot, idempotent migration: upgrade the existing on-disk doc store to
 * the current layout — YAML frontmatter on every doc file, version sidecars
 * relocated under <project>/_versions/, and a regenerated per-project
 * _index.md. It only rewrites files; it never touches updated_at, version
 * counters, or the FTS index. Safe to re-run (a second run is a no-op).
 *
 * The daemon also runs this automatically on startup; this script is for
 * applying it on demand (e.g. against a live store without a restart).
 *
 * Usage:  tsx src/scripts/migrate-docs-frontmatter.ts
 */
import { migrateDocsToFrontmatter } from "../db/docs.js";

const { updated, relocated, indexed } = migrateDocsToFrontmatter();
console.log(
  `Doc frontmatter migration complete: ${updated} file(s) updated, ` +
    `${relocated} version sidecar(s) relocated, ${indexed} index(es) regenerated.`,
);
