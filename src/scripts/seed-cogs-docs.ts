/**
 * One-shot seed: import the COGS discovery docs (+ the workload→product-map
 * CSV) into the internal doc store under project "cogs".
 *
 * The docs currently live on the nylas-data-lake branch `agent/task-23`
 * (docs/cogs/discovery/*) with provenance headers already baked in. We read
 * them read-only via `git show` — nothing in that repo is touched — and land
 * them in the local doc store so the COGS pipeline work can consume them from
 * here instead of from PR #447.
 *
 * Idempotent: a re-run whose content matches the stored body is a no-op (no
 * version churn). Point at a different checkout with NYLAS_DATA_LAKE=/path,
 * or a different ref with SEED_REF=origin/agent/task-23.
 *
 * Usage:  tsx src/scripts/seed-cogs-docs.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { docsDir } from "../config.js";
import { saveDoc, getDoc } from "../db/docs.js";

const REPO =
  process.env.NYLAS_DATA_LAKE ??
  path.join(os.homedir(), "projects", "nylas", "nylas-data-lake");
const REF = process.env.SEED_REF ?? "origin/agent/task-23";
const BASE = "docs/cogs/discovery";
const PROJECT = "cogs";

interface SeedDoc {
  file: string;
  slug: string;
  tags: string;
  attachment?: string;
}

const DOCS: SeedDoc[] = [
  { file: "README.md", slug: "readme", tags: "cogs,discovery,index" },
  { file: "01-cost-data-inventory.md", slug: "01-cost-data-inventory", tags: "cogs,discovery,billing,gcp,gke-cost-allocation" },
  { file: "02-usage-data-inventory.md", slug: "02-usage-data-inventory", tags: "cogs,discovery,bigquery,usage" },
  { file: "03-workload-product-map.md", slug: "03-workload-product-map", tags: "cogs,discovery,mapping,workload-product", attachment: "03-workload-product-map.csv" },
  { file: "04-costmanagementconfig-verification.md", slug: "04-costmanagementconfig-verification", tags: "cogs,discovery,gke,billing-export" },
  { file: "05-namespace-product-mapping.md", slug: "05-namespace-product-mapping", tags: "cogs,discovery,agent-accounts,namespaces" },
];

function gitShow(file: string): string {
  return execFileSync("git", ["-C", REPO, "show", `${REF}:${BASE}/${file}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Title = first markdown H1; fall back to a de-slugged filename. */
function titleOf(content: string, slug: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : slug.replace(/-/g, " ");
}

/** Short summary = first prose line that isn't a heading or provenance quote. */
function summaryOf(content: string): string | undefined {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(">")) continue;
    return line.replace(/[*_`[\]]/g, "").slice(0, 200);
  }
  return undefined;
}

/** True when the stored sidecar files already hold exactly `incoming`. */
function attachmentsMatch(
  storedJson: string | null,
  incoming?: { filename: string; content: string }[],
): boolean {
  const stored = storedJson ? (JSON.parse(storedJson) as string[]) : [];
  if (stored.length !== (incoming?.length ?? 0)) return false;
  for (const a of incoming ?? []) {
    const rel = `${PROJECT}/${path.basename(a.filename)}`;
    if (!stored.includes(rel)) return false;
    const abs = path.join(docsDir(), rel);
    if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== a.content) {
      return false;
    }
  }
  return true;
}

function main(): void {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const d of DOCS) {
    const content = gitShow(d.file);
    const title = titleOf(content, d.slug);
    const summary = summaryOf(content);
    const attachments = d.attachment
      ? [{ filename: d.attachment, content: gitShow(d.attachment) }]
      : undefined;

    const existing = getDoc(d.slug, PROJECT);
    if (existing && existing.content === content && attachmentsMatch(existing.attachments, attachments)) {
      skipped++;
      console.log(`= ${PROJECT}/${d.slug} (unchanged)`);
      continue;
    }

    const { doc, created: wasCreated } = saveDoc({
      project: PROJECT,
      slug: d.slug,
      title,
      content,
      tags: d.tags,
      summary,
      attachments,
    });
    if (wasCreated) created++;
    else updated++;
    console.log(
      `${wasCreated ? "+" : "~"} ${PROJECT}/${doc.slug} v${doc.version}` +
        (attachments ? ` (+${attachments.length} attachment)` : ""),
    );
  }

  console.log(
    `\nSeed complete: ${created} created, ${updated} updated, ${skipped} unchanged (project "${PROJECT}").`,
  );
}

main();
