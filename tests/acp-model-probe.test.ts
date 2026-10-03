import { expect, it } from "vitest";
import { normalizeProbedModelCatalog } from "../src/acp-model-probe.js";

const effort = (reasoningEffort: string, description = reasoningEffort) => ({
  reasoningEffort,
  description,
});

it("removes synthetic fallback efforts from primary and selected-only models", () => {
  const model = {
    id: "unprobed-model",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      effort(
        "medium",
        "Reasoning effort is managed by the connected ACP agent.",
      ),
    ],
  };
  const expected = {
    ...model,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "none",
  };
  expect(
    normalizeProbedModelCatalog({
      models: [model],
      selectedOnlyModels: [model],
    }),
  ).toEqual({ models: [expected], selectedOnlyModels: [expected] });
  expect(model.supportedReasoningEfforts).toHaveLength(1);
});

it.each([
  { levels: ["medium"], expected: "medium" },
  { levels: ["none", "low", "medium", "high"], expected: "medium" },
  { levels: ["none", "low", "high", "max"], expected: "high" },
  { levels: ["low", "high"], expected: "high" },
  { levels: ["none", "low"], expected: "low" },
  { levels: ["none"], expected: "none" },
  { levels: [], expected: "none" },
])(
  "keeps real efforts and defaults $levels to $expected instead of fx's auto",
  ({ levels, expected }) => {
    // The shared bridge reads fx's current `auto` effort as the lowest level.
    const model = {
      id: "model",
      supportedReasoningEfforts: levels.map((level) => effort(level)),
      defaultReasoningEffort: levels[0] ?? "medium",
    };
    expect(normalizeProbedModelCatalog({ models: [model] })).toEqual({
      models: [{ ...model, defaultReasoningEffort: expected }],
    });
  },
);
