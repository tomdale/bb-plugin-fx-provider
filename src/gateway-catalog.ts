import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ModelReasoningEffort,
  ReasoningLevel,
} from "@get-bb/plugin-sdk/provider-bridge";

/** One language model from the public Vercel AI Gateway catalog. */
export interface GatewayModel {
  id: string;
  /** Display name ("Claude Sonnet 5.5"); empty when the catalog has none. */
  name: string;
  /** Vendor slug ("anthropic"); empty when the catalog has none. */
  ownedBy: string;
  /** Release time in Unix seconds; 0 when unknown. */
  released: number;
  contextWindow: number | undefined;
  tags: readonly string[];
  /** Effort values in catalog order, filtered exactly as fx filters them. */
  reasoningEfforts: readonly string[];
}

export type GatewayCatalog = ReadonlyMap<string, GatewayModel>;

const DEFAULT_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const CATALOG_PATH = "/v1/models";

/**
 * The public catalog URL on the Gateway fx talks to. fx honors
 * `FX_GATEWAY_BASE_URL` only for a loopback `http:` URL with an explicit port
 * and no credentials (the variable is a local-testing hook and must never
 * redirect fx's credentials elsewhere), so the same rule decides where the
 * plugin reads the catalog.
 */
export function gatewayCatalogUrl(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env.FX_GATEWAY_BASE_URL;
  const base =
    override !== undefined && isLoopbackHttpUrl(override)
      ? override.replace(/\/+$/, "")
      : DEFAULT_GATEWAY_BASE_URL;
  return `${base}${CATALOG_PATH}`;
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Parse the Gateway `/v1/models` response. Malformed entries and non-language
 * models are skipped individually; a response without a `data` array yields
 * `null`.
 */
export function parseGatewayCatalog(
  json: unknown,
): Map<string, GatewayModel> | null {
  if (!isRecord(json) || !Array.isArray(json.data)) return null;
  const catalog = new Map<string, GatewayModel>();
  for (const entry of json.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") {
      continue;
    }
    // fx keeps entries without a type and drops every other model type.
    if (
      typeof entry.type === "string" &&
      entry.type.toLowerCase() !== "language"
    ) {
      continue;
    }
    catalog.set(entry.id, {
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name.trim() : "",
      ownedBy: typeof entry.owned_by === "string" ? entry.owned_by.trim() : "",
      released: Number.isSafeInteger(entry.released)
        ? (entry.released as number)
        : 0,
      contextWindow:
        Number.isSafeInteger(entry.context_window) &&
        (entry.context_window as number) > 0
          ? (entry.context_window as number)
          : undefined,
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      reasoningEfforts: parseFxReasoningEfforts(entry.reasoning_options),
    });
  }
  return catalog;
}

/** fx's limit on effort options per model (`ReasoningEffort.max_options`). */
const FX_MAX_EFFORT_OPTIONS = 16;
const FX_EFFORT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const FX_AUTO_EFFORTS = new Set(["auto", "adaptive", "default"]);

/**
 * The effort values fx offers for a model, computed as fx's
 * `parseReasoningEfforts` (`src/builtins/gateway.zig`) computes them: the
 * first `reasoning_options` entry of type `effort` that carries a `values`
 * array, its string values in order, skipping names fx rejects and the
 * values fx treats as its own `auto` choice. fx's ACP `effort` option offers
 * exactly these values after `auto`.
 */
export function parseFxReasoningEfforts(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  for (const option of options) {
    if (!isRecord(option) || option.type !== "effort") continue;
    if (!Array.isArray(option.values)) continue;
    const efforts: string[] = [];
    for (const value of option.values) {
      if (efforts.length >= FX_MAX_EFFORT_OPTIONS) break;
      if (typeof value !== "string" || !FX_EFFORT_NAME.test(value)) continue;
      if (FX_AUTO_EFFORTS.has(value.toLowerCase())) continue;
      efforts.push(value);
    }
    return efforts;
  }
  return [];
}

/** bb's effort ladder, lowest first: the levels fx effort values reach. */
export const FX_REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningLevel[];

/**
 * The bb level each fx effort value stands for. Matching is exact because the
 * shared ACP bridge maps a level back to fx's option values exactly
 * (`acpNativeReasoningLevelToValue`): `low` selects fx's `low`, else
 * `minimal`; every other level selects the value of the same name.
 */
const LEVEL_BY_FX_EFFORT: ReadonlyMap<
  string,
  (typeof FX_REASONING_LEVELS)[number]
> = new Map([
  ["none", "none"],
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
]);

const LEVEL_DESCRIPTIONS: Readonly<
  Record<(typeof FX_REASONING_LEVELS)[number], string>
> = {
  none: "No extended thinking",
  low: "Low reasoning effort",
  medium: "Medium reasoning effort",
  high: "High reasoning effort",
  xhigh: "Extra high reasoning effort",
  max: "Maximum reasoning effort",
};

/**
 * Map fx effort values onto bb levels: one entry per level, in ladder order.
 * Values with no bb level are left out; fx still offers them in its own UI.
 */
export function toBbReasoningEfforts(
  fxEfforts: readonly string[],
): ModelReasoningEffort[] {
  return FX_REASONING_LEVELS.flatMap((level) => {
    if (!fxEfforts.some((value) => LEVEL_BY_FX_EFFORT.get(value) === level)) {
      return [];
    }
    const description =
      level === "low" && !fxEfforts.includes("low")
        ? "Minimal reasoning effort"
        : LEVEL_DESCRIPTIONS[level];
    return [{ reasoningEffort: level, description }];
  });
}

/**
 * The effort a model starts at: medium when offered, else high, else the
 * lowest level that still reasons, else none. fx reports its own `auto`
 * choice as the current effort, which names no level, so the default is a
 * fixed preference rather than fx's current value.
 */
export function defaultReasoningEffort(
  efforts: readonly Pick<ModelReasoningEffort, "reasoningEffort">[],
): ReasoningLevel {
  const levels = efforts.map((effort) => effort.reasoningEffort);
  if (levels.includes("medium")) return "medium";
  if (levels.includes("high")) return "high";
  return levels.find((level) => level !== "none") ?? "none";
}

export interface GatewayCatalogCacheOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** How long a fetched catalog is used without refetching. */
  ttlMs?: number;
  /** How long one fetch may take before a cached copy is used instead. */
  timeoutMs?: number;
  /** The largest response accepted; the real catalog is about 0.5 MB. */
  maxBytes?: number;
  /**
   * The directory that keeps the last good catalog, once known. BB stops an
   * idle bridge about a minute after its last request, so most refreshes
   * start in a fresh process; the copy on disk survives that.
   */
  storeDir?: () => string | undefined;
  log?: (message: string) => void;
}

export interface GatewayCatalogLookup {
  catalog: GatewayCatalog;
  /** The fetch failed and this copy is older than the TTL. */
  stale: boolean;
}

/**
 * bb refreshes a host's model list every 10 minutes, so with the default TTL
 * each refresh fetches the catalog at most once, concurrently with the fx
 * queries, and requests in between are answered from memory.
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const STORE_FILE = "gateway-catalog.json";

/**
 * A cache of the public Gateway catalog, one entry per URL, kept in memory
 * and, when a store directory is known, on disk. Concurrent lookups share one
 * fetch. A failed fetch falls back to the last good copy, however old, so a
 * Gateway outage does not strip names and efforts from the picker; `null`
 * means no copy was ever fetched.
 */
export function createGatewayCatalogCache(
  options: GatewayCatalogCacheOptions = {},
) {
  const fetchCatalog = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const log = options.log ?? (() => {});
  const entries = new Map<
    string,
    { catalog: GatewayCatalog; fetchedAt: number }
  >();
  const inFlight = new Map<string, Promise<GatewayCatalog | null>>();

  async function load(url: string): Promise<GatewayCatalog | null> {
    try {
      const response = await fetchCatalog(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = JSON.parse(await readBody(response, maxBytes));
      const catalog = parseGatewayCatalog(body);
      if (catalog === null) throw new Error("the response has no data array");
      const fetchedAt = now();
      entries.set(url, { catalog, fetchedAt });
      store(url, fetchedAt, body);
      return catalog;
    } catch (error) {
      log(`cannot fetch the Gateway catalog from ${url}: ${describe(error)}`);
      return null;
    }
  }

  function storePath(): string | undefined {
    const dir = options.storeDir?.();
    return dir === undefined ? undefined : join(dir, STORE_FILE);
  }

  function store(url: string, fetchedAt: number, body: unknown): void {
    const path = storePath();
    if (path === undefined) return;
    try {
      mkdirSync(join(path, ".."), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ url, fetchedAt, body }));
      renameSync(temp, path);
    } catch (error) {
      log(`cannot save the Gateway catalog: ${describe(error)}`);
    }
  }

  /** The stored copy for `url`, read once per process. */
  function restore(url: string): void {
    const path = storePath();
    if (path === undefined || entries.has(url)) return;
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as {
        url?: unknown;
        fetchedAt?: unknown;
        body?: unknown;
      };
      if (saved.url !== url || typeof saved.fetchedAt !== "number") return;
      const catalog = parseGatewayCatalog(saved.body);
      if (catalog !== null) {
        entries.set(url, { catalog, fetchedAt: saved.fetchedAt });
      }
    } catch {
      // No usable copy: the next fetch decides.
    }
  }

  return {
    async get(url: string): Promise<GatewayCatalogLookup | null> {
      restore(url);
      const cached = entries.get(url);
      if (cached && now() - cached.fetchedAt < ttlMs) {
        return { catalog: cached.catalog, stale: false };
      }
      let pending = inFlight.get(url);
      if (pending === undefined) {
        pending = load(url).finally(() => inFlight.delete(url));
        inFlight.set(url, pending);
      }
      const fresh = await pending;
      if (fresh !== null) return { catalog: fresh, stale: false };
      const fallback = entries.get(url);
      return fallback ? { catalog: fallback.catalog, stale: true } : null;
    },
  };
}

/** The response body as text, refusing more than `maxBytes`. */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    throw new Error(`the response exceeds ${maxBytes} bytes`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`the response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "timed out" : error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
