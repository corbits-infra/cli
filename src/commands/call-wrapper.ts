import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WRAPPED_CLIENTS = ["curl", "wget"] as const;

export type WrappedClient = (typeof WRAPPED_CLIENTS)[number];

export type RetryHeader = {
  name: string;
  value: string;
};

export type WrappedRunResult =
  | {
      kind: "completed";
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
      headers: Headers;
    }
  | {
      kind: "streamed-completed";
      exitCode: number;
      headers: Headers;
    }
  | {
      kind: "payment-required";
      tool: WrappedClient;
      response: Response;
      url: string;
      requestInit: RequestInit;
    }
  | {
      kind: "payment-rejected";
      reason: string;
    };

type CapturedCommandResult = {
  exitCode: number;
};

type RunWrappedClientArgs = {
  tool: string;
  args: string[];
  extraHeader?: RetryHeader;
  streamOutput?: boolean;
};

type CallWrapperDeps = {
  execFile: (
    file: string,
    args: string[],
  ) => Promise<{ stdout: Uint8Array; stderr: Uint8Array }>;
  spawn?: typeof spawn;
  mkdtemp: (prefix: string) => Promise<string>;
  readBinaryFile: (path: string) => Promise<Uint8Array>;
  readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile: (
    path: string,
    data: Uint8Array | string,
    encoding?: BufferEncoding,
  ) => Promise<void>;
  rm: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => Promise<void>;
};

type VerificationFailureBody = {
  error?: unknown;
  message?: unknown;
};

type WrappedBody = Uint8Array | string;

type CurlOutputTarget = {
  bodyPath: string | null;
  headerPath: string | null;
};

type SanitizedCurlArgs = {
  args: string[];
  outputTarget: CurlOutputTarget;
};

type CurlExecutionPlan = {
  commandArgs: string[];
  outputTarget: CurlOutputTarget;
  mirrorStdout: boolean;
  writeBodyToTemp: boolean;
};

type WgetOutputTarget = {
  bodyPath: string | null;
};

type WrappedRequestInfo = {
  requestInit: RequestInit;
  url: string;
};

function isVerificationFailureBody(
  value: unknown,
): value is VerificationFailureBody {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseVerificationFailure(body: string): string | null {
  if (body.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isVerificationFailureBody(parsed)) {
      return null;
    }
    if (parsed.error !== "verification_failed") {
      return null;
    }
    return typeof parsed.message === "string"
      ? parsed.message
      : "payment verification failed";
  } catch {
    return null;
  }
}

function decodeUtf8(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8");
}

function createPaymentRequiredResult(args: {
  tool: WrappedClient;
  body: Uint8Array;
  headers: Headers;
  requestInfo: WrappedRequestInfo;
}): WrappedRunResult {
  return {
    kind: "payment-required",
    tool: args.tool,
    response: new Response(args.body, {
      status: 402,
      statusText: "Payment Required",
      headers: args.headers,
    }),
    url: args.requestInfo.url,
    requestInit: args.requestInfo.requestInit,
  };
}

function createCompletedResult(args: {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  headers?: Headers;
}): Extract<WrappedRunResult, { kind: "completed" }> {
  return {
    kind: "completed",
    exitCode: args.exitCode,
    stdout: args.stdout,
    stderr: args.stderr,
    headers: args.headers ?? new Headers(),
  };
}

function createStreamedCompletedResult(args: {
  exitCode: number;
  headers?: Headers;
}): Extract<WrappedRunResult, { kind: "streamed-completed" }> {
  return {
    kind: "streamed-completed",
    exitCode: args.exitCode,
    headers: args.headers ?? new Headers(),
  };
}

function isWrappedClient(value: string): value is WrappedClient {
  return value === "curl" || value === "wget";
}

function hasCurlIncludeHeadersFlag(args: string[]): boolean {
  return args.some((arg) => arg === "-i" || arg === "--include");
}

function hasCurlNextFlag(args: string[]): boolean {
  return args.some((arg) => arg === "--next");
}

function hasWgetServerResponseFlag(args: string[]): boolean {
  return args.some((arg) => arg === "-S" || arg === "--server-response");
}

function hasMultipleWrappedUrls(args: string[]): boolean {
  let count = 0;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "--url") {
      if (args[index + 1] != null) {
        count += 1;
      }
      index += 1;
      continue;
    }

    if (arg.startsWith("--url=") || isHttpUrl(arg)) {
      count += 1;
    }
  }

  return count > 1;
}

async function checkCommandExists(
  execCommand: CallWrapperDeps["execFile"],
  tool: WrappedClient,
): Promise<void> {
  try {
    await execCommand("which", [tool]);
  } catch {
    throw new Error(`required executable "${tool}" was not found in PATH`);
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function extractFirstUrl(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "--url") {
      const candidate = args[index + 1];
      if (candidate != null) {
        return candidate;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      return arg.slice("--url=".length);
    }

    if (isHttpUrl(arg)) {
      return arg;
    }
  }

  return null;
}

async function readBodyFile(
  deps: Pick<CallWrapperDeps, "readBinaryFile">,
  filePath: string,
): Promise<Uint8Array> {
  return deps.readBinaryFile(filePath);
}

async function resolveCurlBody(
  deps: Pick<CallWrapperDeps, "readBinaryFile">,
  value: string,
): Promise<WrappedBody> {
  if (!value.startsWith("@") || value === "@-") {
    return value;
  }

  return readBodyFile(deps, value.slice(1));
}

async function resolveWgetBody(
  deps: Pick<CallWrapperDeps, "readBinaryFile">,
  args: string[],
): Promise<{ body: WrappedBody; impliedMethod?: string } | undefined> {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "--post-data") {
      const candidate = args[index + 1];
      if (candidate != null) {
        return { body: candidate, impliedMethod: "POST" };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--post-data=")) {
      return {
        body: arg.slice("--post-data=".length),
        impliedMethod: "POST",
      };
    }

    if (arg === "--body-data") {
      const candidate = args[index + 1];
      if (candidate != null) {
        return { body: candidate };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--body-data=")) {
      return { body: arg.slice("--body-data=".length) };
    }

    if (arg === "--post-file") {
      const candidate = args[index + 1];
      if (candidate != null) {
        return {
          body: await readBodyFile(deps, candidate),
          impliedMethod: "POST",
        };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--post-file=")) {
      return {
        body: await readBodyFile(deps, arg.slice("--post-file=".length)),
        impliedMethod: "POST",
      };
    }

    if (arg === "--body-file") {
      const candidate = args[index + 1];
      if (candidate != null) {
        return { body: await readBodyFile(deps, candidate) };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--body-file=")) {
      return {
        body: await readBodyFile(deps, arg.slice("--body-file=".length)),
      };
    }
  }

  return undefined;
}

async function parseWrappedRequestInfo(
  deps: Pick<CallWrapperDeps, "readBinaryFile">,
  tool: WrappedClient,
  args: string[],
): Promise<WrappedRequestInfo> {
  const url = extractFirstUrl(args) ?? "";

  if (tool === "curl") {
    let method: string | undefined;
    let body: WrappedBody | undefined;

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg == null) {
        continue;
      }

      if (arg === "-X" || arg === "--request") {
        const candidate = args[index + 1];
        if (candidate != null) {
          method = candidate.toUpperCase();
        }
        index += 1;
        continue;
      }
      if (arg.startsWith("--request=")) {
        method = arg.slice("--request=".length).toUpperCase();
        continue;
      }

      if (
        arg === "-d" ||
        arg === "--data" ||
        arg === "--data-raw" ||
        arg === "--data-binary" ||
        arg === "--data-ascii"
      ) {
        const candidate = args[index + 1];
        if (candidate != null) {
          body = await resolveCurlBody(deps, candidate);
          method ??= "POST";
        }
        index += 1;
        continue;
      }

      for (const prefix of [
        "--data=",
        "--data-raw=",
        "--data-binary=",
        "--data-ascii=",
      ]) {
        if (arg.startsWith(prefix)) {
          body = await resolveCurlBody(deps, arg.slice(prefix.length));
          method ??= "POST";
          break;
        }
      }
      if (body != null && method === "POST") {
        continue;
      }

      if (arg.startsWith("-d") && arg.length > 2) {
        body = await resolveCurlBody(deps, arg.slice(2));
        method ??= "POST";
      }
    }

    return {
      url,
      requestInit: {
        method: method ?? "GET",
        ...(body == null ? {} : { body }),
      },
    };
  }

  let method: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "--method") {
      const candidate = args[index + 1];
      if (candidate != null) {
        method = candidate.toUpperCase();
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--method=")) {
      method = arg.slice("--method=".length).toUpperCase();
    }
  }

  const bodySource = await resolveWgetBody(deps, args);
  const body = bodySource?.body;
  method ??= bodySource?.impliedMethod ?? (body == null ? "GET" : "POST");

  return {
    url,
    requestInit: {
      method,
      ...(body == null ? {} : { body }),
    },
  };
}

function parseCurlOutputTarget(args: string[]): CurlOutputTarget {
  let bodyPath: string | null = null;
  let headerPath: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "-o" || arg === "--output") {
      bodyPath = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      bodyPath = arg.slice("--output=".length);
      continue;
    }
    if (arg.startsWith("-o") && arg.length > 2) {
      bodyPath = arg.slice(2);
      continue;
    }

    if (arg === "-D" || arg === "--dump-header") {
      headerPath = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--dump-header=")) {
      headerPath = arg.slice("--dump-header=".length);
      continue;
    }
    if (arg.startsWith("-D") && arg.length > 2) {
      headerPath = arg.slice(2);
    }
  }

  return { bodyPath, headerPath };
}

function sanitizeCurlArgs(
  args: string[],
  options: { preserveBodyOutput: boolean },
): SanitizedCurlArgs {
  const outputTarget = parseCurlOutputTarget(args);
  const sanitizedArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "-o" || arg === "--output") {
      if (!options.preserveBodyOutput) {
        index += 1;
        continue;
      }
    }
    if (
      !options.preserveBodyOutput &&
      (arg.startsWith("--output=") || (arg.startsWith("-o") && arg.length > 2))
    ) {
      continue;
    }

    if (arg === "-D" || arg === "--dump-header") {
      index += 1;
      continue;
    }
    if (
      arg.startsWith("--dump-header=") ||
      (arg.startsWith("-D") && arg.length > 2)
    ) {
      continue;
    }

    sanitizedArgs.push(arg);
  }

  return {
    args: sanitizedArgs,
    outputTarget,
  };
}

function sanitizeCurlCaptureArgs(args: string[]): SanitizedCurlArgs {
  return sanitizeCurlArgs(args, { preserveBodyOutput: false });
}

function sanitizeCurlHeaderArgs(args: string[]): SanitizedCurlArgs {
  return sanitizeCurlArgs(args, { preserveBodyOutput: true });
}

function parseWgetOutputTarget(args: string[]): WgetOutputTarget {
  let bodyPath: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "-O" || arg === "--output-document") {
      bodyPath = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--output-document=")) {
      bodyPath = arg.slice("--output-document=".length);
      continue;
    }
    if (arg.startsWith("-O") && arg.length > 2) {
      bodyPath = arg.slice(2);
    }
  }

  return { bodyPath };
}

function parseCurlHeaders(raw: string): {
  status: number | null;
  headers: Headers;
} {
  const blocks = raw.split("\r\n\r\n").filter((block) => block.length > 0);
  const block = blocks.at(-1);
  if (block == null) {
    return { status: null, headers: new Headers() };
  }

  const headers = new Headers();
  let status: number | null = null;
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("HTTP/")) {
      const maybeStatus = Number(trimmed.split(/\s+/)[1]);
      status = Number.isFinite(maybeStatus) ? maybeStatus : null;
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    headers.append(key, value);
  }

  return { status, headers };
}

function parseWgetHeaders(stderr: string): {
  status: number | null;
  headers: Headers;
} {
  let status: number | null = null;
  let currentStatus: number | null = null;
  let currentHeaders = new Headers();
  let headers = new Headers();

  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("HTTP/")) {
      if (currentStatus != null) {
        status = currentStatus;
        headers = currentHeaders;
      }
      currentHeaders = new Headers();
      const maybeStatus = Number(trimmed.split(/\s+/)[1]);
      currentStatus = Number.isFinite(maybeStatus) ? maybeStatus : null;
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (key.includes(" ")) {
      continue;
    }
    const value = trimmed.slice(separator + 1).trim();
    currentHeaders.append(key.toLowerCase(), value);
  }

  if (currentStatus != null) {
    status = currentStatus;
    headers = currentHeaders;
  }

  return { status, headers };
}

function normalizeWrappedTool(tool: string): WrappedClient {
  if (!isWrappedClient(tool)) {
    throw new Error(`unsupported wrapped command "${tool}". Use curl or wget`);
  }
  return tool;
}

function assertWrappedArgs(tool: WrappedClient, args: string[]): void {
  if (args.length < 1) {
    throw new Error(
      `missing arguments for ${tool}. Provide a URL, e.g. ${tool} https://example.com`,
    );
  }
}

async function runCapturedCommand(args: {
  spawnCommand: typeof spawn;
  tool: WrappedClient;
  commandArgs: string[];
  stdoutPath: string;
  stderrPath: string;
  mirrorStdout?: boolean;
  mirrorStderr?: boolean;
}): Promise<CapturedCommandResult> {
  const child = args.spawnCommand(args.tool, args.commandArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutFile = createWriteStream(args.stdoutPath);
  const stderrFile = createWriteStream(args.stderrPath);

  child.stdout?.pipe(stdoutFile);
  child.stderr?.pipe(stderrFile);

  if (args.mirrorStdout) {
    child.stdout?.pipe(process.stdout, { end: false });
  }
  if (args.mirrorStderr) {
    child.stderr?.pipe(process.stderr, { end: false });
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      resolve(code ?? 1);
    });
  });

  await Promise.all([finished(stdoutFile), finished(stderrFile)]);
  return { exitCode };
}

function buildCurlExecutionPlan(args: {
  rawArgs: string[];
  extraHeader: RetryHeader | undefined;
  streamOutput: boolean;
  headerPath: string;
  bodyPath: string;
}): CurlExecutionPlan {
  const { args: sanitizedArgs, outputTarget } = args.streamOutput
    ? sanitizeCurlHeaderArgs(args.rawArgs)
    : sanitizeCurlCaptureArgs(args.rawArgs);
  const commandArgs = [...sanitizedArgs];

  if (args.extraHeader != null) {
    commandArgs.push(
      "-H",
      `${args.extraHeader.name}: ${args.extraHeader.value}`,
    );
  }

  commandArgs.push("-D", args.headerPath);

  if (!args.streamOutput) {
    commandArgs.push("-o", args.bodyPath);
  }

  return {
    commandArgs,
    outputTarget,
    mirrorStdout:
      args.streamOutput &&
      outputTarget.headerPath !== "-" &&
      (outputTarget.bodyPath == null || outputTarget.bodyPath === "-"),
    writeBodyToTemp: !args.streamOutput,
  };
}

async function finalizeCurlSuccess(args: {
  deps: Pick<CallWrapperDeps, "writeFile">;
  outputTarget: CurlOutputTarget;
  body: Uint8Array;
  stderr: Uint8Array;
  headers: Headers;
  headersRaw: string;
  exitCode: number;
  streamOutput: boolean;
  mirrorStdout: boolean;
}): Promise<
  Extract<WrappedRunResult, { kind: "completed" | "streamed-completed" }>
> {
  const {
    deps,
    outputTarget,
    body,
    stderr,
    headers,
    headersRaw,
    exitCode,
    streamOutput,
    mirrorStdout,
  } = args;

  if (
    outputTarget.headerPath != null &&
    outputTarget.headerPath.length > 0 &&
    outputTarget.headerPath !== "-"
  ) {
    await deps.writeFile(outputTarget.headerPath, headersRaw, "utf8");
  }

  if (
    outputTarget.bodyPath != null &&
    outputTarget.bodyPath.length > 0 &&
    outputTarget.bodyPath !== "-" &&
    !streamOutput
  ) {
    await deps.writeFile(outputTarget.bodyPath, body);
  }

  if (streamOutput) {
    if (outputTarget.headerPath === "-") {
      process.stdout.write(headersRaw);
    }
    if (
      !mirrorStdout &&
      (outputTarget.bodyPath == null || outputTarget.bodyPath === "-") &&
      body.length > 0
    ) {
      process.stdout.write(body);
    }

    return createStreamedCompletedResult({ exitCode, headers });
  }

  const stdoutChunks: Uint8Array[] = [];
  if (outputTarget.headerPath === "-") {
    stdoutChunks.push(Buffer.from(headersRaw, "utf8"));
  }
  if (outputTarget.bodyPath == null || outputTarget.bodyPath === "-") {
    stdoutChunks.push(body);
  }

  return createCompletedResult({
    exitCode,
    stdout: Buffer.concat(stdoutChunks.map((chunk) => Buffer.from(chunk))),
    stderr,
    headers,
  });
}

async function runCurl(
  deps: CallWrapperDeps,
  args: string[],
  extraHeader?: RetryHeader,
  streamOutput = false,
): Promise<WrappedRunResult> {
  if (hasCurlIncludeHeadersFlag(args)) {
    throw new Error(
      'curl flag "-i/--include" is not supported; headers are captured internally for x402 handling',
    );
  }
  if (hasCurlNextFlag(args)) {
    throw new Error(
      'curl flag "--next" is not supported; multi-transfer invocations cannot be retried safely after a 402 challenge',
    );
  }

  const tempDir = await deps.mkdtemp(path.join(os.tmpdir(), "corbits-call-"));
  const headerPath = path.join(tempDir, "headers.txt");
  const bodyPath = path.join(tempDir, "body.txt");
  const stderrPath = path.join(tempDir, "stderr.txt");

  try {
    const plan = buildCurlExecutionPlan({
      rawArgs: args,
      extraHeader,
      streamOutput,
      headerPath,
      bodyPath,
    });
    const requestInfo =
      streamOutput || extraHeader == null
        ? undefined
        : await parseWrappedRequestInfo(deps, "curl", args);

    const spawnCommand = deps.spawn ?? spawn;
    const output = await runCapturedCommand({
      spawnCommand,
      tool: "curl",
      commandArgs: plan.commandArgs,
      stdoutPath: bodyPath,
      stderrPath,
      mirrorStdout: plan.mirrorStdout,
      mirrorStderr: streamOutput,
    });
    const headersRaw = await deps
      .readTextFile(headerPath, "utf8")
      .catch(() => "");
    const body = await deps
      .readBinaryFile(bodyPath)
      .catch(() => new Uint8Array());
    const stderr = await deps
      .readBinaryFile(stderrPath)
      .catch(() => new Uint8Array());
    const { status, headers } = parseCurlHeaders(headersRaw);

    if (status !== 402) {
      return await finalizeCurlSuccess({
        deps,
        outputTarget: plan.outputTarget,
        body,
        stderr,
        headers,
        headersRaw,
        exitCode: output.exitCode,
        streamOutput,
        mirrorStdout: plan.mirrorStdout,
      });
    }

    const rejection = parseVerificationFailure(decodeUtf8(body));
    if (rejection != null) {
      return { kind: "payment-rejected", reason: rejection };
    }

    return createPaymentRequiredResult({
      tool: "curl",
      body,
      headers,
      requestInfo:
        requestInfo ?? (await parseWrappedRequestInfo(deps, "curl", args)),
    });
  } finally {
    await deps.rm(tempDir, { recursive: true, force: true });
  }
}

async function runWget(
  deps: CallWrapperDeps,
  args: string[],
  extraHeader?: RetryHeader,
  streamOutput = false,
): Promise<WrappedRunResult> {
  if (hasMultipleWrappedUrls(args)) {
    throw new Error(
      "wget multi-URL invocations are not supported; only one URL can be retried safely after a 402 challenge",
    );
  }

  const requestInfo = await parseWrappedRequestInfo(deps, "wget", args);
  const outputTarget = parseWgetOutputTarget(args);
  const commandArgs = hasWgetServerResponseFlag(args)
    ? [...args]
    : ["--server-response", ...args];

  if (extraHeader != null) {
    commandArgs.push("--header", `${extraHeader.name}: ${extraHeader.value}`);
  }

  const tempDir = await deps.mkdtemp(path.join(os.tmpdir(), "corbits-call-"));
  const stdoutPath = path.join(tempDir, "stdout.txt");
  const stderrPath = path.join(tempDir, "stderr.txt");

  try {
    const spawnCommand = deps.spawn ?? spawn;
    const output = await runCapturedCommand({
      spawnCommand,
      tool: "wget",
      commandArgs,
      stdoutPath,
      stderrPath,
      mirrorStdout: streamOutput,
      mirrorStderr: streamOutput,
    });
    const stdout = await deps
      .readBinaryFile(stdoutPath)
      .catch(() => new Uint8Array());
    const stderrBytes = await deps
      .readBinaryFile(stderrPath)
      .catch(() => new Uint8Array());
    const stderr = decodeUtf8(stderrBytes);
    const { status, headers } = parseWgetHeaders(stderr);

    if (status !== 402) {
      if (streamOutput) {
        return createStreamedCompletedResult({
          exitCode: output.exitCode,
          headers,
        });
      }

      return createCompletedResult({
        exitCode: output.exitCode,
        stdout: outputTarget.bodyPath == null ? stdout : new Uint8Array(),
        stderr: stderrBytes,
        headers,
      });
    }

    const rejection = parseVerificationFailure(decodeUtf8(stdout));
    if (rejection != null) {
      return { kind: "payment-rejected", reason: rejection };
    }

    return createPaymentRequiredResult({
      tool: "wget",
      body: stdout,
      headers,
      requestInfo,
    });
  } finally {
    await deps.rm(tempDir, { recursive: true, force: true });
  }
}

export function createRunWrappedClient(deps: CallWrapperDeps) {
  return async function runWrappedClient({
    tool,
    args,
    extraHeader,
    streamOutput,
  }: RunWrappedClientArgs): Promise<WrappedRunResult> {
    const wrappedTool = normalizeWrappedTool(tool);
    assertWrappedArgs(wrappedTool, args);

    await checkCommandExists(deps.execFile, wrappedTool);

    const runWrappedTool = wrappedTool === "curl" ? runCurl : runWget;
    return runWrappedTool(deps, args, extraHeader, streamOutput);
  };
}

export const runWrappedClient = createRunWrappedClient({
  execFile: (file, args) => execFileAsync(file, args, { encoding: "buffer" }),
  spawn,
  mkdtemp: fs.mkdtemp,
  readBinaryFile: fs.readFile,
  readTextFile: fs.readFile,
  writeFile: fs.writeFile,
  rm: fs.rm,
});

export const testExports = {
  extractFirstUrl,
  hasCurlIncludeHeadersFlag,
  hasCurlNextFlag,
  hasWgetServerResponseFlag,
  parseWrappedRequestInfo,
  sanitizeCurlCaptureArgs,
  sanitizeCurlHeaderArgs,
  parseCurlHeaders,
  parseVerificationFailure,
  parseWgetHeaders,
};
