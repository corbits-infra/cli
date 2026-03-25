#!/usr/bin/env pnpm tsx

import t from "tap";

const validProxy = {
  id: 1,
  name: "helius",
  org_slug: null,
  default_price_usdc: 10000,
  default_scheme: "exact",
  tags: ["solana", "rpc"],
  url: "https://helius.api.corbits.dev",
};

const validProxy2 = {
  id: 2,
  name: "jupiter",
  org_slug: null,
  default_price_usdc: 5000,
  default_scheme: "exact",
  tags: ["solana", "dex"],
  url: "https://jupiter.api.corbits.dev",
};

const searchEndpoint = {
  id: 10,
  path_pattern: "/v1/tokens/*",
  tags: ["tokens"],
  proxy_id: 1,
  proxy_name: "helius",
};

function mockFetch(
  handler: (url: string) => { status: number; body: unknown },
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let captured = "";
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
  const result = fn();
  if (result instanceof Promise) {
    return result.then(
      () => {
        process.stdout.write = original;
        return captured;
      },
      (err) => {
        process.stdout.write = original;
        throw err;
      },
    );
  }
  process.stdout.write = original;
  return Promise.resolve(captured);
}

// We import the command handlers after defining mocks so we can
// control fetch within each test. cmd-ts handlers are just async
// functions once you extract them.
const { discover } = await import("../src/commands/discover.js");
const { inspect } = await import("../src/commands/inspect.js");

await t.test("discover command", async (t) => {
  await t.test("lists all proxies when no query", async (t) => {
    const restore = mockFetch(() => ({
      status: 200,
      body: {
        data: [validProxy, validProxy2],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(restore);

    const output = await captureStdout(() =>
      discover.handler({
        query: undefined,
        tag: undefined,
        format: undefined,
      }),
    );
    t.ok(output.includes("helius"));
    t.ok(output.includes("jupiter"));
    t.end();
  });

  await t.test("searches when query provided", async (t) => {
    const restore = mockFetch((url) => {
      if (url.includes("/search")) {
        return {
          status: 200,
          body: {
            proxies: [validProxy],
            endpoints: [searchEndpoint],
          },
        };
      }
      return {
        status: 200,
        body: { data: [], pagination: { hasMore: false } },
      };
    });
    t.teardown(restore);

    const output = await captureStdout(() =>
      discover.handler({
        query: "helius",
        tag: undefined,
        format: undefined,
      }),
    );
    t.ok(output.includes("helius"));
    t.ok(output.includes("Matching endpoints"));
    t.ok(output.includes("/v1/tokens/*"));
    t.end();
  });

  await t.test("filters by tag case-insensitively", async (t) => {
    const restore = mockFetch(() => ({
      status: 200,
      body: {
        data: [validProxy, validProxy2],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(restore);

    const output = await captureStdout(() =>
      discover.handler({
        query: undefined,
        tag: "DEX",
        format: undefined,
      }),
    );
    t.notOk(output.includes("helius"), "helius should be filtered out");
    t.ok(output.includes("jupiter"), "jupiter has dex tag");
    t.end();
  });

  await t.test("shows no services found message", async (t) => {
    const restore = mockFetch(() => ({
      status: 200,
      body: {
        data: [],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(restore);

    const output = await captureStdout(() =>
      discover.handler({
        query: undefined,
        tag: undefined,
        format: undefined,
      }),
    );
    t.ok(output.includes("No services found"));
    t.end();
  });

  await t.test("outputs JSON when format is json", async (t) => {
    const restore = mockFetch(() => ({
      status: 200,
      body: {
        data: [validProxy],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(restore);

    const output = await captureStdout(() =>
      discover.handler({
        query: undefined,
        tag: undefined,
        format: "json",
      }),
    );
    const parsed = JSON.parse(output);
    t.ok(Array.isArray(parsed));
    t.equal(parsed[0].name, "helius");
    t.end();
  });

  await t.test("search JSON includes endpoints", async (t) => {
    const restore = mockFetch(() => ({
      status: 200,
      body: { proxies: [validProxy], endpoints: [searchEndpoint] },
    }));
    t.teardown(restore);

    const output = await captureStdout(() =>
      discover.handler({
        query: "test",
        tag: undefined,
        format: "json",
      }),
    );
    const parsed = JSON.parse(output);
    t.ok(parsed.proxies);
    t.ok(parsed.endpoints);
    t.equal(parsed.endpoints.length, 1);
    t.end();
  });
});

await t.test("inspect command", async (t) => {
  await t.test("shows proxy details and endpoints", async (t) => {
    const restore = mockFetch((url) => {
      if (url.includes("/endpoints")) {
        return {
          status: 200,
          body: {
            data: [
              {
                id: 10,
                path_pattern: "/v1/tokens/*",
                tags: [],
                price_usdc: null,
                scheme: null,
              },
            ],
            pagination: { nextCursor: null, hasMore: false },
          },
        };
      }
      return {
        status: 200,
        body: { data: { ...validProxy, endpoint_count: 1 } },
      };
    });
    t.teardown(restore);

    const output = await captureStdout(() =>
      inspect.handler({
        proxyId: 1,
        openapi: false,
        format: undefined,
      }),
    );
    t.ok(output.includes("helius (ID: 1)"));
    t.ok(output.includes("$0.010000"));
    t.ok(output.includes("Endpoints: 1"));
    t.ok(output.includes("/v1/tokens/*"));
    t.end();
  });

  await t.test("outputs JSON for inspect", async (t) => {
    const restore = mockFetch((url) => {
      if (url.includes("/endpoints")) {
        return {
          status: 200,
          body: {
            data: [],
            pagination: { nextCursor: null, hasMore: false },
          },
        };
      }
      return {
        status: 200,
        body: { data: { ...validProxy, endpoint_count: 0 } },
      };
    });
    t.teardown(restore);

    const output = await captureStdout(() =>
      inspect.handler({
        proxyId: 1,
        openapi: false,
        format: "json",
      }),
    );
    const parsed = JSON.parse(output);
    t.equal(parsed.proxy.name, "helius");
    t.ok(Array.isArray(parsed.endpoints));
    t.end();
  });

  await t.test("openapi flag dumps spec as yaml", async (t) => {
    const restore = mockFetch((url) => {
      if (url.includes("/openapi")) {
        return {
          status: 200,
          body: {
            data: {
              id: 1,
              name: "helius",
              spec: { openapi: "3.0.0", paths: { "/v1/test": {} } },
            },
          },
        };
      }
      if (url.includes("/endpoints")) {
        return {
          status: 200,
          body: {
            data: [],
            pagination: { nextCursor: null, hasMore: false },
          },
        };
      }
      return {
        status: 200,
        body: { data: { ...validProxy, endpoint_count: 0 } },
      };
    });
    t.teardown(restore);

    const output = await captureStdout(() =>
      inspect.handler({
        proxyId: 1,
        openapi: true,
        format: undefined,
      }),
    );
    t.ok(output.includes("openapi:"));
    t.ok(output.includes("/v1/test"));
    t.end();
  });

  await t.test("openapi flag with json format", async (t) => {
    const restore = mockFetch((url) => {
      if (url.includes("/openapi")) {
        return {
          status: 200,
          body: {
            data: {
              id: 1,
              name: "helius",
              spec: { openapi: "3.0.0" },
            },
          },
        };
      }
      if (url.includes("/endpoints")) {
        return {
          status: 200,
          body: {
            data: [],
            pagination: { nextCursor: null, hasMore: false },
          },
        };
      }
      return {
        status: 200,
        body: { data: { ...validProxy, endpoint_count: 0 } },
      };
    });
    t.teardown(restore);

    const output = await captureStdout(() =>
      inspect.handler({
        proxyId: 1,
        openapi: true,
        format: "json",
      }),
    );
    const parsed = JSON.parse(output);
    t.equal(parsed.openapi, "3.0.0");
    t.end();
  });
});
