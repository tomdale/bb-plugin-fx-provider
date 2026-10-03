import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import {
  defaultReasoningEffort,
  toBbReasoningEfforts,
  type GatewayCatalog,
  type GatewayModel,
} from "./gateway-catalog.js";

/** A `model/list` result: the picker's models, then its "More models". */
export interface ModelListResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

/**
 * Vendors whose newest models lead the picker, in picker order, and how many
 * model families each contributes. The table names vendors only: which
 * models fill a vendor's slots is decided from the live catalog, so new
 * releases replace old ones without a plugin update. xAI appears under both
 * Gateway slugs it has used.
 */
export const FEATURED_VENDORS: readonly { vendor: string; families: number }[] =
  [
    { vendor: "anthropic", families: 3 },
    { vendor: "openai", families: 3 },
    { vendor: "google", families: 2 },
    { vendor: "xai", families: 2 },
    { vendor: "spacexai", families: 2 },
    { vendor: "deepseek", families: 2 },
    { vendor: "moonshotai", families: 1 },
    { vendor: "zai", families: 2 },
    { vendor: "alibaba", families: 1 },
    { vendor: "minimax", families: 1 },
    { vendor: "mistral", families: 1 },
  ];

/** Name tokens that mark a small, beta, or special-purpose variant. */
const VARIANT_TOKENS = new Set([
  "mini",
  "nano",
  "lite",
  "oss",
  "safeguard",
  "beta",
]);
/** Open-weight size labels such as `120b`, `2.4t` and `a95b`. */
const PARAMETER_SIZE_TOKEN = /^a?\d+(?:\.\d+)?[bt]$/;
const FAST_SUFFIX = "-fast";

/**
 * Build the picker from the ids fx accepts for this account, fx's configured
 * default model, and the public Gateway catalog.
 *
 * `models` holds the default model first, then the featured models: for each
 * vendor in {@link FEATURED_VENDORS}, the newest model of each of its newest
 * families (see {@link isFeaturable} and {@link modelFamily}). Every other id
 * fx lists follows in `selectedOnlyModels`, in fx's order. An id the catalog
 * does not describe is still listed, under its own id and without effort
 * choices.
 */
export function buildModelList(args: {
  ids: readonly string[];
  defaultModel: string | undefined;
  catalog: GatewayCatalog;
}): ModelListResult {
  const listed = [...new Set(args.ids)];
  const all =
    args.defaultModel === undefined || listed.includes(args.defaultModel)
      ? listed
      : [args.defaultModel, ...listed];
  const entries = new Map(
    all.map((id) => [id, toAvailableModel(id, args.catalog.get(id))]),
  );
  disambiguateDisplayNames([...entries.values()]);

  const featured = featuredModelIds(new Set(listed), args.catalog);
  const defaultId = args.defaultModel ?? featured[0] ?? all[0];
  const primary = [...new Set([defaultId, ...featured])].filter(
    (id): id is string => id !== undefined && entries.has(id),
  );
  const primarySet = new Set(primary);
  return {
    models: primary.map((id) => ({
      ...entries.get(id)!,
      isDefault: id === defaultId,
    })),
    selectedOnlyModels: all
      .filter((id) => !primarySet.has(id))
      .map((id) => entries.get(id)!),
  };
}

function toAvailableModel(
  id: string,
  model: GatewayModel | undefined,
): AvailableModel {
  const efforts = model ? toBbReasoningEfforts(model.reasoningEfforts) : [];
  const vendor = model?.ownedBy || vendorOf(id);
  return {
    id,
    model: id,
    displayName: model?.name || id,
    ...(vendor ? { routeProviderId: vendor } : {}),
    description: model ? describeModel(model, efforts.length > 0) : "",
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: defaultReasoningEffort(efforts),
    isDefault: false,
  };
}

/** "1M context · reasoning, vision, web search". */
function describeModel(model: GatewayModel, hasEfforts: boolean): string {
  const traits: string[] = [];
  if (hasEfforts || model.tags.includes("reasoning")) traits.push("reasoning");
  if (model.tags.includes("vision")) traits.push("vision");
  if (model.tags.includes("web-search")) traits.push("web search");
  // fx is an agent: a model that cannot call tools cannot do its work.
  if (!model.tags.includes("tool-use")) traits.push("no tool use");
  const facts = [
    ...(model.contextWindow
      ? [`${formatTokens(model.contextWindow)} context`]
      : []),
    ...(traits.length > 0 ? [traits.join(", ")] : []),
  ];
  return facts.join(" · ");
}

/** 1,048,576 → "1M", 1,050,000 → "1.05M", 32,768 → "32K", 400,000 → "400K". */
function formatTokens(tokens: number): string {
  // Windows sized in binary units (multiples of 4Ki) are named in them.
  const unit = tokens % 4096 === 0 ? 1024 : 1000;
  return tokens >= unit * unit
    ? `${Number((tokens / (unit * unit)).toFixed(2))}M`
    : `${Math.round(tokens / unit)}K`;
}

/** Catalog names are not unique ("GPT 5.2" is two models); ids are. */
function disambiguateDisplayNames(models: AvailableModel[]): void {
  const counts = new Map<string, number>();
  for (const model of models) {
    counts.set(model.displayName, (counts.get(model.displayName) ?? 0) + 1);
  }
  for (const model of models) {
    if (counts.get(model.displayName)! > 1 && model.displayName !== model.id) {
      model.displayName = `${model.displayName} (${nameOf(model.id)})`;
    }
  }
}

function featuredModelIds(
  listed: ReadonlySet<string>,
  catalog: GatewayCatalog,
): string[] {
  return FEATURED_VENDORS.flatMap(({ vendor, families }) => {
    const newestByFamily = new Map<string, GatewayModel>();
    for (const id of listed) {
      const model = catalog.get(id);
      if (vendorOf(id) !== vendor || !model || !isFeaturable(model, listed)) {
        continue;
      }
      const family = modelFamily(id);
      const current = newestByFamily.get(family);
      if (current === undefined || isNewer(model, current)) {
        newestByFamily.set(family, model);
      }
    }
    return [...newestByFamily.values()]
      .sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0))
      .slice(0, families)
      .map((model) => model.id);
  });
}

/**
 * A model can lead the picker when fx can drive it as an agent (it calls
 * tools) and it is a vendor's main model rather than a fast twin of one, a
 * small or beta variant, or an open-weight build labeled by size.
 */
export function isFeaturable(
  model: GatewayModel,
  listed: ReadonlySet<string>,
): boolean {
  if (!model.tags.includes("tool-use")) return false;
  if (
    model.id.endsWith(FAST_SUFFIX) &&
    listed.has(model.id.slice(0, -FAST_SUFFIX.length))
  ) {
    return false;
  }
  const name = nameOf(model.id);
  if (name.includes("non-reasoning")) return false;
  return !name
    .split("-")
    .some(
      (token) => VARIANT_TOKENS.has(token) || PARAMETER_SIZE_TOKEN.test(token),
    );
}

/**
 * The model's family: its id with version numbers removed, so successive
 * releases share one ("anthropic/claude-opus-5.5" → "anthropic/claude-opus",
 * "openai/gpt-6.1-sol" → "openai/gpt-sol", "moonshotai/kimi-k3" →
 * "moonshotai/kimi-k").
 */
export function modelFamily(id: string): string {
  const name = nameOf(id);
  const tokens = name
    .split("-")
    .map((token) => token.replace(/[\d.]/g, ""))
    .filter((token) => token !== "" && token !== "v");
  return `${vendorOf(id)}/${tokens.length > 0 ? tokens.join("-") : name}`;
}

/** Newer release first; on a tie the shorter id (the base model), then id order. */
function isNewer(a: GatewayModel, b: GatewayModel): boolean {
  if (a.released !== b.released) return a.released > b.released;
  if (a.id.length !== b.id.length) return a.id.length < b.id.length;
  return a.id < b.id;
}

function vendorOf(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "";
}

function nameOf(id: string): string {
  return id.slice(id.indexOf("/") + 1);
}
