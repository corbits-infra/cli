#!/usr/bin/env pnpm tsx

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import t from "tap";
import { V2_PAYMENT_REQUIRED_HEADER } from "@faremeter/types/x402v2";
import { createCallCommand } from "../src/commands/call.js";
import {
  createRunWrappedClient,
  testExports,
} from "../src/process/wrapped-client.js";
import type { WrappedRunResult } from "../src/process/wrapped-client.js";
import type { LoadedConfig } from "../src/config/index.js";
import type { PreflightBalanceDeps } from "../src/payment/balance.js";
import {
  captureCombinedOutput,
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
  spending: {},
  activeWallet: {
    kind: "keypair",
    family: "solana",
    address: "So11111111111111111111111111111111111111112",
    path: "~/.config/solana/id.json",
    expandedPath: "/tmp/solana-id.json",
  },
} as const;

function createLoadedConfig(options?: {
  confirmAboveUsd?: string;
}): LoadedConfig {
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
      ...(options?.confirmAboveUsd == null
        ? {}
        : {
            spending: {
              confirm_above_usd: options.confirmAboveUsd,
            },
          }),
      wallets: {
        solana: {
          kind: "keypair",
          address: "So11111111111111111111111111111111111111112",
          path: "~/.config/solana/id.json",
        },
      },
    },
    resolved: {
      ...resolvedConfig,
      spending: {
        ...(options?.confirmAboveUsd == null
          ? {}
          : { confirmAboveUsd: options.confirmAboveUsd }),
      },
    },
  };
}

function createCompletedResult(args: {
  exitCode: number;
  status?: number | null;
  stdout: string;
  stderr: string;
  headers?: Record<string, string>;
}): Extract<WrappedRunResult, { kind: "completed" }> {
  return {
    kind: "completed",
    exitCode: args.exitCode,
    status: args.status ?? 200,
    stdout: Buffer.from(args.stdout),
    stderr: Buffer.from(args.stderr),
    headers: new Headers(args.headers),
  };
}

function createStreamedCompletedResult(args: {
  exitCode: number;
  status?: number | null;
  headers?: Record<string, string>;
}): Extract<WrappedRunResult, { kind: "streamed-completed" }> {
  return {
    kind: "streamed-completed",
    exitCode: args.exitCode,
    status: args.status ?? 200,
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
    rename?: (sourcePath: string, destinationPath: string) => Promise<void>;
    readBinaryFile?: (filePath: string) => Promise<Uint8Array>;
    readTextFile?: (
      filePath: string,
      encoding: BufferEncoding,
    ) => Promise<string>;
    fetch?: typeof globalThis.fetch;
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
    rename: args.rename ?? fs.rename,
    rm: fs.rm,
    ...(args.fetch == null ? {} : { fetch: args.fetch }),
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

      const repeatedDataRequest = await testExports.parseWrappedRequestInfo(
        {
          readBinaryFile: async () => Buffer.from("unused"),
        },
        "curl",
        ["-d", "a=1", "--data-binary=two", "https://example.com/items"],
      );
      t.equal(
        Buffer.from(
          repeatedDataRequest.requestInit.body as Uint8Array,
        ).toString(),
        "a=1&two",
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

  await t.test(
    "parses wrapped request headers for curl and wget",
    async (t) => {
      const curlHeaders = testExports.parseWrappedRequestHeaders("curl", [
        "-H",
        "Content-Type: application/json",
        "--header=X-Runway-Version: 2024-11-06",
        "https://example.com/items",
      ]);
      t.equal(curlHeaders.get("content-type"), "application/json");
      t.equal(curlHeaders.get("x-runway-version"), "2024-11-06");

      const wgetHeaders = testExports.parseWrappedRequestHeaders("wget", [
        "--header",
        "Content-Type: application/json",
        "--header=X-Trace-Id: 123",
        "https://example.com/items",
      ]);
      t.equal(wgetHeaders.get("content-type"), "application/json");
      t.equal(wgetHeaders.get("x-trace-id"), "123");
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
    "detects curl multi-transfer and wget response flags",
    async (t) => {
      t.equal(testExports.hasCurlNextFlag(["--next"]), true);
      t.equal(testExports.hasCurlNextFlag(["https://example.com"]), false);
      t.equal(testExports.hasWgetServerResponseFlag(["-S"]), true);
      t.equal(
        testExports.hasWgetServerResponseFlag(["--server-response"]),
        true,
      );
      t.equal(
        testExports.hasWgetContentOnErrorFlag(["--content-on-error"]),
        true,
      );
      t.equal(
        testExports.hasWgetServerResponseFlag(["https://example.com"]),
        false,
      );
      t.equal(
        testExports.hasWgetContentOnErrorFlag(["https://example.com"]),
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
            remoteName: false,
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
        spawn: createSpawnStub({
          stdout: Buffer.from("paid body"),
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

    t.same(calls[0]?.file, "curl");
    t.match(calls[0]?.args ?? [], [
      "https://example.com",
      "-H",
      "X-PAYMENT: paid-header",
    ]);
  });

  await t.test("injects V2 curl retry headers on second pass", async (t) => {
    const tempDir = t.testdir();
    const calls: { file: string; args: string[] }[] = [];
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        spawn: createSpawnStub({
          stdout: Buffer.from("paid body"),
          onSpawn: (file, spawnedArgs) => {
            calls.push({ file, args: spawnedArgs });
          },
        }),
      }),
    );

    await runWrappedClient({
      tool: "curl",
      args: ["https://example.com"],
      extraHeader: {
        name: "PAYMENT-SIGNATURE",
        value: "paid-signature",
      },
    });

    t.match(calls[0]?.args ?? [], [
      "https://example.com",
      "-H",
      "PAYMENT-SIGNATURE: paid-signature",
    ]);
  });

  await t.test("preserves repeated curl headers on retry", async (t) => {
    const tempDir = t.testdir();
    const calls: { file: string; args: string[] }[] = [];
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        spawn: createSpawnStub({
          stdout: Buffer.from("paid body"),
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

    t.match(calls[0]?.args ?? [], [
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
          stderr: Buffer.from("HTTP/1.1 200 OK\nContent-Length: 14\n"),
        }),
        readBinaryFile: async (filePath) => {
          if (filePath.endsWith("stdout.txt")) {
            return Buffer.from("downloaded body");
          }
          if (filePath.endsWith("stderr.txt")) {
            return Buffer.from("HTTP/1.1 200 OK\nContent-Length: 14\n");
          }
          return new Uint8Array();
        },
      }),
    );

    const result = await runWrappedClient({
      tool: "wget",
      args: ["https://example.com"],
    });

    t.same(result, {
      kind: "completed",
      exitCode: 0,
      status: 200,
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
            stderr: Buffer.from("HTTP/1.1 200 OK\n"),
          }),
          readBinaryFile: async (filePath) => {
            if (filePath.endsWith("stdout.txt")) {
              return largeBody;
            }
            if (filePath.endsWith("stderr.txt")) {
              return Buffer.from("HTTP/1.1 200 OK\n");
            }
            return new Uint8Array();
          },
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

  await t.test("preserves wget stdout semantics for -O-", async (t) => {
    const tempDir = t.testdir();
    const writes: { path: string; data: string }[] = [];
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        spawn: createSpawnStub({
          stdout: Buffer.from("downloaded body"),
          stderr: Buffer.from("HTTP/1.1 200 OK\n"),
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
      tool: "wget",
      args: ["-O-", "https://example.com"],
    });

    t.equal(result.kind, "completed");
    if (result.kind === "completed") {
      t.equal(result.stdout.toString(), "downloaded body");
    }
    t.same(writes, []);
  });

  await t.test(
    "preserves wget stdout semantics when no output file is provided",
    async (t) => {
      const tempDir = t.testdir();
      const writes: { path: string; data: string }[] = [];
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stdout: Buffer.from("downloaded body"),
            stderr: Buffer.from("HTTP/1.1 200 OK\n"),
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
        tool: "wget",
        args: ["https://example.com"],
      });

      t.equal(result.kind, "completed");
      if (result.kind === "completed") {
        t.equal(result.stdout.toString(), "downloaded body");
      }
      t.same(writes, []);
    },
  );

  await t.test("renames successful wget file outputs into place", async (t) => {
    const tempDir = t.testdir();
    const renames: { source: string; destination: string }[] = [];
    const writes: { path: string; data: string }[] = [];
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        spawn: createSpawnStub({
          stderr: Buffer.from("HTTP/1.1 200 OK\nContent-Length: 14\n"),
        }),
        readBinaryFile: async (filePath) => {
          if (filePath.endsWith("body.bin")) {
            return Buffer.from("downloaded body");
          }
          if (filePath.endsWith("stderr.txt")) {
            return Buffer.from("HTTP/1.1 200 OK\nContent-Length: 14\n");
          }
          return new Uint8Array();
        },
        rename: async (source, destination) => {
          renames.push({ source, destination });
        },
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
      tool: "wget",
      args: ["-O", "/tmp/output.json", "https://example.com"],
    });

    t.equal(result.kind, "completed");
    if (result.kind === "completed") {
      t.equal(result.stdout.length, 0);
    }
    t.same(writes, []);
    t.equal(renames.length, 1);
    t.match(renames[0], {
      source: /body\.bin$/,
      destination: "/tmp/output.json",
    });
  });

  await t.test("preserves wget args and stderr on paid retries", async (t) => {
    const tempDir = t.testdir();
    const calls: { file: string; args: string[] }[] = [];
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        spawn: createSpawnStub({
          stdout: Buffer.from("downloaded body"),
          stderr: Buffer.from("HTTP/1.1 200 OK\nX-Test: paid\n"),
          onSpawn: (file, spawnedArgs) => {
            calls.push({ file, args: spawnedArgs });
          },
        }),
      }),
    );

    await runWrappedClient({
      tool: "wget",
      args: [
        "--header",
        "Content-Type: application/json",
        "--post-data=hello",
        "https://example.com",
      ],
      extraHeader: {
        name: "X-PAYMENT",
        value: "paid",
      },
    });

    t.same(calls[0]?.file, "wget");
    t.match(calls[0]?.args ?? [], [
      "--header",
      "X-PAYMENT: paid",
      "--content-on-error",
      "--server-response",
      "--header",
      "Content-Type: application/json",
      "--post-data=hello",
      "https://example.com",
      "-O",
      "-",
    ]);
  });

  await t.test(
    "streams wget retry output to stdout without buffering",
    async (t) => {
      const tempDir = t.testdir();
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stdout: Buffer.from("paid body"),
          }),
        }),
      );

      const stdout = await captureStdoutBytes(() =>
        runWrappedClient({
          tool: "wget",
          args: ["https://example.com"],
          extraHeader: { name: "X-PAYMENT", value: "paid" },
          streamOutput: true,
        }).then(() => undefined),
      );
      const stderr = await captureStderr(() =>
        runWrappedClient({
          tool: "wget",
          args: ["https://example.com"],
          extraHeader: { name: "X-PAYMENT", value: "paid" },
          streamOutput: true,
        }).then(() => undefined),
      );

      t.equal(Buffer.from(stdout).toString("utf8"), "paid body");
      t.equal(stderr, "");
    },
  );

  await t.test("preserves curl flags on paid retries", async (t) => {
    const tempDir = t.testdir();
    const calls: { file: string; args: string[] }[] = [];
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        spawn: createSpawnStub({
          stdout: Buffer.from('{"ok":true}'),
          onSpawn: (file, spawnedArgs) => {
            calls.push({ file, args: spawnedArgs });
          },
        }),
      }),
    );

    await runWrappedClient({
      tool: "curl",
      args: [
        "-L",
        "--compressed",
        "-u",
        "alice:secret",
        "-H",
        "Content-Type: application/json",
        "-d",
        '{"ok":true}',
        "https://example.com",
      ],
      extraHeader: {
        name: "X-PAYMENT",
        value: "paid",
      },
    });

    t.same(calls[0]?.file, "curl");
    t.match(calls[0]?.args ?? [], [
      "-L",
      "--compressed",
      "-u",
      "alice:secret",
      "-H",
      "Content-Type: application/json",
      "-d",
      '{"ok":true}',
      "https://example.com",
      "-H",
      "X-PAYMENT: paid",
    ]);
  });

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
            stderr: Buffer.from(
              "HTTP/1.1 402 Payment Required\nContent-Type: application/json\n",
            ),
          }),
          readBinaryFile: async (filePath) => {
            if (filePath.endsWith("stdout.txt")) {
              return Buffer.from(challengeBody);
            }
            if (filePath.endsWith("stderr.txt")) {
              return Buffer.from(
                "HTTP/1.1 402 Payment Required\nContent-Type: application/json\n",
              );
            }
            return new Uint8Array();
          },
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
          stderr: Buffer.from(
            "HTTP/1.1 402 Payment Required\nContent-Type: application/json\n",
          ),
        }),
        readBinaryFile: async (filePath) => {
          if (filePath.endsWith("body.bin")) {
            return Buffer.from(challengeBody);
          }
          if (filePath.endsWith("stderr.txt")) {
            return Buffer.from(
              "HTTP/1.1 402 Payment Required\nContent-Type: application/json\n",
            );
          }
          return new Uint8Array();
        },
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

  await t.test(
    "preserves wget 402 challenge bodies when output-document is set",
    async (t) => {
      const tempDir = t.testdir();
      const challengeBody = JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: "exact" }],
      });
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stderr: Buffer.from(
              "HTTP/1.1 402 Payment Required\nContent-Type: application/json\n",
            ),
          }),
          readBinaryFile: async (filePath) => {
            if (filePath.endsWith("body.bin")) {
              return Buffer.from(challengeBody);
            }
            if (filePath.endsWith("stderr.txt")) {
              return Buffer.from(
                "HTTP/1.1 402 Payment Required\nContent-Type: application/json\n",
              );
            }
            return new Uint8Array();
          },
        }),
      );

      const result = await runWrappedClient({
        tool: "wget",
        args: ["-O", "/tmp/out.json", "https://example.com"],
      });

      t.equal(result.kind, "payment-required");
      if (result.kind === "payment-required") {
        t.equal(await result.response.text(), challengeBody);
        t.equal(result.url, "https://example.com");
        t.same(result.requestInit, { method: "GET" });
      }
    },
  );

  await t.test("streams retry output for curl without buffering", async (t) => {
    const tempDir = t.testdir();
    const runWrappedClient = createRunWrappedClient(
      createWrapperDeps(tempDir, {
        spawn: createSpawnStub({
          stdout: Buffer.from("paid body"),
        }),
      }),
    );

    const stdout = await captureStdoutBytes(() =>
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

    t.equal(Buffer.from(stdout).toString("utf8"), "paid body");
    t.equal(stderr, "");
  });

  await t.test(
    "preserves curl dump-header files on streamed paid retries",
    async (t) => {
      const tempDir = t.testdir();
      const writes: { path: string; data: string }[] = [];
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stdout: Buffer.from("paid body"),
          }),
          readTextFile: async () => "HTTP/1.1 200\r\nx-test: paid\r\n\r\n",
          writeFile: async (filePath, data) => {
            writes.push({
              path: filePath,
              data:
                typeof data === "string" ? data : Buffer.from(data).toString(),
            });
          },
        }),
      );

      const stdout = await captureStdoutBytes(() =>
        runWrappedClient({
          tool: "curl",
          args: ["--dump-header=/tmp/headers.txt", "https://example.com"],
          extraHeader: { name: "X-PAYMENT", value: "paid" },
          streamOutput: true,
        }).then(() => undefined),
      );

      t.equal(Buffer.from(stdout).toString("utf8"), "paid body");
      t.same(writes, [
        {
          path: "/tmp/headers.txt",
          data: "HTTP/1.1 200\r\nx-test: paid\r\n\r\n",
        },
      ]);
    },
  );

  await t.test(
    "replays curl dumped headers to stdout on streamed paid retries",
    async (t) => {
      const tempDir = t.testdir();
      let seenHeaderPath: string | undefined;
      const runWrappedClient = createRunWrappedClient(
        createWrapperDeps(tempDir, {
          spawn: createSpawnStub({
            stdout: Buffer.from("paid body"),
          }),
          readTextFile: async () => "HTTP/1.1 200\r\nx-test: paid\r\n\r\n",
          writeFile: async (filePath) => {
            seenHeaderPath = filePath;
          },
        }),
      );

      const stdout = await captureStdoutBytes(() =>
        runWrappedClient({
          tool: "curl",
          args: ["-D", "-", "https://example.com"],
          extraHeader: { name: "X-PAYMENT", value: "paid" },
          streamOutput: true,
        }).then(() => undefined),
      );

      t.equal(seenHeaderPath, undefined);
      t.equal(
        Buffer.from(stdout).toString("utf8"),
        "HTTP/1.1 200\r\nx-test: paid\r\n\r\npaid body",
      );
    },
  );
});

await t.test("call command", async (t) => {
  await t.test(
    "prints parsed requirements from a body-based x402 challenge without paying",
    async (t) => {
      let buildPaymentRetryHeaderCalls = 0;
      const call = createCallCommand({
        loadRequiredConfig: async () => {
          throw new Error("should not load required config");
        },
        buildPaymentRetryHeader: async () => {
          buildPaymentRetryHeaderCalls += 1;
          throw new Error("should not build payment header");
        },
        runWrappedClient: async () =>
          createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response(
              JSON.stringify({
                x402Version: 1,
                accepts: [
                  {
                    scheme: "exact",
                    network: "solana-mainnet-beta",
                    maxAmountRequired: "10000",
                    resource: "https://example.com",
                    description: "pay",
                    payTo: "receiver",
                    maxTimeoutSeconds: 60,
                    asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                    extra: { decimals: 6 },
                  },
                ],
              }),
              { status: 402, statusText: "Payment Required" },
            ),
          }),
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const stdout = await captureStdout(async () => {
        await call.handler({
          inspect: true,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: "table",
          tool: "curl",
          args: ["https://example.com"],
        });
      });

      t.match(stdout, /x402 Version: 1/);
      t.match(stdout, /Scheme/);
      t.match(stdout, /USDT/);
      t.match(stdout, /receiver/);
      t.match(stdout, /0\.010000/);
      t.equal(buildPaymentRetryHeaderCalls, 0);
    },
  );

  await t.test(
    "prints parsed requirements from a header-based x402 challenge in json",
    async (t) => {
      const call = createCallCommand({
        loadRequiredConfig: async () => {
          throw new Error("should not load required config");
        },
        buildPaymentRetryHeader: async () => {
          throw new Error("should not build payment header");
        },
        runWrappedClient: async () =>
          createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "POST" },
            response: new Response("", {
              status: 402,
              statusText: "Payment Required",
              headers: {
                [V2_PAYMENT_REQUIRED_HEADER]: Buffer.from(
                  JSON.stringify({
                    x402Version: 2,
                    resource: {
                      url: "https://example.com",
                      method: "POST",
                    },
                    accepts: [
                      {
                        scheme: "exact",
                        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                        amount: "5000",
                        payTo: "receiver",
                        maxTimeoutSeconds: 60,
                        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                        extra: { decimals: 6 },
                      },
                    ],
                  }),
                  "utf8",
                ).toString("base64"),
              },
            }),
          }),
      });

      const stdout = await captureStdout(async () => {
        await call.handler({
          inspect: true,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: "json",
          tool: "curl",
          args: ["https://example.com"],
        });
      });

      t.same(JSON.parse(stdout), {
        version: 2,
        resource: {
          url: "https://example.com",
          method: "POST",
        },
        requirements: [
          {
            scheme: "exact",
            network: "solana-devnet",
            asset: "USDC",
            assetAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            amount: "0.005000",
            payTo: "receiver",
            maxTimeoutSeconds: 60,
            extra: { decimals: 6 },
          },
        ],
      });
    },
  );

  await t.test(
    "prints parsed requirements from a v1 header-based x402 challenge in json",
    async (t) => {
      const call = createCallCommand({
        loadRequiredConfig: async () => {
          throw new Error("should not load required config");
        },
        buildPaymentRetryHeader: async () => {
          throw new Error("should not build payment header");
        },
        runWrappedClient: async () =>
          createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response("", {
              status: 402,
              statusText: "Payment Required",
              headers: {
                "X-PAYMENT-REQUIRED": Buffer.from(
                  JSON.stringify({
                    x402Version: 1,
                    accepts: [
                      {
                        scheme: "exact",
                        network: "solana-mainnet-beta",
                        maxAmountRequired: "2500",
                        resource: "https://example.com",
                        description: "pay",
                        payTo: "receiver",
                        maxTimeoutSeconds: 60,
                        asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                        extra: { decimals: 6 },
                      },
                    ],
                  }),
                  "utf8",
                ).toString("base64"),
              },
            }),
          }),
      });

      const stdout = await captureStdout(async () => {
        await call.handler({
          inspect: true,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: "json",
          tool: "curl",
          args: ["https://example.com"],
        });
      });

      t.same(JSON.parse(stdout), {
        version: 1,
        resource: {
          url: "https://example.com",
          description: "pay",
        },
        requirements: [
          {
            scheme: "exact",
            network: "solana-mainnet-beta",
            asset: "USDT",
            assetAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            amount: "0.002500",
            payTo: "receiver",
            maxTimeoutSeconds: 60,
            extra: { decimals: 6 },
          },
        ],
      });
    },
  );

  await t.test(
    "accepts -f yaml after wrapped args in inspect mode",
    async (t) => {
      const calls: string[][] = [];
      const call = createCallCommand({
        loadRequiredConfig: async () => {
          throw new Error("should not load required config");
        },
        buildPaymentRetryHeader: async () => {
          throw new Error("should not build payment header");
        },
        runWrappedClient: async ({ args }) => {
          calls.push(args);
          return createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response(
              JSON.stringify({
                x402Version: 1,
                accepts: [
                  {
                    scheme: "exact",
                    network: "solana-mainnet-beta",
                    maxAmountRequired: "10000",
                    resource: "https://example.com",
                    description: "pay",
                    payTo: "receiver",
                    maxTimeoutSeconds: 60,
                    asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                    extra: { decimals: 6 },
                  },
                ],
              }),
              { status: 402, statusText: "Payment Required" },
            ),
          });
        },
      });

      const stdout = await captureStdout(async () => {
        await call.handler({
          inspect: true,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com", "-f", "yaml"],
        });
      });

      t.match(stdout, /version: 1/);
      t.match(stdout, /asset: USDT/);
      t.match(stdout, /payTo: receiver/);
      t.match(stdout, /amount: "0\.010000"/);
      t.same(calls, [["https://example.com"]]);
    },
  );

  await t.test(
    "accepts --format=json after wrapped args in inspect mode",
    async (t) => {
      const calls: string[][] = [];
      const call = createCallCommand({
        loadRequiredConfig: async () => {
          throw new Error("should not load required config");
        },
        buildPaymentRetryHeader: async () => {
          throw new Error("should not build payment header");
        },
        runWrappedClient: async ({ args }) => {
          calls.push(args);
          return createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response(
              JSON.stringify({
                x402Version: 1,
                accepts: [
                  {
                    scheme: "exact",
                    network: "solana-mainnet-beta",
                    maxAmountRequired: "10000",
                    resource: "https://example.com",
                    description: "pay",
                    payTo: "receiver",
                    maxTimeoutSeconds: 60,
                    asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                    extra: { decimals: 6 },
                  },
                ],
              }),
              { status: 402, statusText: "Payment Required" },
            ),
          });
        },
      });

      const stdout = await captureStdout(async () => {
        await call.handler({
          inspect: true,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com", "--format=json"],
        });
      });

      t.same(JSON.parse(stdout), {
        version: 1,
        resource: {
          url: "https://example.com",
          description: "pay",
        },
        requirements: [
          {
            scheme: "exact",
            network: "solana-mainnet-beta",
            asset: "USDT",
            assetAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            amount: "0.010000",
            payTo: "receiver",
            maxTimeoutSeconds: 60,
            extra: { decimals: 6 },
          },
        ],
      });
      t.same(calls, [["https://example.com"]]);
    },
  );

  await t.test(
    "errors clearly when inspect does not receive an x402 challenge",
    async (t) => {
      const priorExitCode = process.exitCode;
      process.exitCode = undefined;
      t.teardown(() => {
        process.exitCode = priorExitCode;
      });

      const call = createCallCommand({
        loadRequiredConfig: async () => {
          throw new Error("should not load required config");
        },
        buildPaymentRetryHeader: async () => {
          throw new Error("should not build payment header");
        },
        runWrappedClient: async () =>
          createCompletedResult({
            exitCode: 0,
            stdout: "body",
            stderr: "",
          }),
      });

      const stderr = await captureStderr(async () => {
        await call.handler({
          inspect: true,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: "table",
          tool: "curl",
          args: ["https://example.com"],
        });
      });

      t.match(stderr, /server did not return an x402 payment challenge/);
      t.equal(process.exitCode, 1);
    },
  );

  await t.test("rejects --asset with --inspect", async (t) => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    t.teardown(() => {
      process.exitCode = priorExitCode;
    });

    const call = createCallCommand({
      loadRequiredConfig: async () => {
        throw new Error("should not load required config");
      },
      buildPaymentRetryHeader: async () => {
        throw new Error("should not build payment header");
      },
      runWrappedClient: async () => {
        throw new Error("should not run wrapped client");
      },
    });

    const stderr = await captureStderr(async () => {
      await call.handler({
        inspect: true,
        paymentInfo: false,
        saveResponse: false,
        yes: false,
        asset: "USDT",
        format: undefined,
        tool: "curl",
        args: ["https://example.com"],
      });
    });

    t.match(stderr, /--asset cannot be used with --inspect/);
    t.equal(process.exitCode, 1);
  });

  await t.test(
    "passes the selected asset through preflight and payment retry",
    async (t) => {
      let preflightAsset: string | undefined;
      let retryAsset: string | undefined;
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async ({ config }) => {
          retryAsset = config.payment.asset;
          return {
            detectedVersion: 1,
            header: { name: "X-PAYMENT", value: "paid" },
            paymentInfo: {
              amount: "1000",
              asset: "USDC",
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            },
          };
        },
        runWrappedClient: async (args) =>
          args.extraHeader == null
            ? createPaymentRequiredResult({
                tool: "curl",
                url: "https://example.com",
                requestInit: { method: "GET" },
                response: new Response(
                  JSON.stringify({
                    x402Version: 1,
                    accepts: [
                      {
                        scheme: "exact",
                        network: "solana-mainnet-beta",
                        maxAmountRequired: "1000",
                        resource: "https://example.com",
                        description: "pay",
                        payTo: "receiver",
                        maxTimeoutSeconds: 60,
                        asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                      },
                    ],
                  }),
                  { status: 402, statusText: "Payment Required" },
                ),
              })
            : createCompletedResult({
                exitCode: 0,
                stdout: "body",
                stderr: "",
              }),
        checkPreflightBalance: async (config) => {
          preflightAsset = config.payment.asset;
        },
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      await call.handler({
        inspect: false,
        paymentInfo: false,
        saveResponse: false,
        yes: false,
        asset: "USDT",
        format: undefined,
        tool: "curl",
        args: ["https://example.com"],
      });

      t.equal(preflightAsset, "USDT");
      t.equal(retryAsset, "USDT");
    },
  );

  await t.test(
    "prompts before paying when the selected amount exceeds spending.confirmAboveUsd",
    async (t) => {
      let confirmArgs:
        | {
            thresholdUsd: string;
            amountUsd: string;
            assetAmount: string;
            assetDisplay: string;
            networkDisplay: string;
          }
        | undefined;
      let buildPaymentRetryHeaderCalls = 0;
      const call = createCallCommand({
        loadRequiredConfig: async () =>
          createLoadedConfig({ confirmAboveUsd: "0.001" }),
        canPromptForConfirmation: () => true,
        confirmPayment: async (args) => {
          confirmArgs = args;
          return true;
        },
        buildPaymentRetryHeader: async () => {
          buildPaymentRetryHeaderCalls += 1;
          return {
            detectedVersion: 2,
            header: {
              name: "PAYMENT-SIGNATURE",
              value: "paid-v2",
            },
            paymentInfo: {
              amount: "2000",
              asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              assetSymbol: "USDC",
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            },
          };
        },
        runWrappedClient: async (args) =>
          args.extraHeader == null
            ? createPaymentRequiredResult({
                tool: "curl",
                url: "https://example.com",
                requestInit: { method: "GET" },
                response: new Response("", {
                  status: 402,
                  headers: {
                    [V2_PAYMENT_REQUIRED_HEADER]: Buffer.from(
                      JSON.stringify({
                        x402Version: 2,
                        resource: {
                          url: "https://example.com",
                          method: "GET",
                        },
                        accepts: [
                          {
                            scheme: "exact",
                            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                            amount: "2000",
                            payTo: "receiver",
                            maxTimeoutSeconds: 60,
                            asset:
                              "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                            extra: { decimals: 6 },
                          },
                        ],
                      }),
                      "utf8",
                    ).toString("base64"),
                  },
                }),
              })
            : createCompletedResult({
                exitCode: 0,
                stdout: "body",
                stderr: "",
              }),
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      await call.handler({
        inspect: false,
        paymentInfo: false,
        saveResponse: false,
        yes: false,
        asset: undefined,
        format: undefined,
        tool: "curl",
        args: ["https://example.com"],
      });

      t.equal(buildPaymentRetryHeaderCalls, 1);
      t.same(confirmArgs, {
        thresholdUsd: "0.001",
        amountUsd: "0.002",
        assetAmount: "0.002000",
        assetDisplay: "USDC",
        networkDisplay: "solana-devnet",
      });
    },
  );

  await t.test(
    "fails closed when confirmation is required without an interactive terminal",
    async (t) => {
      const priorExitCode = process.exitCode;
      process.exitCode = undefined;
      t.teardown(() => {
        process.exitCode = priorExitCode;
      });

      let buildPaymentRetryHeaderCalls = 0;
      let confirmCalls = 0;
      const call = createCallCommand({
        loadRequiredConfig: async () =>
          createLoadedConfig({ confirmAboveUsd: "0.001" }),
        canPromptForConfirmation: () => false,
        confirmPayment: async () => {
          confirmCalls += 1;
          return true;
        },
        buildPaymentRetryHeader: async () => {
          buildPaymentRetryHeaderCalls += 1;
          throw new Error("should not build payment header");
        },
        runWrappedClient: async () =>
          createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response("", {
              status: 402,
              headers: {
                [V2_PAYMENT_REQUIRED_HEADER]: Buffer.from(
                  JSON.stringify({
                    x402Version: 2,
                    resource: {
                      url: "https://example.com",
                      method: "GET",
                    },
                    accepts: [
                      {
                        scheme: "exact",
                        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                        amount: "2000",
                        payTo: "receiver",
                        maxTimeoutSeconds: 60,
                        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                        extra: { decimals: 6 },
                      },
                    ],
                  }),
                  "utf8",
                ).toString("base64"),
              },
            }),
          }),
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const stderr = await captureStderr(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com"],
        });
      });

      t.match(
        stderr,
        /confirmation requires an interactive terminal; rerun with --yes to continue/,
      );
      t.equal(confirmCalls, 0);
      t.equal(buildPaymentRetryHeaderCalls, 0);
      t.equal(process.exitCode, 1);
    },
  );

  await t.test(
    "skips the confirmation prompt with --yes when the threshold is exceeded",
    async (t) => {
      let confirmCalls = 0;
      let buildPaymentRetryHeaderCalls = 0;
      const call = createCallCommand({
        loadRequiredConfig: async () =>
          createLoadedConfig({ confirmAboveUsd: "0.001" }),
        canPromptForConfirmation: () => false,
        confirmPayment: async () => {
          confirmCalls += 1;
          return true;
        },
        buildPaymentRetryHeader: async () => {
          buildPaymentRetryHeaderCalls += 1;
          return {
            detectedVersion: 2,
            header: {
              name: "PAYMENT-SIGNATURE",
              value: "paid-v2",
            },
            paymentInfo: {
              amount: "2000",
              asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              assetSymbol: "USDC",
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            },
          };
        },
        runWrappedClient: async (args) =>
          args.extraHeader == null
            ? createPaymentRequiredResult({
                tool: "curl",
                url: "https://example.com",
                requestInit: { method: "GET" },
                response: new Response("", {
                  status: 402,
                  headers: {
                    [V2_PAYMENT_REQUIRED_HEADER]: Buffer.from(
                      JSON.stringify({
                        x402Version: 2,
                        resource: {
                          url: "https://example.com",
                          method: "GET",
                        },
                        accepts: [
                          {
                            scheme: "exact",
                            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                            amount: "2000",
                            payTo: "receiver",
                            maxTimeoutSeconds: 60,
                            asset:
                              "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                            extra: { decimals: 6 },
                          },
                        ],
                      }),
                      "utf8",
                    ).toString("base64"),
                  },
                }),
              })
            : createCompletedResult({
                exitCode: 0,
                stdout: "body",
                stderr: "",
              }),
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      await call.handler({
        inspect: false,
        paymentInfo: false,
        saveResponse: false,
        yes: true,
        asset: undefined,
        format: undefined,
        tool: "curl",
        args: ["https://example.com"],
      });

      t.equal(confirmCalls, 0);
      t.equal(buildPaymentRetryHeaderCalls, 1);
    },
  );

  await t.test(
    "skips spending confirmation for EURC until USD normalization is supported",
    async (t) => {
      let confirmCalls = 0;
      let buildPaymentRetryHeaderCalls = 0;
      const call = createCallCommand({
        loadRequiredConfig: async () =>
          createLoadedConfig({ confirmAboveUsd: "0.001" }),
        canPromptForConfirmation: () => true,
        confirmPayment: async () => {
          confirmCalls += 1;
          return true;
        },
        buildPaymentRetryHeader: async () => {
          buildPaymentRetryHeaderCalls += 1;
          return {
            detectedVersion: 2,
            header: {
              name: "PAYMENT-SIGNATURE",
              value: "paid-v2",
            },
            paymentInfo: {
              amount: "2000",
              asset: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
              assetSymbol: "EURC",
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            },
          };
        },
        runWrappedClient: async (args) =>
          args.extraHeader == null
            ? createPaymentRequiredResult({
                tool: "curl",
                url: "https://example.com",
                requestInit: { method: "GET" },
                response: new Response("", {
                  status: 402,
                  headers: {
                    [V2_PAYMENT_REQUIRED_HEADER]: Buffer.from(
                      JSON.stringify({
                        x402Version: 2,
                        resource: {
                          url: "https://example.com",
                          method: "GET",
                        },
                        accepts: [
                          {
                            scheme: "exact",
                            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                            amount: "2000",
                            payTo: "receiver",
                            maxTimeoutSeconds: 60,
                            asset:
                              "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
                            extra: { decimals: 6 },
                          },
                        ],
                      }),
                      "utf8",
                    ).toString("base64"),
                  },
                }),
              })
            : createCompletedResult({
                exitCode: 0,
                stdout: "body",
                stderr: "",
              }),
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      await call.handler({
        inspect: false,
        paymentInfo: false,
        saveResponse: false,
        yes: false,
        asset: "EURC",
        format: undefined,
        tool: "curl",
        args: ["https://example.com"],
      });

      t.equal(confirmCalls, 0);
      t.equal(buildPaymentRetryHeaderCalls, 1);
    },
  );

  await t.test(
    "rejects --save-response with curl body output files on paid calls",
    async (t) => {
      const priorExitCode = process.exitCode;
      process.exitCode = undefined;
      t.teardown(() => {
        process.exitCode = priorExitCode;
      });

      let buildPaymentRetryHeaderCalls = 0;
      let checkPreflightCalls = 0;
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => {
          buildPaymentRetryHeaderCalls += 1;
          throw new Error("should not build payment retry header");
        },
        runWrappedClient: async () =>
          createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response(
              JSON.stringify({ x402Version: 1, accepts: [] }),
              {
                status: 402,
              },
            ),
          }),
        checkPreflightBalance: async () => {
          checkPreflightCalls += 1;
        },
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const stderr = await captureStderr(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: true,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["-o", "/tmp/paid-response.json", "https://example.com"],
        });
      });

      t.match(
        stderr,
        /--save-response cannot be used with -o\/--output; remove -o\/--output or omit --save-response/,
      );
      t.equal(buildPaymentRetryHeaderCalls, 0);
      t.equal(checkPreflightCalls, 0);
      t.equal(process.exitCode, 1);
    },
  );

  await t.test(
    "rejects --save-response with curl remote-name outputs on paid calls",
    async (t) => {
      const priorExitCode = process.exitCode;
      process.exitCode = undefined;
      t.teardown(() => {
        process.exitCode = priorExitCode;
      });

      let buildPaymentRetryHeaderCalls = 0;
      let checkPreflightCalls = 0;
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => {
          buildPaymentRetryHeaderCalls += 1;
          throw new Error("should not build payment retry header");
        },
        runWrappedClient: async () =>
          createPaymentRequiredResult({
            tool: "curl",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response(
              JSON.stringify({ x402Version: 1, accepts: [] }),
              {
                status: 402,
              },
            ),
          }),
        checkPreflightBalance: async () => {
          checkPreflightCalls += 1;
        },
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const stderr = await captureStderr(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: true,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["-O", "https://example.com"],
        });
      });

      t.match(
        stderr,
        /--save-response cannot be used with -O\/--remote-name; remove -O\/--remote-name or omit --save-response/,
      );
      t.equal(buildPaymentRetryHeaderCalls, 0);
      t.equal(checkPreflightCalls, 0);
      t.equal(process.exitCode, 1);
    },
  );

  await t.test(
    "rejects --save-response with wget body output files on paid calls",
    async (t) => {
      const priorExitCode = process.exitCode;
      process.exitCode = undefined;
      t.teardown(() => {
        process.exitCode = priorExitCode;
      });

      let buildPaymentRetryHeaderCalls = 0;
      let checkPreflightCalls = 0;
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => {
          buildPaymentRetryHeaderCalls += 1;
          throw new Error("should not build payment retry header");
        },
        runWrappedClient: async () =>
          createPaymentRequiredResult({
            tool: "wget",
            url: "https://example.com",
            requestInit: { method: "GET" },
            response: new Response(
              JSON.stringify({ x402Version: 1, accepts: [] }),
              {
                status: 402,
              },
            ),
          }),
        checkPreflightBalance: async () => {
          checkPreflightCalls += 1;
        },
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const stderr = await captureStderr(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: true,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "wget",
          args: [
            "--output-document=/tmp/paid-response.json",
            "https://example.com",
          ],
        });
      });

      t.match(
        stderr,
        /--save-response cannot be used with -O\/--output-document; remove -O\/--output-document or omit --save-response/,
      );
      t.equal(buildPaymentRetryHeaderCalls, 0);
      t.equal(checkPreflightCalls, 0);
      t.equal(process.exitCode, 1);
    },
  );

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

      const stdout = await captureStdout(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com"],
        });
      });
      const stderr = await captureStderr(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com"],
        });
      });

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
        inspect: false,
        paymentInfo: false,
        saveResponse: false,
        yes: false,
        asset: undefined,
        format: undefined,
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
    "retries V2 402 requests with generated payment signature header",
    async (t) => {
      const invocations: unknown[] = [];
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => ({
          detectedVersion: 2,
          header: {
            name: "PAYMENT-SIGNATURE",
            value: "paid-v2",
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
              response: new Response("", {
                status: 402,
                headers: {
                  "payment-required": "challenge",
                },
              }),
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
        inspect: false,
        paymentInfo: false,
        saveResponse: false,
        yes: false,
        asset: undefined,
        format: undefined,
        tool: "curl",
        args: ["https://example.com"],
      });

      t.same(invocations[1], {
        tool: "curl",
        args: ["https://example.com"],
        extraHeader: {
          name: "PAYMENT-SIGNATURE",
          value: "paid-v2",
        },
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

      const stderr = await captureStderr(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: true,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com"],
        });
      });

      t.match(
        stderr,
        /Payment: 0\.001000 USDC on solana-devnet, tx sig-123, response HTTP 200/,
      );
      t.notMatch(stderr, /response_headers:/);
      t.notMatch(stderr, /payment-response:/);
    },
  );

  await t.test(
    "prints payment metadata on the next line after stderr without a trailing newline",
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
              stderr: "upstream warning",
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

      const stderr = await captureStderr(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: true,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com"],
        });
      });

      t.match(
        stderr,
        /^upstream warning\nPayment: 0\.001000 USDC on solana-devnet, response HTTP 200\n/m,
      );
    },
  );

  await t.test(
    "prints payment metadata on the next line after streamed stdout without a trailing newline",
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
            process.stdout.write('{"ok":true}');
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

      const output = await captureCombinedOutput(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: true,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com"],
        });
      });

      t.match(
        output,
        /\{"ok":true\}\nPayment: 0\.001000 USDC on solana-devnet, response HTTP 200\n/,
      );
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

      const stderr = await captureStderr(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: true,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com"],
        });
      });

      t.match(
        stderr,
        /Payment: 0\.001000 USDC on solana-devnet, response HTTP 200/,
      );
      t.notMatch(stderr, /tx /);
      t.notMatch(stderr, /response_headers:/);
    },
  );

  await t.test(
    "prints payment metadata and HTTP error status when the paid retry returns an HTTP error",
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
              status: 400,
              stdout: '{"error":"bad request"}',
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

      const output = await captureCombinedOutput(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: true,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com"],
        });
      });

      t.match(
        output,
        /\{"error":"bad request"\}\nPayment: 0\.001000 USDC on solana-devnet, response HTTP 400/,
      );
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

      const stderr = await captureStderr(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com"],
        });
      });

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
          status: 200,
          stdout: Uint8Array.from([0x00, 0xff, 0x80, 0x41]),
          stderr: new Uint8Array(),
          headers: new Headers(),
        }),
      });

      const stdout = await captureStdoutBytes(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com"],
        });
      });

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

    const stderr = await captureStderr(async () => {
      await call.handler({
        inspect: false,
        paymentInfo: false,
        saveResponse: false,
        yes: false,
        asset: undefined,
        format: undefined,
        tool: "curl",
        args: ["https://example.com"],
      });
    });

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

    const stderr = await captureStderr(async () => {
      await call.handler({
        inspect: false,
        paymentInfo: true,
        saveResponse: false,
        yes: false,
        asset: undefined,
        format: undefined,
        tool: "curl",
        args: ["https://example.com"],
      });
    });

    t.match(stderr, /invalid x402 payment challenge/);
    t.equal(process.exitCode, 1);
  });
});
