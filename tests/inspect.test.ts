#!/usr/bin/env pnpm tsx

import t from "tap";
import {
  captureStdout,
  mockFetch,
  validProxy,
  withTempConfigHome,
} from "./test-helpers.js";

const { inspect } = await import("../src/commands/inspect.js");

function parseJSON(value: string): unknown {
  return JSON.parse(value) as unknown;
}

await t.test("inspect command", async (t) => {
  withTempConfigHome(t);

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
    const parsed = parseJSON(output) as {
      proxy: { name: string };
      endpoints: { path_pattern: string }[];
    };
    t.equal(parsed.proxy.name, "helius");
    t.ok(Array.isArray(parsed.endpoints));
    t.equal(parsed.endpoints.length, 1);
    t.equal(parsed.endpoints.at(0)?.path_pattern, "/v1/tokens/*");
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

  await t.test("defaults to JSON when NO_DNA is set", async (t) => {
    const mock = inspectMock([sampleEndpoint]);
    t.teardown(mock.restore);

    process.env.NO_DNA = "1";
    t.teardown(() => {
      delete process.env.NO_DNA;
    });

    const output = await captureStdout(() =>
      inspect.handler({ proxyId: 1, openapi: false, format: undefined }),
    );
    const parsed = parseJSON(output) as {
      proxy: { name: string };
      endpoints: { path_pattern: string }[];
    };
    t.equal(parsed.proxy.name, "helius");
    t.equal(parsed.endpoints.at(0)?.path_pattern, "/v1/tokens/*");
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

  await t.test(
    "openapi flag does not fetch proxy metadata or endpoints",
    async (t) => {
      const mock = mockFetch((url) => {
        if (url.includes("/openapi")) {
          return {
            status: 200,
            body: {
              data: { id: 1, name: "helius", spec: { openapi: "3.0.0" } },
            },
          };
        }

        return {
          status: 500,
          body: { error: "unexpected request" },
        };
      });
      t.teardown(mock.restore);

      const output = await captureStdout(() =>
        inspect.handler({ proxyId: 1, openapi: true, format: "json" }),
      );
      const parsed = parseJSON(output) as { openapi: string };
      t.equal(parsed.openapi, "3.0.0");
      t.equal(mock.calls.length, 1);
      t.match(mock.calls.at(0), /\/openapi$/);
      t.end();
    },
  );

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

      return {
        status: 500,
        body: { error: "unexpected request" },
      };
    });
    t.teardown(mock.restore);

    const output = await captureStdout(() =>
      inspect.handler({ proxyId: 1, openapi: true, format: "json" }),
    );
    t.same(JSON.parse(output), { openapi: "3.0.0" });
    t.end();
  });
});
