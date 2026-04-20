import type { spawn } from "node:child_process";

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
      status: number | null;
      stdout: Uint8Array;
      stderr: Uint8Array;
      headers: Headers;
    }
  | {
      kind: "streamed-completed";
      exitCode: number;
      status: number | null;
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

export type RunWrappedClientArgs = {
  tool: string;
  args: string[];
  extraHeader?: RetryHeader;
  streamOutput?: boolean;
};

export type WrappedClientDeps = {
  execFile: (
    file: string,
    args: string[],
  ) => Promise<{ stdout: Uint8Array; stderr: Uint8Array }>;
  fetch?: typeof globalThis.fetch;
  spawn?: typeof spawn;
  mkdtemp: (prefix: string) => Promise<string>;
  readBinaryFile: (path: string) => Promise<Uint8Array>;
  readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile: (
    path: string,
    data: Uint8Array | string,
    encoding?: BufferEncoding,
  ) => Promise<void>;
  rename: (source: string, destination: string) => Promise<void>;
  rm: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => Promise<void>;
};

export type WrappedBody = Uint8Array | string;

export type WrappedRequestInfo = {
  requestInit: RequestInit;
  url: string;
};

export type VerificationFailureBody = {
  error?: unknown;
  message?: unknown;
};

export type CapturedCommandResult = {
  exitCode: number;
};

function isVerificationFailureBody(
  value: unknown,
): value is VerificationFailureBody {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function parseVerificationFailure(body: string): string | null {
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

export function decodeUtf8(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8");
}

export function createPaymentRequiredResult(args: {
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

export function createCompletedResult(args: {
  exitCode: number;
  status: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  headers?: Headers;
}): Extract<WrappedRunResult, { kind: "completed" }> {
  return {
    kind: "completed",
    exitCode: args.exitCode,
    status: args.status,
    stdout: args.stdout,
    stderr: args.stderr,
    headers: args.headers ?? new Headers(),
  };
}

export function createStreamedCompletedResult(args: {
  exitCode: number;
  status: number | null;
  headers?: Headers;
}): Extract<WrappedRunResult, { kind: "streamed-completed" }> {
  return {
    kind: "streamed-completed",
    exitCode: args.exitCode,
    status: args.status,
    headers: args.headers ?? new Headers(),
  };
}
