import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseGatewayCatalog,
  type GatewayModel,
} from "../src/gateway-catalog.js";
import {
  buildModelList,
  isFeaturable,
  modelFamily,
} from "../src/model-list.js";

const readFixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
const catalog = parseGatewayCatalog(readFixture("gateway-models.json"))!;
const fxIds: string[] = readFixture("fx-models.json").ids;
const fxDefault: string = readFixture("fx-status.json").model;

const build = (overrides: Partial<Parameters<typeof buildModelList>[0]> = {}) =>
  buildModelList({
    ids: fxIds,
    defaultModel: fxDefault,
    catalog,
    ...overrides,
  });
const byId = (result: ReturnType<typeof buildModelList>, id: string) =>
  [...result.models, ...result.selectedOnlyModels].find(
    (model) => model.id === id,
  );

describe("buildModelList", () => {
  it("leads with fx's default model, then each featured vendor's newest families", () => {
    expect(build().models.map((model) => model.id)).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-fable-5.1",
      "openai/gpt-6.1-sol",
      "openai/gpt-6-luna",
      "openai/gpt-6-astra",
      "google/gemini-3.8-flash",
      "google/gemini-3.1-pro-preview",
      "spacexai/grok-4.7",
      "spacexai/grok-build-0.1",
      "deepseek/deepseek-v4-pro-0813",
      "moonshotai/kimi-k3",
      "zai/glm-5.3-flash",
      "zai/glm-5.3",
      "alibaba/qwen3.8-max",
      "minimax/minimax-m3",
    ]);
  });

  it("keeps every other id fx lists selectable, in fx's order", () => {
    const result = build();
    const primary = new Set(result.models.map((model) => model.id));
    expect(result.selectedOnlyModels.map((model) => model.id)).toEqual(
      fxIds.filter((id) => !primary.has(id)),
    );
    // Fast twins, small and beta variants, open-weight builds, older versions
    // and a vendor outside the featured table stay under More models.
    expect(result.selectedOnlyModels.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "anthropic/claude-opus-5.5-fast",
        "anthropic/claude-opus-5",
        "openai/gpt-5.4-mini",
        "openai/gpt-oss-120b",
        "google/gemini-3.5-flash-lite",
        "spacexai/grok-4.20-reasoning-beta",
        "spacexai/grok-4.20-non-reasoning",
        "moonshotai/kimi-k3-fast",
        "zai/glm-5.3-fast",
        "meta/llama-4-maverick",
      ]),
    );
  });

  it("marks exactly one default", () => {
    const result = build();
    expect(
      result.models.filter((model) => model.isDefault).map((model) => model.id),
    ).toEqual([fxDefault]);
    expect(result.selectedOnlyModels.some((model) => model.isDefault)).toBe(
      false,
    );
  });

  it("describes models from the Gateway catalog", () => {
    expect(byId(build(), "anthropic/claude-sonnet-5.5")).toEqual({
      id: "anthropic/claude-sonnet-5.5",
      model: "anthropic/claude-sonnet-5.5",
      displayName: "Claude Sonnet 5.5",
      routeProviderId: "anthropic",
      description: "1M context · reasoning, vision, web search",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Low reasoning effort" },
        { reasoningEffort: "medium", description: "Medium reasoning effort" },
        { reasoningEffort: "high", description: "High reasoning effort" },
        {
          reasoningEffort: "xhigh",
          description: "Extra high reasoning effort",
        },
        { reasoningEffort: "max", description: "Maximum reasoning effort" },
      ],
      defaultReasoningEffort: "medium",
      isDefault: false,
    });
  });

  it.each([
    // [model, bb levels, default]
    ["deepseek/deepseek-v4.1-flash", ["none", "low", "high", "max"], "high"],
    ["openai/gpt-5", ["low", "medium", "high"], "medium"],
    [
      "openai/gpt-5.4-mini",
      ["none", "low", "medium", "high", "xhigh"],
      "medium",
    ],
    ["google/gemini-3.8-flash", ["low", "high"], "high"],
    ["anthropic/claude-haiku-4.5", [], "none"],
    ["minimax/minimax-m3", [], "none"],
  ])(
    "offers %s the efforts fx offers it: %j, starting at %s",
    (id, levels, expected) => {
      const model = byId(build(), id)!;
      expect(
        model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      ).toEqual(levels);
      expect(model.defaultReasoningEffort).toBe(expected);
    },
  );

  it("lists an id the catalog does not describe under its own id", () => {
    expect(byId(build(), "acme/team-private-model")).toEqual({
      id: "acme/team-private-model",
      model: "acme/team-private-model",
      displayName: "acme/team-private-model",
      routeProviderId: "acme",
      description: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "none",
      isDefault: false,
    });
  });

  it("tells apart models the catalog gives the same name", () => {
    const result = build();
    expect(byId(result, "openai/gpt-5.2")?.displayName).toBe(
      "GPT 5.2 (gpt-5.2)",
    );
    expect(byId(result, "openai/gpt-5.2-pro")?.displayName).toBe(
      "GPT 5.2 (gpt-5.2-pro)",
    );
  });

  it("flags a model fx cannot drive with tools and names binary-sized windows", () => {
    expect(byId(build(), "google/gemini-2.5-flash-image")?.description).toBe(
      "32K context · reasoning, vision, web search, no tool use",
    );
    expect(byId(build(), "deepseek/deepseek-v4.1-flash")?.description).toBe(
      "1M context · reasoning, vision",
    );
    expect(byId(build(), "openai/gpt-6.1-sol")?.description).toBe(
      "1.05M context · reasoning, vision, web search",
    );
  });

  it("lists fx's default model even when fx's listing omits it", () => {
    const result = build({ defaultModel: "acme/unlisted-default" });
    expect(result.models[0]).toMatchObject({
      id: "acme/unlisted-default",
      displayName: "acme/unlisted-default",
      isDefault: true,
    });
    expect(result.models.filter((model) => model.isDefault)).toHaveLength(1);
  });

  it("defaults to the first featured model when fx names no default", () => {
    const result = build({ defaultModel: undefined });
    expect(result.models[0]).toMatchObject({
      id: "anthropic/claude-sonnet-5.5",
      isDefault: true,
    });
    expect(result.models.filter((model) => model.isDefault)).toHaveLength(1);
  });

  it("keeps a featured default in the lead without listing it twice", () => {
    const result = build({ defaultModel: "openai/gpt-6-luna" });
    expect(result.models.map((model) => model.id).slice(0, 3)).toEqual([
      "openai/gpt-6-luna",
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-opus-5.5",
    ]);
    expect(
      result.models.filter((model) => model.id === "openai/gpt-6-luna"),
    ).toHaveLength(1);
  });
});

describe("featured model rules", () => {
  const model = (id: string, tags = ["tool-use"]): GatewayModel => ({
    id,
    name: id,
    ownedBy: "",
    released: 0,
    contextWindow: undefined,
    tags,
    reasoningEfforts: [],
  });

  it.each([
    ["anthropic/claude-opus-5.5", "anthropic/claude-opus"],
    ["openai/gpt-6.1-sol", "openai/gpt-sol"],
    ["openai/gpt-5.3-codex", "openai/gpt-codex"],
    ["deepseek/deepseek-v4-pro-0813", "deepseek/deepseek-pro"],
    ["moonshotai/kimi-k3", "moonshotai/kimi-k"],
    ["alibaba/qwen3.8-max", "alibaba/qwen-max"],
    ["openai/o3", "openai/o"],
  ])("puts %s in family %s", (id, family) => {
    expect(modelFamily(id)).toBe(family);
  });

  it("features a fast model only when it is not a twin of a listed model", () => {
    const listed = new Set([
      "zai/glm-5.3",
      "zai/glm-5.3-fast",
      "zai/glm-6-fast",
    ]);
    expect(isFeaturable(model("zai/glm-5.3-fast"), listed)).toBe(false);
    expect(isFeaturable(model("zai/glm-6-fast"), listed)).toBe(true);
  });

  it.each([
    "openai/gpt-5.4-nano",
    "openai/gpt-oss-120b",
    "alibaba/qwen3.8-2.4t-a95b",
    "spacexai/grok-4.20-non-reasoning",
    "spacexai/grok-4.20-reasoning-beta",
  ])("does not feature %s", (id) => {
    expect(isFeaturable(model(id), new Set())).toBe(false);
  });

  it("does not feature a model that cannot call tools", () => {
    expect(isFeaturable(model("openai/gpt-7", ["reasoning"]), new Set())).toBe(
      false,
    );
  });
});
