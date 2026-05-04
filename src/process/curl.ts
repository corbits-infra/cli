import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runCapturedCommand } from "./capture.js";
import { hasFileOutputTarget, isStdoutTarget } from "./output-target.js";
import { parseWrappedRequestInfo } from "./request-info.js";
import {
  createCompletedResult,
  createPaymentRequiredResult,
  createStreamedCompletedResult,
  decodeUtf8,
  parseVerificationFailure,
  type RetryHeader,
  type WrappedClientDeps,
  type WrappedRunResult,
} from "./types.js";

export type CurlOutputTarget = {
  bodyPath: string | null;
  headerPath: string | null;
  remoteName: boolean;
};

type SanitizedCurlArgs = {
  args: string[];
  outputTarget: CurlOutputTarget;
};

type CurlExecutionPlan = {
  commandArgs: string[];
  outputTarget: CurlOutputTarget;
  mirrorStdout: boolean;
};

export function hasCurlIncludeHeadersFlag(args: string[]): boolean {
  return args.some((arg) => arg === "-i" || arg === "--include");
}

const CURL_SHORT_FLAGS_WITH_ATTACHED_VALUES = new Set([
  "A",
  "b",
  "c",
  "C",
  "d",
  "D",
  "e",
  "E",
  "F",
  "H",
  "K",
  "m",
  "o",
  "P",
  "Q",
  "r",
  "T",
  "u",
  "w",
  "x",
  "X",
  "Y",
  "y",
  "z",
]);

function hasCurlShortFailFlag(arg: string): boolean {
  if (!arg.startsWith("-") || arg.startsWith("--")) {
    return false;
  }

  for (let index = 1; index < arg.length; index += 1) {
    const flag = arg[index];
    if (flag === "f") {
      return true;
    }

    if (
      flag != null &&
      CURL_SHORT_FLAGS_WITH_ATTACHED_VALUES.has(flag) &&
      index < arg.length - 1
    ) {
      return false;
    }
  }

  return false;
}

export function hasCurlFailFlag(args: string[]): boolean {
  return args.some((arg) => arg === "--fail" || hasCurlShortFailFlag(arg));
}

export function hasCurlNextFlag(args: string[]): boolean {
  return args.some((arg) => arg === "--next");
}

function hasCurlShortTimeoutFlag(arg: string): boolean {
  if (!arg.startsWith("-") || arg.startsWith("--")) {
    return false;
  }

  for (let index = 1; index < arg.length; index += 1) {
    const flag = arg[index];
    if (flag === "m") {
      return true;
    }

    if (
      flag != null &&
      CURL_SHORT_FLAGS_WITH_ATTACHED_VALUES.has(flag) &&
      index < arg.length - 1
    ) {
      return false;
    }
  }

  return false;
}

export function hasCurlTimeoutFlag(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--max-time" || arg.startsWith("--max-time=")) {
      return true;
    }
    if (!arg.startsWith("-") || arg.startsWith("--")) {
      continue;
    }
    if (hasCurlShortTimeoutFlag(arg)) {
      return true;
    }
  }

  return false;
}

export function parseCurlOutputTarget(args: string[]): CurlOutputTarget {
  let bodyPath: string | null = null;
  let headerPath: string | null = null;
  let remoteName = false;

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

    if (
      arg === "-O" ||
      arg === "--remote-name" ||
      arg === "--remote-name-all"
    ) {
      remoteName = true;
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

  return { bodyPath, headerPath, remoteName };
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

export function sanitizeCurlCaptureArgs(args: string[]): SanitizedCurlArgs {
  return sanitizeCurlArgs(args, { preserveBodyOutput: false });
}

export function sanitizeCurlHeaderArgs(args: string[]): SanitizedCurlArgs {
  return sanitizeCurlArgs(args, { preserveBodyOutput: true });
}

export function parseCurlHeaders(raw: string): {
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
  };
}

export async function finalizeCurlSuccess(args: {
  deps: Pick<WrappedClientDeps, "writeFile">;
  outputTarget: CurlOutputTarget;
  body: Uint8Array;
  stderr: Uint8Array;
  status: number | null;
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
    status,
    headers,
    headersRaw,
    exitCode,
    streamOutput,
    mirrorStdout,
  } = args;

  if (hasFileOutputTarget(outputTarget.headerPath)) {
    await deps.writeFile(outputTarget.headerPath, headersRaw, "utf8");
  }

  if (hasFileOutputTarget(outputTarget.bodyPath) && !streamOutput) {
    await deps.writeFile(outputTarget.bodyPath, body);
  }

  if (streamOutput) {
    if (outputTarget.headerPath === "-") {
      process.stdout.write(headersRaw);
    }
    if (
      !mirrorStdout &&
      isStdoutTarget(outputTarget.bodyPath) &&
      body.length > 0
    ) {
      process.stdout.write(body);
    }

    return createStreamedCompletedResult({ exitCode, status, headers });
  }

  const stdoutChunks: Uint8Array[] = [];
  if (outputTarget.headerPath === "-") {
    stdoutChunks.push(Buffer.from(headersRaw, "utf8"));
  }
  if (isStdoutTarget(outputTarget.bodyPath)) {
    stdoutChunks.push(body);
  }

  return createCompletedResult({
    exitCode,
    status,
    stdout: Buffer.concat(stdoutChunks.map((chunk) => Buffer.from(chunk))),
    stderr,
    headers,
  });
}

export async function runCurl(
  deps: WrappedClientDeps,
  args: string[],
  extraHeader?: RetryHeader,
  streamOutput = false,
): Promise<WrappedRunResult> {
  if (hasCurlIncludeHeadersFlag(args)) {
    throw new Error(
      'curl flag "-i/--include" is not supported; headers are captured internally for x402 handling',
    );
  }
  if (hasCurlFailFlag(args)) {
    throw new Error(
      'curl flag "-f/--fail" is not supported; it hides the 402 challenge body required for x402 payment handling',
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
    const timeoutMs = hasCurlTimeoutFlag(args)
      ? undefined
      : deps.commandTimeoutMs;

    const spawnCommand = deps.spawn ?? spawn;
    const output = await runCapturedCommand({
      spawnCommand,
      tool: "curl",
      commandArgs: plan.commandArgs,
      stdoutPath: bodyPath,
      stderrPath,
      mirrorStdout: plan.mirrorStdout,
      mirrorStderr: streamOutput,
      ...(timeoutMs == null ? {} : { timeoutMs }),
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
        status,
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
