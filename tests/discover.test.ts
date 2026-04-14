#!/usr/bin/env pnpm tsx

import t from "tap";
import {
  captureStdout,
  mockFetch,
  searchEndpoint,
  validProxy,
  validProxy2,
  withTempConfigHome,
  writeConfig,
} from "./test-helpers.js";

const { discover } = await import("../src/commands/discover.js");

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

await t.test("discover command", async (t) => {
  withTempConfigHome(t);

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
    const parsed = parseJson(output) as { name: string }[];
    t.ok(Array.isArray(parsed));
    t.equal(parsed.at(0)?.name, "helius");
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
    const parsed = parseJson(output) as {
      proxies: unknown[];
      endpoints: unknown[];
    };
    t.ok(parsed.proxies);
    t.ok(parsed.endpoints);
    t.equal(parsed.endpoints.length, 1);
    t.end();
  });

  await t.test("defaults to JSON when NO_DNA is set", async (t) => {
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        data: [validProxy],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(mock.restore);

    process.env.NO_DNA = "1";
    t.teardown(() => {
      delete process.env.NO_DNA;
    });

    const output = await captureStdout(() =>
      discover.handler({ query: undefined, tag: undefined, format: undefined }),
    );
    const parsed = parseJson(output) as { name: string }[];
    t.ok(Array.isArray(parsed));
    t.equal(parsed.at(0)?.name, "helius");
    t.end();
  });

  await t.test(
    "uses configured default format when flag is omitted",
    async (t) => {
      const configHome = withTempConfigHome(t);
      await writeConfig(
        configHome,
        `version = 1

[preferences]
format = "yaml"
api_url = "https://api.corbits.dev"

[payment]
network = "mainnet-beta"

[wallets.solana]
address = "7xKX..."
kind = "keypair"
path = "~/.config/corbits/keys/solana.key"
`,
      );
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
          format: undefined,
        }),
      );
      t.match(output, /name: helius/);
      t.end();
    },
  );

  await t.test("uses configured api url for requests", async (t) => {
    const configHome = withTempConfigHome(t);
    await writeConfig(
      configHome,
      `version = 1

[preferences]
format = "table"
api_url = "https://staging.corbits.dev"

[payment]
network = "mainnet-beta"

[wallets.solana]
address = "7xKX..."
kind = "keypair"
path = "~/.config/corbits/keys/solana.key"
`,
    );
    const mock = mockFetch(() => ({
      status: 200,
      body: {
        data: [validProxy],
        pagination: { nextCursor: null, hasMore: false },
      },
    }));
    t.teardown(mock.restore);

    await captureStdout(() =>
      discover.handler({ query: undefined, tag: undefined, format: undefined }),
    );
    t.match(
      mock.calls.at(0),
      /^https:\/\/staging\.corbits\.dev\/api\/v1\/proxies/,
    );
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
