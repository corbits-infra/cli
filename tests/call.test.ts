#!/usr/bin/env pnpm tsx

import t from "tap";
import { createCallCommand } from "../src/commands/call.js";
import {
  createRunWrappedClient,
  testExports,
} from "../src/commands/call-wrapper.js";
import type { WrappedRunResult } from "../src/commands/call-wrapper.js";
import type { LoadedConfig } from "../src/config/index.js";
import type { RetryHeader } from "../src/payment/header.js";
import {
  captureStderr,
  captureStdout,
  captureStdoutBytes,
} from "./test-helpers.js";

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

function createLoadedConfig(): LoadedConfig {
  return {
    path: "/tmp/config.toml",
    config: {
      version: 1,
      preferences: {
        format: "table",
        api_url: "https://api.corbits.dev",
      },
      payment: {
        network: "devnet",
      },
      wallets: {
        solana: {
          kind: "keypair",
          address: "So11111111111111111111111111111111111111112",
          path: "~/.config/solana/id.json",
        },
      },
    },
    resolved: resolvedConfig,
  };
}

function createCompletedResult(args: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): Extract<WrappedRunResult, { kind: "completed" }> {
  return {
    kind: "completed",
    exitCode: args.exitCode,
    stdout: Buffer.from(args.stdout),
    stderr: Buffer.from(args.stderr),
  };
}

function createPaymentRequiredResult(args: {
  tool: "curl" | "wget";
  url: string;
  requestInit: RequestInit;
  response: Response;
}): Extract<WrappedRunResult, { kind: "payment-required" }> {
  return {
    kind: "payment-required",
    tool: args.tool,
    url: args.url,
    requestInit: args.requestInit,
    response: args.response,
  };
}

function createPaymentRejectedResult(
  reason: string,
): Extract<WrappedRunResult, { kind: "payment-rejected" }> {
  return {
    kind: "payment-rejected",
    reason,
  };
}

await t.test("call wrapper helpers", async (t) => {
  await t.test("parses request info from passthrough args", async (t) => {
    t.same(
      testExports.parseWrappedRequestInfo("curl", [
        "--url",
        "https://example.com/items",
        "-d",
        '{"ok":true}',
      ]),
      {
        url: "https://example.com/items",
        requestInit: {
          method: "POST",
          body: '{"ok":true}',
        },
      },
    );
    t.same(
      testExports.parseWrappedRequestInfo("curl", [
        "https://example.com/items",
        "--next",
        "https://example.com/other",
      ]),
      {
        url: "https://example.com/items",
        requestInit: {
          method: "GET",
        },
      },
    );
  });

  await t.test("parses final curl header block after redirects", async (t) => {
    const parsed = testExports.parseCurlHeaders(
      [
        "HTTP/1.1 301 Moved Permanently",
        "Location: https://example.com/final",
        "",
        "HTTP/2 402 Payment Required",
        "X-PAYMENT-REQUIRED: abc123",
        "Content-Type: application/json",
        "",
      ].join("\r\n"),
    );

    t.equal(parsed.status, 402);
    t.equal(parsed.headers.get("x-payment-required"), "abc123");
    t.equal(parsed.headers.get("content-type"), "application/json");
  });

  await t.test("parses final wget server response block", async (t) => {
    const parsed = testExports.parseWgetHeaders(`
      HTTP/1.1 301 Moved Permanently
      Location: https://example.com/final
      HTTP/1.1 402 Payment Required
      X-PAYMENT-REQUIRED: abc123
      Content-Type: application/json
    `);

    t.equal(parsed.status, 402);
    t.equal(parsed.headers.get("x-payment-required"), "abc123");
    t.equal(parsed.headers.get("content-type"), "application/json");
  });

  await t.test("parses verification failure bodies", async (t) => {
    t.equal(
      testExports.parseVerificationFailure(
        '{"error":"verification_failed","message":"wrong network"}',
      ),
      "wrong network",
    );
    t.equal(
      testExports.parseVerificationFailure('{"error":"payment_required"}'),
      null,
    );
  });

  await t.test("detects incompatible curl include-header flags", async (t) => {
    t.equal(testExports.hasCurlIncludeHeadersFlag(["-i"]), true);
    t.equal(
      testExports.hasCurlIncludeHeadersFlag([
        "--include",
        "https://example.com",
      ]),
      true,
    );
    t.equal(
      testExports.hasCurlIncludeHeadersFlag(["https://example.com"]),
      false,
    );
  });
});

await t.test("wrapped client runner", async (t) => {
  await t.test("rejects unsupported wrapped commands", async (t) => {
    const runWrappedClient = createRunWrappedClient({
      execFile: async () => ({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      }),
      mkdtemp: async () => "/tmp/corbits",
      readBinaryFile: async () => new Uint8Array(),
      readTextFile: async () => "",
      writeFile: async () => undefined,
      rm: async () => undefined,
    });

    await t.rejects(
      runWrappedClient({ tool: "fetch", args: ["https://example.com"] }),
      /unsupported wrapped command "fetch"/,
    );
  });

  await t.test("injects curl retry headers on second pass", async (t) => {
    const calls: { file: string; args: string[] }[] = [];
    const runWrappedClient = createRunWrappedClient({
      execFile: async (file, args) => {
        calls.push({ file, args });
        if (file === "which") {
          return {
            stdout: Buffer.from(`/usr/bin/${args[0]}\n`),
            stderr: Buffer.from(""),
          };
        }
        return { stdout: Buffer.from(""), stderr: Buffer.from("") };
      },
      mkdtemp: async () => "/tmp/corbits",
      readBinaryFile: async () => new Uint8Array(),
      readTextFile: async (file) => {
        if (typeof file === "string" && file.endsWith("headers.txt")) {
          return [
            "HTTP/1.1 402 Payment Required",
            "X-PAYMENT-REQUIRED: abc123",
            "",
          ].join("\r\n");
        }
        return '{"error":"payment_required"}';
      },
      writeFile: async () => undefined,
      rm: async () => undefined,
    });

    await runWrappedClient({
      tool: "curl",
      args: ["https://example.com"],
      extraHeader: { name: "X-PAYMENT", value: "paid-header" },
    });

    t.same(calls[1]?.file, "curl");
    t.match(calls[1]?.args ?? [], [
      "https://example.com",
      "-H",
      "X-PAYMENT: paid-header",
    ]);
  });

  await t.test("preserves repeated curl headers on retry", async (t) => {
    const calls: { file: string; args: string[] }[] = [];
    const runWrappedClient = createRunWrappedClient({
      execFile: async (file, args) => {
        calls.push({ file, args });
        if (file === "which") {
          return {
            stdout: Buffer.from(`/usr/bin/${args[0]}\n`),
            stderr: Buffer.from(""),
          };
        }
        return { stdout: Buffer.from(""), stderr: Buffer.from("") };
      },
      mkdtemp: async () => "/tmp/corbits",
      readBinaryFile: async () => new Uint8Array(),
      readTextFile: async (file) => {
        if (typeof file === "string" && file.endsWith("headers.txt")) {
          return [
            "HTTP/1.1 402 Payment Required",
            "X-PAYMENT-REQUIRED: abc123",
            "",
          ].join("\r\n");
        }
        return '{"error":"payment_required"}';
      },
      writeFile: async () => undefined,
      rm: async () => undefined,
    });

    await runWrappedClient({
      tool: "curl",
      args: ["https://example.com", "-H", "Cookie: a=1", "-H", "Cookie: b=2"],
      extraHeader: { name: "X-PAYMENT", value: "paid-header" },
    });

    t.match(calls[1]?.args ?? [], [
      "https://example.com",
      "-H",
      "Cookie: a=1",
      "-H",
      "Cookie: b=2",
      "-H",
      "X-PAYMENT: paid-header",
    ]);
  });

  await t.test("rejects curl include-header passthrough flags", async (t) => {
    const runWrappedClient = createRunWrappedClient({
      execFile: async () => ({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      }),
      mkdtemp: async () => "/tmp/corbits",
      readBinaryFile: async () => new Uint8Array(),
      readTextFile: async () => "",
      writeFile: async () => undefined,
      rm: async () => undefined,
    });

    await t.rejects(
      runWrappedClient({
        tool: "curl",
        args: ["-i", "https://example.com"],
      }),
      /-i\/--include/,
    );
  });

  await t.test("returns completed output for non-402 wget runs", async (t) => {
    const runWrappedClient = createRunWrappedClient({
      execFile: async (file, args) => {
        if (file === "which") {
          return {
            stdout: Buffer.from(`/usr/bin/${args[0]}\n`),
            stderr: Buffer.from(""),
          };
        }
        return {
          stdout: Buffer.from("downloaded body"),
          stderr: Buffer.from("HTTP/1.1 200 OK\nContent-Length: 14\n"),
        };
      },
      mkdtemp: async () => "/tmp/corbits",
      readBinaryFile: async () => new Uint8Array(),
      readTextFile: async () => "",
      writeFile: async () => undefined,
      rm: async () => undefined,
    });

    const result = await runWrappedClient({
      tool: "wget",
      args: ["https://example.com"],
    });

    t.same(result, {
      kind: "completed",
      exitCode: 0,
      stdout: Buffer.from("downloaded body"),
      stderr: Buffer.from("HTTP/1.1 200 OK\nContent-Length: 14\n"),
    });
  });

  await t.test(
    "preserves curl output file flags for successful responses",
    async (t) => {
      const writes: { path: string; data: string }[] = [];
      const runWrappedClient = createRunWrappedClient({
        execFile: async (file, args) => {
          if (file === "which") {
            return {
              stdout: Buffer.from(`/usr/bin/${args[0]}\n`),
              stderr: Buffer.from(""),
            };
          }
          return { stdout: Buffer.from(""), stderr: Buffer.from("") };
        },
        mkdtemp: async () => "/tmp/corbits",
        readTextFile: async (file) => {
          if (typeof file === "string" && file.endsWith("headers.txt")) {
            return "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n";
          }
          return "";
        },
        readBinaryFile: async () => Buffer.from('{"ok":true}'),
        writeFile: async (path, data) => {
          writes.push({
            path,
            data:
              typeof data === "string" ? data : Buffer.from(data).toString(),
          });
        },
        rm: async () => undefined,
      });

      const result = await runWrappedClient({
        tool: "curl",
        args: [
          "-o",
          "/tmp/output.json",
          "--dump-header=/tmp/headers.txt",
          "https://example.com",
        ],
      });

      t.same(result, {
        kind: "completed",
        exitCode: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      });
      t.same(writes, [
        {
          path: "/tmp/headers.txt",
          data: "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n",
        },
        {
          path: "/tmp/output.json",
          data: '{"ok":true}',
        },
      ]);
    },
  );

  await t.test(
    "streams binary curl output without UTF-8 decoding",
    async (t) => {
      const runWrappedClient = createRunWrappedClient({
        execFile: async (file, args) => {
          if (file === "which") {
            return {
              stdout: Buffer.from(`/usr/bin/${args[0]}\n`),
              stderr: Buffer.from(""),
            };
          }
          return { stdout: Buffer.from(""), stderr: Buffer.from("") };
        },
        mkdtemp: async () => "/tmp/corbits",
        readTextFile: async (file) => {
          if (typeof file === "string" && file.endsWith("headers.txt")) {
            return "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n";
          }
          return "";
        },
        readBinaryFile: async () => Uint8Array.from([0x00, 0xff, 0x80, 0x41]),
        writeFile: async () => undefined,
        rm: async () => undefined,
      });

      const result = await runWrappedClient({
        tool: "curl",
        args: ["https://example.com"],
      });

      t.equal(result.kind, "completed");
      if (result.kind === "completed") {
        t.same([...result.stdout], [0x00, 0xff, 0x80, 0x41]);
      }
    },
  );

  await t.test(
    "preserves wget 402 challenge bodies for retry handling",
    async (t) => {
      const challengeBody = JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: "exact" }],
      });
      const runWrappedClient = createRunWrappedClient({
        execFile: async (file, args) => {
          if (file === "which") {
            return {
              stdout: Buffer.from(`/usr/bin/${args[0]}\n`),
              stderr: Buffer.from(""),
            };
          }
          return {
            stdout: Buffer.from(challengeBody),
            stderr: Buffer.from(
              "HTTP/1.1 402 Payment Required\nContent-Type: application/json\n",
            ),
          };
        },
        mkdtemp: async () => "/tmp/corbits",
        readBinaryFile: async () => new Uint8Array(),
        readTextFile: async () => "",
        writeFile: async () => undefined,
        rm: async () => undefined,
      });

      const result = await runWrappedClient({
        tool: "wget",
        args: ["https://example.com"],
      });

      t.equal(result.kind, "payment-required");
      if (result.kind === "payment-required") {
        t.equal(await result.response.text(), challengeBody);
        t.same(result.requestInit, { method: "GET" });
      }
    },
  );
});

await t.test("call command", async (t) => {
  await t.test(
    "forwards successful wrapped output and exit code",
    async (t) => {
      const priorExitCode = process.exitCode;
      process.exitCode = undefined;
      t.teardown(() => {
        process.exitCode = priorExitCode;
      });

      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => {
          throw new Error("should not build payment header");
        },
        runWrappedClient: async () =>
          createCompletedResult({
            exitCode: 22,
            stdout: "body",
            stderr: "stderr",
          }),
      });

      const stdout = await captureStdout(() =>
        call.handler({
          tool: "curl",
          args: ["https://example.com"],
        }),
      );
      const stderr = await captureStderr(() =>
        call.handler({
          tool: "curl",
          args: ["https://example.com"],
        }),
      );

      t.equal(stdout, "body");
      t.equal(stderr, "stderr");
      t.equal(process.exitCode, 22);
    },
  );

  await t.test(
    "retries 402 requests with generated payment header",
    async (t) => {
      const invocations: unknown[] = [];
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async (): Promise<RetryHeader> => ({
          name: "X-PAYMENT",
          value: "paid",
        }),
        runWrappedClient: async (args) => {
          invocations.push(args);
          if (invocations.length === 1) {
            return createPaymentRequiredResult({
              tool: "curl",
              url: "https://example.com",
              requestInit: {
                method: "POST",
                body: '{"x":1}',
              },
              response: new Response(
                JSON.stringify({
                  x402Version: 1,
                  accepts: [],
                }),
                {
                  status: 402,
                  headers: {
                    "content-type": "application/json",
                  },
                },
              ),
            });
          }

          return createCompletedResult({
            exitCode: 0,
            stdout: "paid response",
            stderr: "",
          });
        },
      });

      const stdout = await captureStdout(() =>
        call.handler({
          tool: "curl",
          args: ["https://example.com"],
        }),
      );

      t.equal(stdout, "paid response");
      t.same(invocations[1], {
        tool: "curl",
        args: ["https://example.com"],
        extraHeader: { name: "X-PAYMENT", value: "paid" },
      });
    },
  );

  await t.test(
    "writes completed stdout bytes without text conversion",
    async (t) => {
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => {
          throw new Error("should not build payment header");
        },
        runWrappedClient: async () => ({
          kind: "completed",
          exitCode: 0,
          stdout: Uint8Array.from([0x00, 0xff, 0x80, 0x41]),
          stderr: new Uint8Array(),
        }),
      });

      const stdout = await captureStdoutBytes(() =>
        call.handler({
          tool: "curl",
          args: ["https://example.com"],
        }),
      );

      t.same([...stdout], [0x00, 0xff, 0x80, 0x41]);
    },
  );

  await t.test("surfaces payment rejection errors", async (t) => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    t.teardown(() => {
      process.exitCode = priorExitCode;
    });

    const call = createCallCommand({
      loadRequiredConfig: async () => createLoadedConfig(),
      buildPaymentRetryHeader: async (): Promise<RetryHeader> => ({
        name: "X-PAYMENT",
        value: "paid",
      }),
      runWrappedClient: async () =>
        createPaymentRejectedResult("wrong network"),
    });

    const stderr = await captureStderr(() =>
      call.handler({
        tool: "curl",
        args: ["https://example.com"],
      }),
    );

    t.match(stderr, /wrong network/);
    t.equal(process.exitCode, 1);
  });

  await t.test("reports a second 402 after retry", async (t) => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    t.teardown(() => {
      process.exitCode = priorExitCode;
    });

    const call = createCallCommand({
      loadRequiredConfig: async () => createLoadedConfig(),
      buildPaymentRetryHeader: async (): Promise<RetryHeader> => ({
        name: "X-PAYMENT",
        value: "paid",
      }),
      runWrappedClient: async () =>
        createPaymentRequiredResult({
          tool: "curl",
          url: "https://example.com",
          requestInit: {
            method: "GET",
          },
          response: new Response("", { status: 402 }),
        }),
    });

    const stderr = await captureStderr(() =>
      call.handler({
        tool: "curl",
        args: ["https://example.com"],
      }),
    );

    t.match(stderr, /still returned 402 after payment/);
    t.equal(process.exitCode, 1);
  });
});
