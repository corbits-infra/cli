import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import {
  hasCurlFailFlag,
  hasCurlIncludeHeadersFlag,
  hasCurlNextFlag,
  parseCurlHeaders,
  runCurl,
  sanitizeCurlCaptureArgs,
  sanitizeCurlHeaderArgs,
} from "./curl.js";
import {
  extractFirstURL,
  parseWrappedRequestHeaders,
  parseWrappedRequestInfo,
} from "./request-info.js";
import {
  parseVerificationFailure,
  WRAPPED_CLIENTS,
  type RunWrappedClientArgs,
  type WrappedClient,
  type WrappedClientDeps,
} from "./types.js";
import {
  hasWgetContentOnErrorFlag,
  hasWgetServerResponseFlag,
  parseWgetHeaders,
  runWget,
  stripWgetServerResponse,
} from "./wget.js";

const execFileAsync = promisify(execFile);

function isWrappedClient(value: string): value is WrappedClient {
  return WRAPPED_CLIENTS.some((client) => client === value);
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

async function checkCommandExists(
  execCommand: WrappedClientDeps["execFile"],
  tool: WrappedClient,
): Promise<void> {
  try {
    await execCommand("which", [tool]);
  } catch {
    throw new Error(`required executable "${tool}" was not found in PATH`);
  }
}

export function createRunWrappedClient(deps: WrappedClientDeps) {
  return async function runWrappedClient({
    tool,
    args,
    extraHeader,
    streamOutput,
  }: RunWrappedClientArgs) {
    const wrappedTool = normalizeWrappedTool(tool);
    assertWrappedArgs(wrappedTool, args);

    await checkCommandExists(deps.execFile, wrappedTool);
    return wrappedTool === "curl"
      ? runCurl(deps, args, extraHeader, streamOutput)
      : runWget(deps, args, extraHeader, streamOutput);
  };
}

export const runWrappedClient = createRunWrappedClient({
  execFile: (file, args) => execFileAsync(file, args, { encoding: "buffer" }),
  spawn,
  mkdtemp: fs.mkdtemp,
  readBinaryFile: fs.readFile,
  readTextFile: fs.readFile,
  writeFile: fs.writeFile,
  rename: fs.rename,
  rm: fs.rm,
  fetch: globalThis.fetch,
});

export const testExports = {
  extractFirstURL,
  hasCurlFailFlag,
  hasCurlIncludeHeadersFlag,
  hasCurlNextFlag,
  hasWgetContentOnErrorFlag,
  hasWgetServerResponseFlag,
  parseWrappedRequestInfo,
  parseWrappedRequestHeaders,
  sanitizeCurlCaptureArgs,
  sanitizeCurlHeaderArgs,
  parseCurlHeaders,
  parseVerificationFailure,
  parseWgetHeaders,
  stripWgetServerResponse,
};

export type * from "./types.js";
