import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
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

type SpawnResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

type RunWrappedClientArgs = {
  tool: string;
  args: string[];
  extraHeader?: RetryHeader;
};

type CallWrapperDeps = {
  execFile: (
    file: string,
    args: string[],
  ) => Promise<{ stdout: Uint8Array; stderr: Uint8Array }>;
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

type ExecFileError = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

type CurlOutputTarget = {
  bodyPath: string | null;
  headerPath: string | null;
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

function isExecFileError(error: unknown): error is ExecFileError {
  return error instanceof Error;
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

function isWrappedClient(value: string): value is WrappedClient {
  return value === "curl" || value === "wget";
}

function hasCurlIncludeHeadersFlag(args: string[]): boolean {
  return args.some((arg) => arg === "-i" || arg === "--include");
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

function parseWrappedRequestInfo(
  tool: WrappedClient,
  args: string[],
): WrappedRequestInfo {
  let url = "";
  let method: string | undefined;
  let body: string | undefined;

  const setBody = (value: string) => {
    body = value;
    method ??= "POST";
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (tool === "curl" && arg === "--next") {
      break;
    }

    if (arg === "--url") {
      const candidate = args[index + 1];
      if (candidate != null) {
        url = candidate;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
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
      arg === "--data-ascii" ||
      arg === "--body-data"
    ) {
      const candidate = args[index + 1];
      if (candidate != null) {
        setBody(candidate);
      }
      index += 1;
      continue;
    }

    for (const prefix of [
      "--data=",
      "--data-raw=",
      "--data-binary=",
      "--data-ascii=",
      "--body-data=",
    ]) {
      if (arg.startsWith(prefix)) {
        setBody(arg.slice(prefix.length));
        break;
      }
    }
    if (body != null && method === "POST") {
      continue;
    }

    if (arg.startsWith("-d") && arg.length > 2) {
      setBody(arg.slice(2));
      continue;
    }

    if (isHttpUrl(arg)) {
      url = arg;
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

async function runCommand(
  deps: CallWrapperDeps,
  tool: WrappedClient,
  args: string[],
): Promise<SpawnResult> {
  try {
    const { stdout, stderr } = await deps.execFile(tool, args);
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (isExecFileError(error) && typeof error.code === "number") {
      return {
        exitCode: error.code,
        stdout:
          error.stdout == null ? new Uint8Array() : Buffer.from(error.stdout),
        stderr:
          error.stderr == null ? new Uint8Array() : Buffer.from(error.stderr),
      };
    }
    const message =
      error instanceof Error ? error.message : `failed to run ${tool}`;
    throw new Error(message, { cause: error });
  }
}

async function runCurl(
  deps: CallWrapperDeps,
  args: string[],
  extraHeader?: RetryHeader,
): Promise<WrappedRunResult> {
  if (hasCurlIncludeHeadersFlag(args)) {
    throw new Error(
      'curl flag "-i/--include" is not supported with "corbits call curl"; headers are captured internally for x402 handling',
    );
  }

  const tempDir = await deps.mkdtemp(path.join(os.tmpdir(), "corbits-call-"));
  const headerPath = path.join(tempDir, "headers.txt");
  const bodyPath = path.join(tempDir, "body.txt");

  try {
    const commandArgs = [...args];
    const outputTarget = parseCurlOutputTarget(args);
    const requestInfo = parseWrappedRequestInfo("curl", args);
    if (extraHeader != null) {
      commandArgs.push("-H", `${extraHeader.name}: ${extraHeader.value}`);
    }
    commandArgs.push("-D", headerPath, "-o", bodyPath);

    const output = await runCommand(deps, "curl", commandArgs);
    const headersRaw = await deps
      .readTextFile(headerPath, "utf8")
      .catch(() => "");
    const body = await deps
      .readBinaryFile(bodyPath)
      .catch(() => new Uint8Array());
    const { status, headers } = parseCurlHeaders(headersRaw);

    if (status !== 402) {
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
        outputTarget.bodyPath !== "-"
      ) {
        await deps.writeFile(outputTarget.bodyPath, body);
      }

      const stdoutChunks: Uint8Array[] = [];
      if (outputTarget.headerPath === "-") {
        stdoutChunks.push(Buffer.from(headersRaw, "utf8"));
      }
      if (outputTarget.bodyPath == null || outputTarget.bodyPath === "-") {
        stdoutChunks.push(body);
      }
      const stdout = Buffer.concat(
        stdoutChunks.map((chunk) => Buffer.from(chunk)),
      );

      return {
        kind: "completed",
        exitCode: output.exitCode,
        stdout,
        stderr: output.stderr,
      };
    }

    const rejection = parseVerificationFailure(decodeUtf8(body));
    if (rejection != null) {
      return { kind: "payment-rejected", reason: rejection };
    }

    return {
      kind: "payment-required",
      tool: "curl",
      response: new Response(body, {
        status: 402,
        statusText: "Payment Required",
        headers,
      }),
      url: requestInfo.url,
      requestInit: requestInfo.requestInit,
    };
  } finally {
    await deps.rm(tempDir, { recursive: true, force: true });
  }
}

async function runWget(
  deps: CallWrapperDeps,
  args: string[],
  extraHeader?: RetryHeader,
): Promise<WrappedRunResult> {
  const requestInfo = parseWrappedRequestInfo("wget", args);
  const commandArgs = args.some(
    (arg) => arg === "-S" || arg === "--server-response",
  )
    ? [...args]
    : ["--server-response", ...args];

  if (extraHeader != null) {
    commandArgs.push("--header", `${extraHeader.name}: ${extraHeader.value}`);
  }

  const output = await runCommand(deps, "wget", commandArgs);
  const { status, headers } = parseWgetHeaders(decodeUtf8(output.stderr));

  if (status !== 402) {
    return {
      kind: "completed",
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
    };
  }

  const rejection = parseVerificationFailure(decodeUtf8(output.stdout));
  if (rejection != null) {
    return { kind: "payment-rejected", reason: rejection };
  }

  return {
    kind: "payment-required",
    tool: "wget",
    response: new Response(output.stdout, {
      status: 402,
      statusText: "Payment Required",
      headers,
    }),
    url: requestInfo.url,
    requestInit: requestInfo.requestInit,
  };
}

export function createRunWrappedClient(deps: CallWrapperDeps) {
  return async function runWrappedClient({
    tool,
    args,
    extraHeader,
  }: RunWrappedClientArgs): Promise<WrappedRunResult> {
    if (!isWrappedClient(tool)) {
      throw new Error(
        `unsupported wrapped command "${tool}". Use curl or wget`,
      );
    }
    if (args.length < 1) {
      throw new Error(
        `missing arguments for ${tool}. Example: corbits call ${tool} https://example.com`,
      );
    }

    await checkCommandExists(deps.execFile, tool);

    if (tool === "curl") {
      return runCurl(deps, args, extraHeader);
    }

    return runWget(deps, args, extraHeader);
  };
}

export const runWrappedClient = createRunWrappedClient({
  execFile: (file, args) =>
    execFileAsync(file, args, {
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
    }),
  mkdtemp: fs.mkdtemp,
  readBinaryFile: fs.readFile,
  readTextFile: fs.readFile,
  writeFile: fs.writeFile,
  rm: fs.rm,
});

export const testExports = {
  parseWrappedRequestInfo,
  hasCurlIncludeHeadersFlag,
  parseCurlHeaders,
  parseVerificationFailure,
  parseWgetHeaders,
};
