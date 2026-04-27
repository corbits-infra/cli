#!/usr/bin/env pnpm tsx

import t from "tap";
import {
  search,
  listAllProxies,
  getProxy,
  getProxyOpenAPI,
  listAllProxyEndpoints,
  APIError,
  ValidationError,
  qs,
} from "../src/api/client.js";
import {
  mockFetch,
  validProxy,
  validEndpoint,
  withTempConfigHome,
} from "./test-helpers.js";

await t.test("qs utility", async (t) => {
  withTempConfigHome(t);
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
  withTempConfigHome(t);
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

  await t.test(
    "normalizes a trailing slash in the configured base URL",
    async (t) => {
      const mock = mockFetch(() => ({
        status: 200,
        body: { proxies: [], endpoints: [] },
      }));
      t.teardown(mock.restore);

      await search("helius", "https://api.corbits.dev/");
      t.equal(mock.calls[0], "https://api.corbits.dev/api/v1/search?q=helius");
      t.end();
    },
  );
});

await t.test("listAllProxies", async (t) => {
  withTempConfigHome(t);
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

  await t.test(
    "stops when nextCursor is undefined (not just null)",
    async (t) => {
      const mock = mockFetch(() => ({
        status: 200,
        body: {
          data: [validProxy],
          pagination: { hasMore: true },
        },
      }));
      t.teardown(mock.restore);

      const result = await listAllProxies();
      t.equal(result.length, 1);
      t.equal(mock.calls.length, 1, "should not make a second request");
      t.end();
    },
  );
});

await t.test("listAllProxyEndpoints", async (t) => {
  withTempConfigHome(t);
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
  withTempConfigHome(t);
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

await t.test("getProxyOpenAPI", async (t) => {
  withTempConfigHome(t);
  await t.test("returns validated openapi response", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        data: { id: 1, name: "helius", spec: { openapi: "3.0.0" } },
      },
    }));
    t.teardown(mock.restore);

    const result = await getProxyOpenAPI(1);
    t.equal(result.data.name, "helius");
    t.ok(mock.calls[0]?.endsWith("/api/v1/proxies/1/openapi"));
    t.end();
  });
});

await t.test("error handling", async (t) => {
  withTempConfigHome(t);
  await t.test("throws APIError on non-ok response", async (t) => {
    const mock = mockFetch(() => ({
      status: 404,
      body: { error: "Proxy not found" },
    }));
    t.teardown(mock.restore);

    try {
      await getProxy(999);
      t.fail("should have thrown");
    } catch (err) {
      t.ok(err instanceof APIError);
      t.equal((err as APIError).status, 404);
      t.ok((err as APIError).message.includes("404"));
    }
    t.end();
  });

  await t.test(
    "throws ValidationError with descriptive message on malformed response",
    async (t) => {
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
        const msg = (err as ValidationError).message;
        t.ok(msg.length > 0, "message should not be empty");
        t.ok(
          msg.includes("must be") || msg.includes("required"),
          "message should describe validation failure",
        );
      }
      t.end();
    },
  );
});
