import { describe, expect, it } from "vitest";
import { parseCodexModelCatalog } from "../src/daemon/provider-models.js";

describe("parseCodexModelCatalog", () => {
  it("returns only visible, valid, deduplicated model choices", () => {
    const raw = JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          description: "Latest frontier agentic coding model.",
          visibility: "list",
          base_instructions: "must never reach the dashboard",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "high", description: "Deep" },
            { effort: "invented", description: "must be filtered" },
          ],
        },
        {
          slug: "codex-auto-review",
          display_name: "Codex Auto Review",
          description: "hidden",
          visibility: "hide",
        },
        {
          slug: "gpt-5.6-luna",
          display_name: "GPT-5.6-Luna",
          description: "Fast frontier model.",
          visibility: "list",
          supported_reasoning_levels: [
            { effort: "high", description: "Deep" },
            { effort: "max", description: "Maximum" },
          ],
        },
        { slug: "gpt-5.6-sol", display_name: "duplicate", visibility: "list" },
        { slug: "invalid model", display_name: "invalid", visibility: "list" },
      ],
    });

    expect(parseCodexModelCatalog(raw)).toEqual([
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        reasoning_levels: [
          { effort: "low", description: "Fast" },
          { effort: "high", description: "Deep" },
        ],
      },
      {
        slug: "gpt-5.6-luna",
        display_name: "GPT-5.6-Luna",
        description: "Fast frontier model.",
        reasoning_levels: [
          { effort: "high", description: "Deep" },
          { effort: "max", description: "Maximum" },
        ],
      },
    ]);
  });

  it("rejects a malformed catalog", () => {
    expect(() => parseCodexModelCatalog('{"models":null}')).toThrow(
      "invalid Codex model catalog",
    );
  });
});

describe("provider model API", () => {
  it("reports the configured default and the built-in Claude choices", async () => {
    const previous = process.env.CC_WORKER_PROVIDER;
    const previousMain = process.env.CC_MAIN_MODEL;
    process.env.CC_WORKER_PROVIDER = "codex";
    delete process.env.CC_MAIN_MODEL;
    try {
      const { buildApp } = await import("../src/daemon/api.js");
      const app = buildApp();
      const providers = await app.request("/api/providers");
      expect(await providers.json()).toEqual({
        default_worker_provider: "codex",
        main_provider: "claude",
        default_main_model: "fable",
      });

      const models = await app.request("/api/providers/claude/models");
      expect(await models.json()).toMatchObject({
        provider: "claude",
        models: [
          { slug: "fable" },
          { slug: "opus" },
          { slug: "sonnet" },
          { slug: "haiku" },
        ],
      });
      expect((await app.request("/api/providers/other/models")).status).toBe(400);
      expect(
        (
          await app.request("/api/main", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "invalid model" }),
          })
        ).status,
      ).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.CC_WORKER_PROVIDER;
      else process.env.CC_WORKER_PROVIDER = previous;
      if (previousMain === undefined) delete process.env.CC_MAIN_MODEL;
      else process.env.CC_MAIN_MODEL = previousMain;
    }
  });

  it("honors an explicit main-agent model override", async () => {
    const previous = process.env.CC_MAIN_MODEL;
    process.env.CC_MAIN_MODEL = "opus";
    try {
      const { defaultMainModel } = await import("../src/config.js");
      expect(defaultMainModel()).toBe("opus");
    } finally {
      if (previous === undefined) delete process.env.CC_MAIN_MODEL;
      else process.env.CC_MAIN_MODEL = previous;
    }
  });
});
