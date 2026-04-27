import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runCapturedCommand } from "./capture.js";
import {
  createSiblingTempPrefix,
  hasFileOutputTarget,
  isStdoutTarget,
} from "./output-target.js";
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

export type WgetOutputTarget = {
  bodyPath: string | null;
};

type SanitizedWgetArgs = {
  args: string[];
  outputTarget: WgetOutputTarget;
};

type WgetExecutionPlan = {
  commandArgs: string[];
  outputTarget: WgetOutputTarget;
  captureDirPrefix: string;
  captureBodyToStdout: boolean;
  mirrorStdout: boolean;
  mirrorStderr: boolean;
  stripInjectedServerResponse: boolean;
};

export function hasMultipleWrappedURLs(args: string[]): boolean {
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

    if (
      arg.startsWith("--url=") ||
      arg.startsWith("http://") ||
      arg.startsWith("https://")
    ) {
      count += 1;
    }
  }

  return count > 1;
}

export function hasWgetServerResponseFlag(args: string[]): boolean {
  return args.some((arg) => arg === "-S" || arg === "--server-response");
}

export function hasWgetContentOnErrorFlag(args: string[]): boolean {
  return args.some((arg) => arg === "--content-on-error");
}

export function parseWgetOutputTarget(args: string[]): WgetOutputTarget {
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

function sanitizeWgetOutputArgs(args: string[]): SanitizedWgetArgs {
  const outputTarget = parseWgetOutputTarget(args);
  const sanitizedArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "-O" || arg === "--output-document") {
      index += 1;
      continue;
    }

    if (
      arg.startsWith("--output-document=") ||
      (arg.startsWith("-O") && arg.length > 2)
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

export function parseWgetHeaders(stderr: string): {
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

export function stripWgetServerResponse(stderr: string): string {
  const lines = stderr.split(/\r?\n/);
  const filteredLines: string[] = [];
  let skippingHeaders = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isIndented = line !== trimmed;

    if (isIndented && trimmed.startsWith("HTTP/")) {
      skippingHeaders = true;
      continue;
    }

    if (skippingHeaders) {
      if (trimmed.length === 0) {
        skippingHeaders = false;
        continue;
      }

      if (isIndented) {
        continue;
      }

      skippingHeaders = false;
    }

    filteredLines.push(line);
  }

  return filteredLines.join("\n").replace(/^\n+/, "");
}

function buildWgetExecutionPlan(args: {
  rawArgs: string[];
  extraHeader: RetryHeader | undefined;
  streamOutput: boolean;
}): WgetExecutionPlan {
  const { args: sanitizedArgs, outputTarget } = sanitizeWgetOutputArgs(
    args.rawArgs,
  );
  const commandArgs = [...sanitizedArgs];
  const userRequestedServerResponse = hasWgetServerResponseFlag(commandArgs);

  if (!userRequestedServerResponse) {
    commandArgs.unshift("--server-response");
  }
  if (!hasWgetContentOnErrorFlag(commandArgs)) {
    commandArgs.unshift("--content-on-error");
  }

  if (args.extraHeader != null) {
    commandArgs.unshift(
      "--header",
      `${args.extraHeader.name}: ${args.extraHeader.value}`,
    );
  }

  const captureDirPrefix = hasFileOutputTarget(outputTarget.bodyPath)
    ? createSiblingTempPrefix(outputTarget.bodyPath)
    : path.join(os.tmpdir(), "corbits-call-");
  const commandOutputTarget = isStdoutTarget(outputTarget.bodyPath)
    ? "-"
    : "body.bin";

  commandArgs.push("-O", commandOutputTarget);

  return {
    commandArgs,
    outputTarget,
    captureDirPrefix,
    captureBodyToStdout: commandOutputTarget === "-",
    mirrorStdout: args.streamOutput && isStdoutTarget(outputTarget.bodyPath),
    mirrorStderr: args.streamOutput && userRequestedServerResponse,
    stripInjectedServerResponse: !userRequestedServerResponse,
  };
}

export async function runWget(
  deps: WrappedClientDeps,
  args: string[],
  extraHeader?: RetryHeader,
  streamOutput = false,
): Promise<WrappedRunResult> {
  if (hasMultipleWrappedURLs(args)) {
    throw new Error(
      "wget multi-URL invocations are not supported; only one URL can be retried safely after a 402 challenge",
    );
  }

  const requestInfo = await parseWrappedRequestInfo(deps, "wget", args);
  const plan = buildWgetExecutionPlan({
    rawArgs: args,
    extraHeader,
    streamOutput,
  });
  const captureDir = await deps.mkdtemp(plan.captureDirPrefix);
  const stdoutPath = path.join(captureDir, "stdout.txt");
  const stderrPath = path.join(captureDir, "stderr.txt");
  const bodyPath = plan.captureBodyToStdout
    ? stdoutPath
    : path.join(captureDir, "body.bin");
  const commandArgs = [
    ...plan.commandArgs.slice(0, -2),
    "-O",
    plan.captureBodyToStdout ? "-" : bodyPath,
  ];

  try {
    const spawnCommand = deps.spawn ?? spawn;
    const output = await runCapturedCommand({
      spawnCommand,
      tool: "wget",
      commandArgs,
      stdoutPath,
      stderrPath,
      mirrorStdout: plan.mirrorStdout,
      mirrorStderr: plan.mirrorStderr,
    });
    const body = await deps
      .readBinaryFile(bodyPath)
      .catch(() => new Uint8Array());
    const stderrBytes = await deps
      .readBinaryFile(stderrPath)
      .catch(() => new Uint8Array());
    const stderr = decodeUtf8(stderrBytes);
    const { status, headers } = parseWgetHeaders(stderr);
    const visibleStderr = plan.stripInjectedServerResponse
      ? stripWgetServerResponse(stderr)
      : stderr;
    const visibleStderrBytes = Buffer.from(visibleStderr, "utf8");

    if (status !== 402) {
      if (hasFileOutputTarget(plan.outputTarget.bodyPath)) {
        await deps.rename(bodyPath, plan.outputTarget.bodyPath);
      }

      if (streamOutput) {
        if (!plan.mirrorStderr && visibleStderr.length > 0) {
          process.stderr.write(visibleStderr);
        }
        if (!plan.mirrorStdout && body.length > 0) {
          process.stdout.write(body);
        }

        return createStreamedCompletedResult({
          exitCode: output.exitCode,
          status,
          headers,
        });
      }

      return createCompletedResult({
        exitCode: output.exitCode,
        status,
        stdout: isStdoutTarget(plan.outputTarget.bodyPath)
          ? body
          : new Uint8Array(),
        stderr: visibleStderrBytes,
        headers,
      });
    }

    const rejection = parseVerificationFailure(decodeUtf8(body));
    if (rejection != null) {
      return { kind: "payment-rejected", reason: rejection };
    }

    return createPaymentRequiredResult({
      tool: "wget",
      body,
      headers,
      requestInfo,
    });
  } finally {
    await deps.rm(captureDir, { recursive: true, force: true });
  }
}
