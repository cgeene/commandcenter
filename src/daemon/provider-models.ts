import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexBin, codexHome } from "../config.js";
import type { AgentProvider } from "../providers.js";

const execFileAsync = promisify(execFile);
const CACHE_MS = 10 * 60_000;
const MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export interface ProviderModel {
  slug: string;
  display_name: string;
  description: string;
}

const CLAUDE_MODELS: ProviderModel[] = [
  {
    slug: "fable",
    display_name: "Fable 5",
    description: "Most capable; long-running orchestration and complex work",
  },
  { slug: "opus", display_name: "Opus", description: "Complex design and review work" },
  { slug: "sonnet", display_name: "Sonnet", description: "Balanced implementation work" },
  { slug: "haiku", display_name: "Haiku", description: "Fast, lightweight work" },
];

let codexCache: { expires: number; models: ProviderModel[] } | undefined;

/** Parse only visible, bounded catalog fields; never relay model instructions
 * or arbitrary CLI response data into the dashboard. */
export function parseCodexModelCatalog(raw: string): ProviderModel[] {
  const parsed = JSON.parse(raw) as {
    models?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(parsed.models)) throw new Error("invalid Codex model catalog");

  const seen = new Set<string>();
  return parsed.models
    .filter((model) => model.visibility === "list")
    .flatMap((model) => {
      const slug = typeof model.slug === "string" ? model.slug : "";
      if (!MODEL_SLUG_RE.test(slug) || seen.has(slug)) return [];
      seen.add(slug);
      const display =
        typeof model.display_name === "string" && model.display_name.length <= 128
          ? model.display_name
          : slug;
      const description =
        typeof model.description === "string" && model.description.length <= 300
          ? model.description
          : "";
      return [{ slug, display_name: display, description }];
    })
    .slice(0, 30);
}

async function fetchCodexModels(args: string[]): Promise<ProviderModel[]> {
  const { stdout } = await execFileAsync(codexBin(), ["debug", "models", ...args], {
    env: { ...process.env, CODEX_HOME: codexHome() },
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const models = parseCodexModelCatalog(stdout);
  if (models.length === 0) throw new Error("Codex returned no visible models");
  return models;
}

export async function providerModels(provider: AgentProvider): Promise<ProviderModel[]> {
  if (provider === "claude") return CLAUDE_MODELS;
  if (codexCache && codexCache.expires > Date.now()) return codexCache.models;

  let models: ProviderModel[];
  try {
    models = await fetchCodexModels([]);
  } catch {
    models = await fetchCodexModels(["--bundled"]);
  }
  codexCache = { expires: Date.now() + CACHE_MS, models };
  return models;
}

export function _resetProviderModelCacheForTest(): void {
  codexCache = undefined;
}
