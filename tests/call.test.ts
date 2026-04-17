#!/usr/bin/env pnpm tsx

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import t from "tap";
import { createCallCommand } from "../src/commands/call.js";
import {
  createRunWrappedClient,
  testExports,
} from "../src/commands/call-wrapper.js";
import type { WrappedRunResult } from "../src/commands/call-wrapper.js";
import type { LoadedConfig } from "../src/config/index.js";
import type { PreflightBalanceDeps } from "../src/payment/balance.js";
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
  headers?: Record<string, string>;
}): Extract<WrappedRunResult, { kind: "completed" }> {
  return {
    kind: "completed",
    exitCode: args.exitCode,
    stdout: Buffer.from(args.stdout),
    stderr: Buffer.from(args.stderr),
    headers: new Headers(args.headers),
  };
}

function createStreamedCompletedResult(args: {
  exitCode: number;
  headers?: Record<string, string>;
}): Extract<WrappedRunResult, { kind: "streamed-completed" }> {
  return {
    kind: "streamed-completed",
    exitCode: args.exitCode,
    headers: new Headers(args.headers),
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

function createSpawnStub(args: {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  exitCode?: number;
  onSpawn?: (file: string, spawnedArgs: string[]) => void;
}) {
  return ((file: string, spawnedArgs: readonly string[]) => {
    args.onSpawn?.(file, [...spawnedArgs]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    queueMicrotask(() => {
      if (args.stdout != null) {
        child.stdout.write(args.stdout);
      }
      child.stdout.end();

      if (args.stderr != null) {
        child.stderr.write(args.stderr);
      }
      child.stderr.end();

      child.emit("close", args.exitCode ?? 0, null);
    });

    return child as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  }) as typeof import("node:child_process").spawn;
}

function createWrapperDeps(
  tempDir: string,
  args: {
    execFile?: (
      file: string,
      spawnedArgs: string[],
    ) => Promise<{ stdout: Uint8Array; stderr: Uint8Array }>;
    spawn?: typeof import("node:child_process").spawn;
    writeFile?: (
      filePath: string,
      data: string | Uint8Array,
      encoding?: BufferEncoding,
    ) => Promise<void>;
    readBinaryFile?: (filePath: string) => Promise<Uint8Array>;
    readTextFile?: (
      filePath: string,
      encoding: BufferEncoding,
    ) => Promise<string>;
  } = {},
) {
  return {
    execFile:
      args.execFile ??
      (async (file: string, spawnedArgs: string[]) => {
        if (file !== "which") {
          throw new Error(`unexpected execFile call for ${file}`);
        }
        return {
          stdout: Buffer.from(`/usr/bin/${spawnedArgs[0]}\n`),
          stderr: Buffer.from(""),
        };
      }),
    mkdtemp: async () => {
      const dir = path.join(
        tempDir,
        `corbits-${Math.random().toString(16).slice(2)}`,
      );
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    readBinaryFile: args.readBinaryFile ?? fs.readFile,
    readTextFile: args.readTextFile ?? fs.readFile,
    writeFile: args.writeFile ?? fs.writeFile,
    rm: fs.rm,
    ...(args.spawn == null ? {} : { spawn: args.spawn }),
  };
}

await t.test("call wrapper helpers", async (t) => {
  await t.test(
    "extracts the first wrapped URL from passthrough args",
    async (t) => {
      t.equal(
        testExports.extractFirstUrl([
          "--url",
          "https://example.com/items",
          "-d",
          '{"ok":true}',
        ]),
        "https://example.com/items",
      );
      t.equal(
        testExports.extractFirstUrl([
          "https://example.com/items",
          "https://example.com/other",
        ]),
        "https://example.com/items",
      );
      t.equal(
        testExports.extractFirstUrl([
          "--method=post",
          "https://example.com/items",
        ]),
        "https://example.com/items",
      );
    },
  );

  await t.test(
    "parses request info for wget methods and file-backed curl bodies",
    async (t) => {
      const curlRequest = await testExports.parseWrappedRequestInfo(
        {
          readBinaryFile: async (filePath) => {
            t.equal(filePath, "/tmp/request.json");
            return Buffer.from('{"ok":true}');
          },
        },
        "curl",
        [
          "--request=post",
          "--data-binary",
          "@/tmp/request.json",
          "https://example.com/items",
        ],
      );
      t.equal(curlRequest.url, "https://example.com/items");
      t.equal(curlRequest.requestInit.method, "POST");
      t.same(
        Buffer.from(curlRequest.requestInit.body as Uint8Array).toString(),
        '{"ok":true}',
      );

      const wgetRequest = await testExports.parseWrappedRequestInfo(
        {
          readBinaryFile: async () => Buffer.from("unused"),
        },
        "wget",
        ["--method=post", "--body-data=hello", "https://example.com/items"],
      );
      t.equal(wgetRequest.url, "https://example.com/items");
      t.equal(wgetRequest.requestInit.method, "POST");
      t.equal(wgetRequest.requestInit.body, "hello");
    },
  );

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

  await t.test(
    "detects curl multi-transfer and wget server flags",
    async (t) => {
      t.equal(testExports.hasCurlNextFlag(["--next"]), true);
      t.equal(testExports.hasCurlNextFlag(["https://example.com"]), false);
      t.equal(testExports.hasWgetServerResponseFlag(["-S"]), true);
      t.equal(
        testExports.hasWgetServerResponseFlag(["--server-response"]),
        true,
      );
      t.equal(
        testExports.hasWgetServerResponseFlag(["https://example.com"]),
        false,
      );
    },
  );

  await t.test(
    "strips curl output capture flags before the wrapped execution",
    async (t) => {
      t.same(
        testExports.sanitizeCurlCaptureArgs([
          "-o",
          "/tmp/output.json",
          "--dump-header=/tmp/headers.txt",
          "https://example.com",
        ]),
        {
          args: ["https://example.com"],
          outputTarget: {
            bodyPath: "/tmp/output.json",
            headerPath: "/tmp/headers.txt",
          },
        },
      );
    },
  );
});

await t.test("wrapped client runner", async (t) => {
  await t.test("rejects unsupported wrapped commands", async (t) => {
    const tempDir = t.testdir();
    const runWrappedClient = createRunWrappedClient(createWrapperDeps(tempDir));

    await t.rejects(
      runWrappedClient({ tool: "fetch", args: ["https://example.com"] }),
      /unsupported wrapped command "fetch"/,
    );
  });

  await t.test("injects curl retry headers on second pass", async (t) => {
    const tempDir = t.testdir();
    const calls: { file: string; args: string[] }[] = [];
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        execFile: async (file, args) => {
          calls.push({ file, args });
          return {
            stdout: Buffer.from(`/usr/bin/${args[0]}\n`),
            stderr: Buffer.from(""),
          };
        },
        spawn: createSpawnStub({
          onSpawn: (file, spawnedArgs) => {
            calls.push({ file, args: spawnedArgs });
          },
        }),
      }),
    );

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
    const tempDir = t.testdir();
    const calls: { file: string; args: string[] }[] = [];
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        execFile: async (file, args) => {
          calls.push({ file, args });
          return {
            stdout: Buffer.from(`/usr/bin/${args[0]}\n`),
            stderr: Buffer.from(""),
          };
        },
        spawn: createSpawnStub({
          onSpawn: (file, spawnedArgs) => {
            calls.push({ file, args: spawnedArgs });
          },
        }),
      }),
    );

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
    const tempDir = t.testdir();
    const runWrappedClient = createRunWrappedClient(createWrapperDeps(tempDir));

    await t.rejects(
      runWrappedClient({
        tool: "curl",
        args: ["-i", "https://example.com"],
      }),
      /-i\/--include/,
    );
  });

  await t.test("rejects curl multi-transfer passthrough flags", async (t) => {
    const tempDir = t.testdir();
    const runWrappedClient = createRunWrappedClient(createWrapperDeps(tempDir));

    await t.rejects(
      runWrappedClient({
        tool: "curl",
        args: ["https://example.com/one", "--next", "https://example.com/two"],
      }),
      /--next/,
    );
  });

  await t.test("returns completed output for non-402 wget runs", async (t) => {
    const tempDir = t.testdir();
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        spawn: createSpawnStub({
          stdout: Buffer.from("downloaded body"),
          stderr: Buffer.from("HTTP/1.1 200 OK\nContent-Length: 14\n"),
        }),
      }),
    );

    const result = await runWrappedClient({
      tool: "wget",
      args: ["https://example.com"],
    });

    t.same(result, {
      kind: "completed",
      exitCode: 0,
      stdout: Buffer.from("downloaded body"),
      stderr: Buffer.from("HTTP/1.1 200 OK\nContent-Length: 14\n"),
      headers: new Headers({ "content-length": "14" }),
    });
  });

  await t.test(
    "handles large wget stdout without execFile buffering",
    async (t) => {
      const largeBody = Buffer.alloc(12 * 1024 * 1024, "a");
      const tempDir = t.testdir();
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stdout: largeBody,
            stderr: Buffer.from("HTTP/1.1 200 OK\n"),
          }),
        }),
      );

      const result = await runWrappedClient({
        tool: "wget",
        args: ["https://example.com"],
      });

      t.equal(result.kind, "completed");
      if (result.kind === "completed") {
        t.equal(result.stdout.length, largeBody.length);
      }
    },
  );

  await t.test(
    "injects wget server-response flag for 402 detection",
    async (t) => {
      const tempDir = t.testdir();
      const calls: { file: string; args: string[] }[] = [];
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          execFile: async (file, args) => {
            calls.push({ file, args });
            return {
              stdout: Buffer.from(`/usr/bin/${args[0]}\n`),
              stderr: Buffer.from(""),
            };
          },
          spawn: createSpawnStub({
            stdout: Buffer.from("downloaded body"),
            stderr: Buffer.from(
              "HTTP/1.1 402 Payment Required\nContent-Type: application/json\n",
            ),
            onSpawn: (file, spawnedArgs) => {
              calls.push({ file, args: spawnedArgs });
            },
          }),
        }),
      );

      await runWrappedClient({
        tool: "wget",
        args: ["https://example.com"],
      });

      t.same(calls[1], {
        file: "wget",
        args: ["--server-response", "https://example.com"],
      });
    },
  );

  await t.test("rejects wget multi-url passthrough args", async (t) => {
    const tempDir = t.testdir();
    const runWrappedClient = createRunWrappedClient(createWrapperDeps(tempDir));

    await t.rejects(
      runWrappedClient({
        tool: "wget",
        args: ["https://example.com/one", "https://example.com/two"],
      }),
      /multi-URL/,
    );
  });

  await t.test(
    "preserves curl output file flags for successful responses",
    async (t) => {
      const tempDir = t.testdir();
      const writes: { path: string; data: string }[] = [];
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stdout: Buffer.from('{"ok":true}'),
          }),
          writeFile: async (filePath, data) => {
            writes.push({
              path: filePath,
              data:
                typeof data === "string" ? data : Buffer.from(data).toString(),
            });
          },
        }),
      );

      const result = await runWrappedClient({
        tool: "curl",
        args: [
          "-o",
          "/tmp/output.json",
          "--dump-header=/tmp/headers.txt",
          "https://example.com",
        ],
      });

      t.equal(result.kind, "completed");
      if (result.kind === "completed") {
        t.same(result.headers, new Headers());
      }
      t.same(writes, [
        {
          path: "/tmp/headers.txt",
          data: "",
        },
        {
          path: "/tmp/output.json",
          data: '{"ok":true}',
        },
      ]);
    },
  );

  await t.test(
    "captures 402 curl bodies even when the user passes -o",
    async (t) => {
      const tempDir = t.testdir();
      const calls: { file: string; args: string[] }[] = [];
      const challengeBody = JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: "exact" }],
      });
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          execFile: async (file, args) => {
            calls.push({ file, args });
            return {
              stdout: Buffer.from(`/usr/bin/${args[0]}\n`),
              stderr: Buffer.from(""),
            };
          },
          spawn: createSpawnStub({
            stdout: Buffer.from(challengeBody),
            onSpawn: (file, spawnedArgs) => {
              calls.push({ file, args: spawnedArgs });
            },
          }),
        }),
      );

      const result = await runWrappedClient({
        tool: "curl",
        args: [
          "-o",
          "/tmp/output.json",
          "--dump-header=/tmp/headers.txt",
          "https://example.com",
        ],
      });

      t.equal(result.kind, "completed");
      t.match(calls[1] ?? {}, {
        file: "curl",
        args: [
          "https://example.com",
          "-D",
          /headers\.txt$/,
          "-o",
          /body\.txt$/,
        ],
      });
    },
  );

  await t.test(
    "streams binary curl output without UTF-8 decoding",
    async (t) => {
      const tempDir = t.testdir();
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stdout: Buffer.from([0x00, 0xff, 0x80, 0x41]),
          }),
        }),
      );

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
      const tempDir = t.testdir();
      const challengeBody = JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: "exact" }],
      });
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stdout: Buffer.from(challengeBody),
            stderr: Buffer.from(
              "HTTP/1.1 402 Payment Required\nContent-Type: application/json\n",
            ),
          }),
        }),
      );

      const result = await runWrappedClient({
        tool: "wget",
        args: ["-S", "https://example.com"],
      });

      t.equal(result.kind, "payment-required");
      if (result.kind === "payment-required") {
        t.equal(await result.response.text(), challengeBody);
        t.equal(result.url, "https://example.com");
        t.same(result.requestInit, { method: "GET" });
      }
    },
  );

  await t.test("keeps the challenged wget URL for retry signing", async (t) => {
    const tempDir = t.testdir();
    const challengeBody = JSON.stringify({
      x402Version: 1,
      accepts: [{ scheme: "exact" }],
    });
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        spawn: createSpawnStub({
          stdout: Buffer.from(challengeBody),
          stderr: Buffer.from(
            "HTTP/1.1 402 Payment Required\nContent-Type: application/json\n",
          ),
        }),
      }),
    );

    const result = await runWrappedClient({
      tool: "wget",
      args: ["--method=POST", "-S", "https://example.com"],
    });

    t.equal(result.kind, "payment-required");
    if (result.kind === "payment-required") {
      t.equal(result.url, "https://example.com");
      t.same(result.requestInit, { method: "POST" });
    }
  });

  await t.test("streams retry output for curl without buffering", async (t) => {
    const tempDir = t.testdir();
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        spawn: createSpawnStub({
          stdout: "paid body",
          stderr: "progress",
        }),
      }),
    );

    const stdout = await captureStdout(() =>
      runWrappedClient({
        tool: "curl",
        args: ["https://example.com"],
        extraHeader: { name: "X-PAYMENT", value: "paid" },
        streamOutput: true,
      }).then(() => undefined),
    );
    const stderr = await captureStderr(() =>
      runWrappedClient({
        tool: "curl",
        args: ["https://example.com"],
        extraHeader: { name: "X-PAYMENT", value: "paid" },
        streamOutput: true,
      }).then(() => undefined),
    );

    t.equal(stdout, "paid body");
    t.equal(stderr, "progress");
  });

  await t.test(
    "preserves curl dump-header files on streamed paid retries",
    async (t) => {
      const tempDir = t.testdir();
      const writes: { path: string; data: string }[] = [];
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stdout: "paid body",
          }),
          writeFile: async (filePath, data) => {
            writes.push({
              path: filePath,
              data:
                typeof data === "string" ? data : Buffer.from(data).toString(),
            });
          },
        }),
      );

      const stdout = await captureStdout(() =>
        runWrappedClient({
          tool: "curl",
          args: ["--dump-header=/tmp/headers.txt", "https://example.com"],
          extraHeader: { name: "X-PAYMENT", value: "paid" },
          streamOutput: true,
        }).then(() => undefined),
      );

      t.equal(stdout, "paid body");
      t.same(writes, [{ path: "/tmp/headers.txt", data: "" }]);
    },
  );

  await t.test(
    "replays curl dumped headers to stdout on streamed paid retries",
    async (t) => {
      const tempDir = t.testdir();
      let seenHeaderPath: string | undefined;
      let seenEncoding: BufferEncoding | undefined;
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stdout: "paid body",
          }),
          readTextFile: async (filePath, encoding) => {
            seenHeaderPath = filePath;
            seenEncoding = encoding;
            return "HTTP/1.1 200 OK\r\nX-Test: paid\r\n\r\n";
          },
        }),
      );

      const stdout = await captureStdout(() =>
        runWrappedClient({
          tool: "curl",
          args: ["-D", "-", "https://example.com"],
          extraHeader: { name: "X-PAYMENT", value: "paid" },
          streamOutput: true,
        }).then(() => undefined),
      );

      t.match(seenHeaderPath ?? "", /headers\.txt$/);
      t.equal(seenEncoding, "utf8");
      t.equal(stdout, "HTTP/1.1 200 OK\r\nX-Test: paid\r\n\r\npaid body");
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
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const stdout = await captureStdout(() =>
        call.handler({
          paymentInfo: false,
          tool: "curl",
          args: ["https://example.com"],
        }),
      );
      const stderr = await captureStderr(() =>
        call.handler({
          paymentInfo: false,
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
        buildPaymentRetryHeader: async () => ({
          detectedVersion: 1,
          header: {
            name: "X-PAYMENT",
            value: "paid",
          },
          paymentInfo: {
            amount: "1000",
            asset: "USDC",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          },
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

          return createStreamedCompletedResult({
            exitCode: 0,
            headers: {},
          });
        },
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      await call.handler({
        paymentInfo: false,
        tool: "curl",
        args: ["https://example.com"],
      });
      t.same(invocations[1], {
        tool: "curl",
        args: ["https://example.com"],
        extraHeader: { name: "X-PAYMENT", value: "paid" },
        streamOutput: true,
      });
    },
  );

  await t.test(
    "prints payment metadata to stderr only when payment-info is enabled",
    async (t) => {
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => ({
          detectedVersion: 1,
          header: {
            name: "X-PAYMENT",
            value: "paid",
          },
          paymentInfo: {
            amount: "1000",
            asset: "USDC",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          },
        }),
        runWrappedClient: async (args) => {
          if ("extraHeader" in args) {
            return createStreamedCompletedResult({
              exitCode: 0,
              headers: {
                "payment-response": JSON.stringify({
                  success: true,
                  transaction: "sig-123",
                  network: "solana-mainnet-beta",
                  payer: "payer",
                }),
              },
            });
          }

          return createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response(
              JSON.stringify({ x402Version: 1, accepts: [] }),
              { status: 402 },
            ),
          });
        },
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const stderr = await captureStderr(() =>
        call.handler({
          paymentInfo: true,
          tool: "curl",
          args: ["https://example.com"],
        }),
      );

      t.match(stderr, /Payment:/);
      t.match(stderr, /amount: 0\.001000/);
      t.match(stderr, /asset: USDC/);
      t.match(stderr, /network: solana-devnet/);
      t.match(stderr, /tx_signature: sig-123/);
      t.notMatch(stderr, /response_headers:/);
      t.notMatch(stderr, /payment-response:/);
    },
  );

  await t.test(
    "omits tx signature when the paid response does not include one",
    async (t) => {
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => ({
          detectedVersion: 1,
          header: {
            name: "X-PAYMENT",
            value: "paid",
          },
          paymentInfo: {
            amount: "1000",
            asset: "USDC",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          },
        }),
        runWrappedClient: async (args) => {
          if ("extraHeader" in args) {
            return createStreamedCompletedResult({
              exitCode: 0,
            });
          }

          return createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response(
              JSON.stringify({ x402Version: 1, accepts: [] }),
              { status: 402 },
            ),
          });
        },
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const stderr = await captureStderr(() =>
        call.handler({
          paymentInfo: true,
          tool: "curl",
          args: ["https://example.com"],
        }),
      );

      t.match(stderr, /Payment:/);
      t.notMatch(stderr, /tx_signature:/);
      t.notMatch(stderr, /response_headers:/);
    },
  );

  await t.test(
    "does not print payment metadata when payment-info is disabled",
    async (t) => {
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => ({
          detectedVersion: 1,
          header: {
            name: "X-PAYMENT",
            value: "paid",
          },
          paymentInfo: {
            amount: "1000",
            asset: "USDC",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          },
        }),
        runWrappedClient: async (args) => {
          if ("extraHeader" in args) {
            return createCompletedResult({
              exitCode: 0,
              stdout: "paid response",
              stderr: "",
            });
          }

          return createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response(
              JSON.stringify({ x402Version: 1, accepts: [] }),
              { status: 402 },
            ),
          });
        },
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const stderr = await captureStderr(() =>
        call.handler({
          paymentInfo: false,
          tool: "curl",
          args: ["https://example.com"],
        }),
      );

      t.notMatch(stderr, /Payment:/);
      t.notMatch(stderr, /tx_signature:/);
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
          headers: new Headers(),
        }),
      });

      const stdout = await captureStdoutBytes(() =>
        call.handler({
          paymentInfo: false,
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
      buildPaymentRetryHeader: async () => ({
        detectedVersion: 1,
        header: {
          name: "X-PAYMENT",
          value: "paid",
        },
        paymentInfo: {
          amount: "1000",
          asset: "USDC",
          network: "devnet",
          txSignature: "sig-123",
        },
      }),
      runWrappedClient: async () =>
        createPaymentRejectedResult("wrong network"),
    });

    const stderr = await captureStderr(() =>
      call.handler({
        paymentInfo: false,
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
      buildPaymentRetryHeader: async () => ({
        detectedVersion: 1,
        header: {
          name: "X-PAYMENT",
          value: "paid",
        },
        paymentInfo: {
          amount: "1000",
          asset: "USDC",
          network: "devnet",
          txSignature: "sig-123",
        },
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
        paymentInfo: true,
        tool: "curl",
        args: ["https://example.com"],
      }),
    );

    t.match(stderr, /invalid x402 payment challenge/);
    t.equal(process.exitCode, 1);
  });
});
