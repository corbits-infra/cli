import {
  command,
  multioption,
  option,
  optional,
  positional,
  string,
} from "cmd-ts";
import {
  printJson,
  printYaml,
  tryParseJson,
  writeLine,
  writeStderrLine,
} from "../output/format.js";
import { formatFlag, resolveOutputFormat } from "../flags.js";
import { loadRequiredConfig } from "../config/index.js";
import type { OutputFormat } from "../output/format.js";
import { buildPayer } from "../payment/payer.js";

type HeaderMap = Record<string, string>;

type SuccessfulTextResponse = {
  status: number;
  status_text: string;
  headers: HeaderMap;
  body: string;
};

type CallDeps = {
  resolveOutputFormat: typeof resolveOutputFormat;
  loadRequiredConfig: typeof loadRequiredConfig;
  buildPayer: typeof buildPayer;
};

type BuildRequestResult = {
  headers: HeaderMap;
  init: RequestInit;
};

type CallArgs = {
  url: string;
  method: string | undefined;
  header: string[];
  body: string | undefined;
  format: OutputFormat | undefined;
};

function headerValueType() {
  return {
    async from(values: string[]): Promise<string[]> {
      return values;
    },
    description: "header",
    displayName: "header",
  };
}

function normalizeMethod(method: string | undefined): string {
  const normalized = method?.trim().toUpperCase();
  return normalized && normalized.length > 0 ? normalized : "GET";
}

function hasHeader(headers: HeaderMap, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function isJsonBody(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function validateCallUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL "${url}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid URL "${url}". Only http and https are supported`);
  }
}

export function parseHeaders(values: string[]): HeaderMap {
  const headers: HeaderMap = {};

  for (const value of values) {
    const separator = value.indexOf(":");
    if (separator <= 0) {
      throw new Error(
        `Invalid header "${value}". Expected format "Key: Value"`,
      );
    }

    const key = value.slice(0, separator).trim();
    const headerValue = value.slice(separator + 1).trim();
    if (key.length === 0) {
      throw new Error(
        `Invalid header "${value}". Expected format "Key: Value"`,
      );
    }

    headers[key] = headerValue;
  }

  return headers;
}

export function buildRequestInit(args: {
  method: string | undefined;
  header: string[];
  body: string | undefined;
}): BuildRequestResult {
  const method = normalizeMethod(args.method);
  const headers = parseHeaders(args.header);
  const init: RequestInit = {
    method,
    headers,
  };

  if (args.body != null) {
    init.body = args.body;
    if (!hasHeader(headers, "content-type") && isJsonBody(args.body)) {
      headers["Content-Type"] = "application/json";
    }
  }

  return { headers, init };
}

export function responseHeadersToObject(response: Response): HeaderMap {
  return Object.fromEntries(response.headers.entries());
}

export function buildStructuredTextResponse(
  response: Response,
  body: string,
): SuccessfulTextResponse {
  return {
    status: response.status,
    status_text: response.statusText,
    headers: responseHeadersToObject(response),
    body,
  };
}

export async function printSuccessfulResponse(
  response: Response,
  format: Awaited<ReturnType<typeof resolveOutputFormat>>,
): Promise<void> {
  const body = await response.text();

  if (format === "table") {
    writeLine(`HTTP/1.1 ${response.status} ${response.statusText}`);
    if (body.length > 0) {
      writeLine(body);
    }
    return;
  }

  const parsed = tryParseJson(body);
  if (format === "json") {
    printJson(parsed ?? buildStructuredTextResponse(response, body));
    return;
  }

  printYaml(parsed ?? buildStructuredTextResponse(response, body));
}

export async function handleErrorResponse(response: Response): Promise<void> {
  const body = await response.text();
  writeStderrLine(`HTTP/1.1 ${response.status} ${response.statusText}`);
  if (body.length > 0) {
    writeStderrLine(body);
  }
  process.exitCode = 1;
}

export function createCallCommand(deps: CallDeps) {
  return command({
    name: "call",
    description: "Call an x402-gated endpoint",
    args: {
      url: positional({ type: string, displayName: "url" }),
      method: option({
        type: optional(string),
        long: "method",
        short: "X",
        description: "HTTP method (default: GET)",
      }),
      header: multioption({
        type: headerValueType(),
        long: "header",
        short: "H",
        description: 'Request header in the form "Key: Value"',
      }),
      body: option({
        type: optional(string),
        long: "body",
        short: "d",
        description: "Request body",
      }),
      format: formatFlag,
    },
    handler: async ({ url, method, header, body, format }: CallArgs) => {
      const outputFormat = await deps.resolveOutputFormat(format);
      const loaded = await deps.loadRequiredConfig();
      const payer = await deps.buildPayer(loaded.resolved);
      validateCallUrl(url);
      const { init } = buildRequestInit({ method, header, body });
      const response = await payer.fetch(url, init);

      if (!response.ok) {
        await handleErrorResponse(response);
        return;
      }

      await printSuccessfulResponse(response, outputFormat);
    },
  });
}

export const call = createCallCommand({
  resolveOutputFormat,
  loadRequiredConfig,
  buildPayer,
});
