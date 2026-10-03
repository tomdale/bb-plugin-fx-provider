import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayCatalogCache,
  defaultReasoningEffort,
  gatewayCatalogUrl,
  parseFxReasoningEfforts,
  parseGatewayCatalog,
  toBbReasoningEfforts,
} from "../src/gateway-catalog.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/gateway-models.json", import.meta.url),
    "utf8",
  ),
);

describe("parseFxReasoningEfforts (fx's parseReasoningEfforts)", () => {
  it("reads the first effort option that carries values, skipping fx's auto aliases", () => {
    expect(
      parseFxReasoningEfforts([
        { type: "toggle" },
        { type: "effort" },
        {
          type: "effort",
          values: ["auto", "low", "Default", "ADAPTIVE", "high"],
        },
        { type: "effort", values: ["max"] },
      ]),
    ).toEqual(["low", "high"]);
  });

  it("drops values fx cannot name and stops at fx's sixteen-option limit", () => {
    const many = Array.from({ length: 20 }, (_, index) => `e${index}`);
    expect(
      parseFxReasoningEfforts([
        {
          type: "effort",
          values: [42, "two words", "x".repeat(65), "ok-1.2_b", ...many],
        },
      ]),
    ).toEqual(["ok-1.2_b", ...many.slice(0, 15)]);
  });

  it.each([undefined, null, {}, "effort", [{ type: "budget_tokens", min: 1 }]])(
    "offers no efforts for %j",
    (options) => {
      expect(parseFxReasoningEfforts(options)).toEqual([]);
    },
  );
});

describe("toBbReasoningEfforts", () => {
  const levels = (values: string[]) =>
    toBbReasoningEfforts(values).map((effort) => effort.reasoningEffort);

  it("orders levels on bb's ladder and keeps one entry per level", () => {
    expect(
      levels(["max", "none", "minimal", "low", "high", "xhigh", "medium"]),
    ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("offers fx's minimal as bb's low when fx has no low", () => {
    expect(toBbReasoningEfforts(["minimal", "high"])).toEqual([
      { reasoningEffort: "low", description: "Minimal reasoning effort" },
      { reasoningEffort: "high", description: "High reasoning effort" },
    ]);
    expect(toBbReasoningEfforts(["minimal", "low"])).toEqual([
      { reasoningEffort: "low", description: "Low reasoning effort" },
    ]);
  });

  it("leaves out values the shared bridge cannot select by name", () => {
    // The bridge matches option values exactly, so "High" is unreachable.
    expect(levels(["ultra", "High", "turbo", "medium"])).toEqual(["medium"]);
  });
});

describe("defaultReasoningEffort", () => {
  it.each([
    [["none", "low", "medium", "high"], "medium"],
    [["none", "low", "high", "max"], "high"],
    [["low", "xhigh"], "low"],
    [["none", "xhigh", "max"], "xhigh"],
    [["none"], "none"],
    [[], "none"],
  ] as const)("chooses from %j: %s", (levels, expected) => {
    expect(
      defaultReasoningEffort(
        levels.map((reasoningEffort) => ({ reasoningEffort })),
      ),
    ).toBe(expected);
  });
});

describe("parseGatewayCatalog", () => {
  it("keeps language models and the fields the picker uses", () => {
    const catalog = parseGatewayCatalog(fixture)!;
    expect(catalog.has("bfl/flux-2-flex")).toBe(false);
    expect(catalog.get("anthropic/claude-sonnet-5.5")).toEqual({
      id: "anthropic/claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      ownedBy: "anthropic",
      released: 1790553600,
      contextWindow: 1_000_000,
      tags: expect.arrayContaining(["tool-use", "reasoning", "vision"]),
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("skips malformed entries, keeps untyped ones, and trims names", () => {
    const catalog = parseGatewayCatalog({
      data: [
        null,
        { id: 7 },
        { id: "" },
        {
          id: "vendor/untyped",
          name: " Untyped ",
          released: "soon",
          tags: ["tool-use", 3],
        },
        { id: "vendor/embedder", type: "embedding" },
      ],
    })!;
    expect([...catalog.keys()]).toEqual(["vendor/untyped"]);
    expect(catalog.get("vendor/untyped")).toMatchObject({
      name: "Untyped",
      ownedBy: "",
      released: 0,
      contextWindow: undefined,
      tags: ["tool-use"],
      reasoningEfforts: [],
    });
  });

  it.each([null, [], {}, { data: {} }])(
    "rejects a response without data: %j",
    (json) => {
      expect(parseGatewayCatalog(json)).toBeNull();
    },
  );
});

describe("gatewayCatalogUrl", () => {
  it("reads the public Gateway catalog by default", () => {
    expect(gatewayCatalogUrl({})).toBe(
      "https://ai-gateway.vercel.sh/v1/models",
    );
  });

  it.each([
    "http://127.0.0.1:4100",
    "http://localhost:4100/",
    "http://[::1]:4100",
  ])("follows fx's loopback FX_GATEWAY_BASE_URL %s", (base) => {
    expect(gatewayCatalogUrl({ FX_GATEWAY_BASE_URL: base })).toBe(
      `${base.replace(/\/$/, "")}/v1/models`,
    );
  });

  it.each([
    "https://127.0.0.1:4100",
    "http://127.0.0.1",
    "http://user:secret@127.0.0.1:4100",
    "http://example.com:4100",
    "not a url",
  ])("ignores an FX_GATEWAY_BASE_URL fx would ignore: %s", (base) => {
    expect(gatewayCatalogUrl({ FX_GATEWAY_BASE_URL: base })).toBe(
      "https://ai-gateway.vercel.sh/v1/models",
    );
  });
});

describe("createGatewayCatalogCache", () => {
  const url = "http://127.0.0.1:1/v1/models";
  const ok = () => new Response(JSON.stringify(fixture), { status: 200 });

  function setup(responses: (() => Response | Promise<Response>)[]) {
    let time = 0;
    const fetch = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return next();
    });
    const log = vi.fn();
    const cache = createGatewayCatalogCache({
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => time,
      ttlMs: 1000,
      timeoutMs: 50,
      log,
    });
    return { cache, fetch, log, advance: (ms: number) => (time += ms) };
  }

  it("fetches once per TTL and shares a fetch between concurrent lookups", async () => {
    const { cache, fetch, advance } = setup([ok, ok]);
    const [first, second] = await Promise.all([cache.get(url), cache.get(url)]);
    expect(first?.stale).toBe(false);
    expect(second?.catalog).toBe(first?.catalog);
    advance(999);
    expect((await cache.get(url))?.catalog).toBe(first?.catalog);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(1);
    const refreshed = await cache.get(url);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refreshed?.catalog).not.toBe(first?.catalog);
  });

  it("answers with the last good copy, marked stale, when a refresh fails", async () => {
    const { cache, log, advance } = setup([
      ok,
      () => new Response("down", { status: 503 }),
      () => new Response(JSON.stringify({ error: "no data" }), { status: 200 }),
    ]);
    const first = await cache.get(url);
    advance(5000);
    expect(await cache.get(url)).toEqual({
      catalog: first!.catalog,
      stale: true,
    });
    expect(await cache.get(url)).toEqual({
      catalog: first!.catalog,
      stale: true,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no data array"));
  });

  it("gives up on a slow Gateway at the fetch deadline", async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    );
    const log = vi.fn();
    const cache = createGatewayCatalogCache({
      fetch: fetch as unknown as typeof globalThis.fetch,
      timeoutMs: 20,
      log,
    });
    expect(await cache.get(url)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("has nothing to offer before its first successful fetch", async () => {
    const { cache } = setup([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    expect(await cache.get(url)).toBeNull();
  });

  it("refuses a response larger than its limit", async () => {
    const log = vi.fn();
    const cache = createGatewayCatalogCache({
      fetch: (async () =>
        new Response(JSON.stringify(fixture), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
      maxBytes: 1024,
      log,
    });
    expect(await cache.get(url)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("exceeds 1024"));
  });

  // BB stops an idle bridge about a minute after its last request, so the
  // last good copy has to outlive the process that fetched it.
  describe("with a store directory", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "fx-catalog-store-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    function processCache(
      time: number,
      fetch: () => Response | Promise<Response>,
    ) {
      const fetchMock = vi.fn(async () => fetch());
      const cache = createGatewayCatalogCache({
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        now: () => time,
        ttlMs: 1000,
        storeDir: () => dir,
      });
      return { cache, fetchMock };
    }

    it("serves a fresh stored copy without fetching", async () => {
      const first = processCache(0, ok);
      const fetched = await first.cache.get(url);
      const next = processCache(500, () => {
        throw new Error("unexpected fetch");
      });
      const restored = await next.cache.get(url);
      expect(next.fetchMock).not.toHaveBeenCalled();
      expect(restored?.stale).toBe(false);
      expect([...restored!.catalog.keys()]).toEqual([...fetched!.catalog.keys()]);
    });

    it("falls back to an old stored copy when the Gateway fails", async () => {
      await processCache(0, ok).cache.get(url);
      const next = processCache(
        60_000,
        () => new Response("down", { status: 503 }),
      );
      const restored = await next.cache.get(url);
      expect(next.fetchMock).toHaveBeenCalledTimes(1);
      expect(restored?.stale).toBe(true);
      expect(restored?.catalog.size).toBeGreaterThan(0);
    });

    it("ignores a stored copy of another URL", async () => {
      await processCache(0, ok).cache.get(url);
      const next = processCache(
        500,
        () => new Response("down", { status: 503 }),
      );
      expect(await next.cache.get("http://127.0.0.1:2/v1/models")).toBeNull();
    });
  });
});
