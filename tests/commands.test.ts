#!/usr/bin/env pnpm tsx

import t from "tap";
import {
  mockFetch,
  captureStdout,
  validProxy,
  validProxy2,
  searchEndpoint,
} from "./helpers.js";

const { discover } = await import("../src/commands/discover.js");
const { inspect } = await import("../src/commands/inspect.js");

await t.test("discover command", async (t) => {
  await t.test("lists all proxies in table with headers", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        data: [validProxy, validProxy2],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(mock.restore);

    const output = await captureStdout(() =>
      discover.handler({
        query: undefined,
        tag: undefined,
        format: undefined,
      }),
    );
    t.ok(output.includes("ID"), "should have ID header");
    t.ok(output.includes("Name"), "should have Name header");
    t.ok(output.includes("Price"), "should have Price header");
    t.ok(output.includes("helius"));
    t.ok(output.includes("jupiter"));
    t.ok(mock.calls[0]?.includes("/api/v1/proxies"));
    t.end();
  });

  await t.test("searches and shows both proxies and endpoints", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        proxies: [validProxy],
        endpoints: [searchEndpoint],
      },
    }));
    t.teardown(mock.restore);

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
    t.ok(mock.calls[0]?.includes("/api/v1/search?q=helius"));
    t.end();
  });

  await t.test("filters proxies by tag case-insensitively", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        data: [validProxy, validProxy2],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(mock.restore);

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

  await t.test("filters endpoints by tag when searching", async (t) => {
    const endpointWithTag = {
      ...searchEndpoint,
      id: 20,
      tags: ["dex"],
      proxy_name: "jupiter",
      proxy_id: 2,
    };
    const endpointNoTag = {
      ...searchEndpoint,
      id: 21,
      tags: ["rpc"],
      proxy_name: "helius",
      proxy_id: 1,
    };
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        proxies: [validProxy, validProxy2],
        endpoints: [endpointWithTag, endpointNoTag],
      },
    }));
    t.teardown(mock.restore);

    const output = await captureStdout(() =>
      discover.handler({
        query: "test",
        tag: "dex",
        format: undefined,
      }),
    );
    t.ok(output.includes("jupiter"), "jupiter proxy has dex tag");
    t.notOk(output.includes("helius"), "helius proxy should be filtered out");
    t.end();
  });

  await t.test("shows no services found message", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        data: [],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(mock.restore);

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
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        data: [validProxy],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(mock.restore);

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

  await t.test("outputs YAML when format is yaml", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        data: [validProxy],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(mock.restore);

    const output = await captureStdout(() =>
      discover.handler({
        query: undefined,
        tag: undefined,
        format: "yaml",
      }),
    );
    t.ok(output.includes("name: helius"));
    t.ok(output.includes("default_price: 10000"));
    t.end();
  });

  await t.test("search JSON includes endpoints", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: { proxies: [validProxy], endpoints: [searchEndpoint] },
    }));
    t.teardown(mock.restore);

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

  await t.test("search YAML includes endpoints", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: { proxies: [validProxy], endpoints: [searchEndpoint] },
    }));
    t.teardown(mock.restore);

    const output = await captureStdout(() =>
      discover.handler({
        query: "test",
        tag: undefined,
        format: "yaml",
      }),
    );
    t.ok(output.includes("proxies:"));
    t.ok(output.includes("endpoints:"));
    t.ok(output.includes("proxy_name: helius"));
    t.end();
  });
});

await t.test("inspect command", async (t) => {
  function inspectMock(endpoints: unknown[] = []) {
    return mockFetch((url) => {
      if (url.includes("/endpoints")) {
        return {
          status: 200,
          body: {
            data: endpoints,
            pagination: { nextCursor: null, hasMore: false },
          },
        };
      }
      return {
        status: 200,
        body: {
          data: { ...validProxy, endpoint_count: endpoints.length },
        },
      };
    });
  }

  const sampleEndpoint = {
    id: 10,
    path_pattern: "/v1/tokens/*",
    tags: [],
    price: null,
    scheme: null,
  };

  await t.test("shows proxy details and endpoints in table", async (t) => {
    const mock = inspectMock([sampleEndpoint]);
    t.teardown(mock.restore);

    const output = await captureStdout(() =>
      inspect.handler({ proxyId: 1, openapi: false, format: undefined }),
    );
    t.ok(output.includes("helius (ID: 1)"));
    t.ok(output.includes("$0.010000"));
    t.ok(output.includes("Endpoints: 1"));
    t.ok(output.includes("/v1/tokens/*"));
    t.ok(output.includes("(default)"), "null price should show (default)");
    t.end();
  });

  await t.test("outputs JSON for inspect", async (t) => {
    const mock = inspectMock([sampleEndpoint]);
    t.teardown(mock.restore);

    const output = await captureStdout(() =>
      inspect.handler({ proxyId: 1, openapi: false, format: "json" }),
    );
    const parsed = JSON.parse(output);
    t.equal(parsed.proxy.name, "helius");
    t.ok(Array.isArray(parsed.endpoints));
    t.equal(parsed.endpoints.length, 1);
    t.equal(parsed.endpoints[0].path_pattern, "/v1/tokens/*");
    t.end();
  });

  await t.test("outputs YAML for inspect", async (t) => {
    const mock = inspectMock([sampleEndpoint]);
    t.teardown(mock.restore);

    const output = await captureStdout(() =>
      inspect.handler({ proxyId: 1, openapi: false, format: "yaml" }),
    );
    t.ok(output.includes("name: helius"));
    t.ok(output.includes("path_pattern: /v1/tokens/*"));
    t.end();
  });

  await t.test("openapi flag dumps spec as yaml by default", async (t) => {
    const mock = mockFetch((url) => {
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
    t.teardown(mock.restore);

    const output = await captureStdout(() =>
      inspect.handler({ proxyId: 1, openapi: true, format: undefined }),
    );
    t.ok(output.includes("openapi:"));
    t.ok(output.includes("/v1/test"));
    t.end();
  });

  await t.test("openapi flag with json format", async (t) => {
    const mock = mockFetch((url) => {
      if (url.includes("/openapi")) {
        return {
          status: 200,
          body: {
            data: { id: 1, name: "helius", spec: { openapi: "3.0.0" } },
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
    t.teardown(mock.restore);

    const output = await captureStdout(() =>
      inspect.handler({ proxyId: 1, openapi: true, format: "json" }),
    );
    const parsed = JSON.parse(output);
    t.equal(parsed.openapi, "3.0.0");
    t.end();
  });
});
