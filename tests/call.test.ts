#!/usr/bin/env pnpm tsx

import t from "tap";
import {
  buildRequestInit,
  createCallCommand,
  parseHeaders,
} from "../src/commands/call.js";
import { resolveOutputFormat } from "../src/flags.js";
import { captureStderr, captureStdout } from "./test-helpers.js";

const resolvedConfig = {
  version: 1,
  preferences: {
    format: "table",
    apiUrl: "https://api.corbits.dev",
  },
  payment: {
    network: "devnet",
    family: "solana",
    address: "So11111111111111111111111111111111111111112",
    asset: "USDC",
    rpcUrl: "https://api.devnet.solana.com",
  },
  activeWallet: {
    kind: "keypair",
    family: "solana",
    address: "So11111111111111111111111111111111111111112",
    path: "~/.config/solana/id.json",
    expandedPath: "/tmp/solana-id.json",
  },
} as const;

function createLoadedConfig() {
  return {
    path: "/tmp/config.toml",
    config: {} as never,
    resolved: resolvedConfig,
  };
}

await t.test("call helpers", async (t) => {
  await t.test("parseHeaders accepts repeated key/value headers", async (t) => {
    t.same(parseHeaders(["Accept: application/json", "X-Test: value"]), {
      Accept: "application/json",
      "X-Test": "value",
    });
  });

  await t.test("parseHeaders rejects malformed headers", async (t) => {
    t.throws(
      () => parseHeaders(["missing-separator"]),
      /Invalid header "missing-separator"/,
    );
  });

  await t.test("buildRequestInit defaults to GET", async (t) => {
    const result = buildRequestInit({
      method: undefined,
      header: ["Content-Type: application/json"],
      body: '{"ok":true}',
    });

    t.equal(result.init.method, "GET");
    t.same(result.headers, { "Content-Type": "application/json" });
    t.equal(result.init.body, '{"ok":true}');
  });

  await t.test(
    "buildRequestInit infers JSON content type for JSON bodies",
    async (t) => {
      const result = buildRequestInit({
        method: "post",
        header: [],
        body: '{"ok":true}',
      });

      t.equal(result.init.method, "POST");
      t.same(result.headers, { "Content-Type": "application/json" });
      t.equal(result.init.body, '{"ok":true}');
    },
  );

  await t.test(
    "buildRequestInit preserves explicit content type for JSON bodies",
    async (t) => {
      const result = buildRequestInit({
        method: "post",
        header: ["content-type: application/merge-patch+json"],
        body: '{"ok":true}',
      });

      t.same(result.headers, {
        "content-type": "application/merge-patch+json",
      });
    },
  );
});

await t.test("call command", async (t) => {
  await t.test(
    "passes explicit method and headers to payer.fetch",
    async (t) => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      const call = createCallCommand({
        resolveOutputFormat: async () => "table",
        loadRequiredConfig: async () => createLoadedConfig() as never,
        buildPayer: async () =>
          ({
            fetch: async (url: string, init?: RequestInit) => {
              calls.push({ url, init });
              return new Response("ok", { status: 200, statusText: "OK" });
            },
          }) as never,
      });

      await captureStdout(() =>
        call.handler({
          url: "https://example.com",
          method: "post",
          header: ["Content-Type: application/json", "X-Test: one"],
          body: '{"hello":"world"}',
          format: undefined,
        }),
      );

      t.equal(calls[0]?.url, "https://example.com");
      t.equal(calls[0]?.init?.method, "POST");
      t.equal(
        (calls[0]?.init?.headers as Record<string, string>)["X-Test"],
        "one",
      );
      t.equal(calls[0]?.init?.body, '{"hello":"world"}');
    },
  );

  await t.test("adds JSON content type when user omits it", async (t) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const call = createCallCommand({
      resolveOutputFormat: async () => "table",
      loadRequiredConfig: async () => createLoadedConfig() as never,
      buildPayer: async () =>
        ({
          fetch: async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            return new Response("ok", { status: 200, statusText: "OK" });
          },
        }) as never,
    });

    await captureStdout(() =>
      call.handler({
        url: "https://example.com",
        method: "post",
        header: [],
        body: '{"hello":"world"}',
        format: undefined,
      }),
    );

    t.equal(
      (calls[0]?.init?.headers as Record<string, string>)["Content-Type"],
      "application/json",
    );
  });

  await t.test("prints table output for successful responses", async (t) => {
    const call = createCallCommand({
      resolveOutputFormat: async () => "table",
      loadRequiredConfig: async () => createLoadedConfig() as never,
      buildPayer: async () =>
        ({
          fetch: async () =>
            new Response("hello world", { status: 200, statusText: "OK" }),
        }) as never,
    });

    const output = await captureStdout(() =>
      call.handler({
        url: "https://example.com",
        method: undefined,
        header: [],
        body: undefined,
        format: undefined,
      }),
    );

    t.match(output, /HTTP\/1.1 200 OK/);
    t.match(output, /hello world/);
  });

  await t.test("prints parsed JSON for json format", async (t) => {
    const call = createCallCommand({
      resolveOutputFormat: async () => "json",
      loadRequiredConfig: async () => createLoadedConfig() as never,
      buildPayer: async () =>
        ({
          fetch: async () =>
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
            }),
        }) as never,
    });

    const output = await captureStdout(() =>
      call.handler({
        url: "https://example.com",
        method: undefined,
        header: [],
        body: undefined,
        format: "json",
      }),
    );

    t.same(JSON.parse(output), { ok: true });
  });

  await t.test("wraps text responses for yaml format", async (t) => {
    const call = createCallCommand({
      resolveOutputFormat: async () => "yaml",
      loadRequiredConfig: async () => createLoadedConfig() as never,
      buildPayer: async () =>
        ({
          fetch: async () =>
            new Response("plain text", {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "text/plain" },
            }),
        }) as never,
    });

    const output = await captureStdout(() =>
      call.handler({
        url: "https://example.com",
        method: undefined,
        header: [],
        body: undefined,
        format: "yaml",
      }),
    );

    t.match(output, /status: 200/);
    t.match(output, /body: plain text/);
  });

  await t.test(
    "prints non-2xx responses to stderr and sets exit code",
    async (t) => {
      const priorExitCode = process.exitCode;
      process.exitCode = undefined;
      t.teardown(() => {
        process.exitCode = priorExitCode;
      });

      const call = createCallCommand({
        resolveOutputFormat: async () => "table",
        loadRequiredConfig: async () => createLoadedConfig() as never,
        buildPayer: async () =>
          ({
            fetch: async () =>
              new Response("payment failed upstream", {
                status: 403,
                statusText: "Forbidden",
              }),
          }) as never,
      });

      const stderr = await captureStderr(() =>
        call.handler({
          url: "https://example.com",
          method: undefined,
          header: [],
          body: undefined,
          format: undefined,
        }),
      );

      t.match(stderr, /HTTP\/1.1 403 Forbidden/);
      t.match(stderr, /payment failed upstream/);
      t.equal(process.exitCode, 1);
    },
  );

  await t.test("defaults to JSON when NO_DNA is set", async (t) => {
    process.env.NO_DNA = "1";
    t.teardown(() => {
      delete process.env.NO_DNA;
    });

    const call = createCallCommand({
      resolveOutputFormat,
      loadRequiredConfig: async () => createLoadedConfig() as never,
      buildPayer: async () =>
        ({
          fetch: async () =>
            new Response(JSON.stringify({ mode: "json" }), {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
            }),
        }) as never,
    });

    const output = await captureStdout(() =>
      call.handler({
        url: "https://example.com",
        method: undefined,
        header: [],
        body: undefined,
        format: undefined,
      }),
    );

    t.same(JSON.parse(output), { mode: "json" });
  });
});
