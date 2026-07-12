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
        },
        {
          slug: "codex-auto-review",
          display_name: "Codex Auto Review",
          description: "hidden",
          visibility: "hide",
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
    process.env.CC_WORKER_PROVIDER = "codex";
    try {
      const { buildApp } = await import("../src/daemon/api.js");
      const app = buildApp();
      const providers = await app.request("/api/providers");
      expect(await providers.json()).toEqual({ default_worker_provider: "codex" });

      const models = await app.request("/api/providers/claude/models");
      expect(await models.json()).toMatchObject({
        provider: "claude",
        models: [
          { slug: "haiku" },
          { slug: "sonnet" },
          { slug: "opus" },
        ],
      });
      expect((await app.request("/api/providers/other/models")).status).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.CC_WORKER_PROVIDER;
      else process.env.CC_WORKER_PROVIDER = previous;
    }
  });
});
