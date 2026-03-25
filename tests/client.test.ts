#!/usr/bin/env pnpm tsx

import t from "tap";
import {
  search,
  listAllProxies,
  getProxy,
  getProxyOpenapi,
  listAllProxyEndpoints,
  ApiError,
  ValidationError,
  qs,
} from "../src/api/client.js";

const validProxy = {
  id: 1,
  name: "helius",
  org_slug: null,
  default_price_usdc: 10000,
  default_scheme: "exact",
  tags: [],
  url: "https://helius.api.corbits.dev",
};

const validEndpoint = {
  id: 1,
  path_pattern: "/v1/*",
  tags: [],
};

function mockFetch(
  handler: (url: string) => { status: number; body: unknown },
) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText:
        status === 200 ? "OK" : status === 404 ? "Not Found" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

await t.test("qs utility", async (t) => {
  await t.test("returns empty string for no params", async (t) => {
    t.equal(qs({}), "");
    t.end();
  });

  await t.test(
    "returns empty string when all values are undefined",
    async (t) => {
      t.equal(qs({ a: undefined, b: undefined }), "");
      t.end();
    },
  );

  await t.test("builds query string from defined params", async (t) => {
    const result = qs({ q: "test", limit: 20 });
    t.ok(result.startsWith("?"));
    t.ok(result.includes("q=test"));
    t.ok(result.includes("limit=20"));
    t.end();
  });

  await t.test("filters out undefined values", async (t) => {
    const result = qs({ q: "test", cursor: undefined });
    t.ok(result.includes("q=test"));
    t.notOk(result.includes("cursor"));
    t.end();
  });

  await t.test("handles numeric zero", async (t) => {
    const result = qs({ offset: 0 });
    t.ok(result.includes("offset=0"));
    t.end();
  });

  await t.test("handles empty string", async (t) => {
    const result = qs({ q: "" });
    t.ok(result.includes("q="));
    t.end();
  });
});

await t.test("search", async (t) => {
  await t.test(
    "calls search endpoint and returns validated data",
    async (t) => {
      const mock = mockFetch(() => ({
        status: 200,
        body: { proxies: [validProxy], endpoints: [] },
      }));
      t.teardown(mock.restore);

      const result = await search("helius");
      t.equal(result.proxies.length, 1);
      t.equal(result.proxies[0]?.name, "helius");
      t.equal(result.endpoints.length, 0);
      t.ok(mock.calls[0]?.includes("/api/v1/search?q=helius"));
      t.end();
    },
  );

  await t.test("calls search without query param when undefined", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: { proxies: [], endpoints: [] },
    }));
    t.teardown(mock.restore);

    await search();
    t.ok(mock.calls[0]?.endsWith("/api/v1/search"));
    t.end();
  });
});

await t.test("listAllProxies", async (t) => {
  await t.test("fetches single page when hasMore is false", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        data: [validProxy],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(mock.restore);

    const result = await listAllProxies();
    t.equal(result.length, 1);
    t.equal(mock.calls.length, 1);
    t.end();
  });

  await t.test("paginates through multiple pages", async (t) => {
    let callCount = 0;
    const mock = mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 200,
          body: {
            data: [{ ...validProxy, id: 1 }],
            pagination: { nextCursor: "cursor1", hasMore: true },
          },
        };
      }
      if (callCount === 2) {
        return {
          status: 200,
          body: {
            data: [{ ...validProxy, id: 2 }],
            pagination: { nextCursor: "cursor2", hasMore: true },
          },
        };
      }
      return {
        status: 200,
        body: {
          data: [{ ...validProxy, id: 3 }],
          pagination: { nextCursor: null, hasMore: false },
        },
      };
    });
    t.teardown(mock.restore);

    const result = await listAllProxies();
    t.equal(result.length, 3);
    t.equal(result[0]?.id, 1);
    t.equal(result[1]?.id, 2);
    t.equal(result[2]?.id, 3);
    t.equal(mock.calls.length, 3);
    t.ok(mock.calls[1]?.includes("cursor=cursor1"));
    t.ok(mock.calls[2]?.includes("cursor=cursor2"));
    t.end();
  });
});

await t.test("listAllProxyEndpoints", async (t) => {
  await t.test("paginates through endpoint pages", async (t) => {
    let callCount = 0;
    const mock = mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 200,
          body: {
            data: [{ ...validEndpoint, id: 1 }],
            pagination: { nextCursor: "c1", hasMore: true },
          },
        };
      }
      return {
        status: 200,
        body: {
          data: [{ ...validEndpoint, id: 2 }],
          pagination: { nextCursor: null, hasMore: false },
        },
      };
    });
    t.teardown(mock.restore);

    const result = await listAllProxyEndpoints(5);
    t.equal(result.length, 2);
    t.ok(mock.calls[0]?.includes("/proxies/5/endpoints"));
    t.ok(mock.calls[1]?.includes("cursor=c1"));
    t.end();
  });
});

await t.test("getProxy", async (t) => {
  await t.test("returns validated proxy detail", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: { data: { ...validProxy, endpoint_count: 3 } },
    }));
    t.teardown(mock.restore);

    const result = await getProxy(1);
    t.equal(result.data.name, "helius");
    t.equal(result.data.endpoint_count, 3);
    t.ok(mock.calls[0]?.endsWith("/api/v1/proxies/1"));
    t.end();
  });
});

await t.test("getProxyOpenapi", async (t) => {
  await t.test("returns validated openapi response", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        data: { id: 1, name: "helius", spec: { openapi: "3.0.0" } },
      },
    }));
    t.teardown(mock.restore);

    const result = await getProxyOpenapi(1);
    t.equal(result.data.name, "helius");
    t.ok(mock.calls[0]?.endsWith("/api/v1/proxies/1/openapi"));
    t.end();
  });
});

await t.test("error handling", async (t) => {
  await t.test("throws ApiError on non-ok response", async (t) => {
    const mock = mockFetch(() => ({
      status: 404,
      body: { error: "Proxy not found" },
    }));
    t.teardown(mock.restore);

    try {
      await getProxy(999);
      t.fail("should have thrown");
    } catch (err) {
      t.ok(err instanceof ApiError);
      t.equal((err as ApiError).status, 404);
      t.ok((err as ApiError).message.includes("404"));
    }
    t.end();
  });

  await t.test("throws ValidationError on malformed response", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: { data: { wrong: "shape" } },
    }));
    t.teardown(mock.restore);

    try {
      await getProxy(1);
      t.fail("should have thrown");
    } catch (err) {
      t.ok(err instanceof ValidationError);
    }
    t.end();
  });
});
