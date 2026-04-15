import { command, positional, rest, string } from "cmd-ts";
import { loadRequiredConfig } from "../config/index.js";
import { buildPaymentRetryHeader } from "../payment/header.js";
import {
  type WrappedClient,
  type WrappedRunResult,
  runWrappedClient,
} from "./call-wrapper.js";

type CallDeps = {
  loadRequiredConfig: typeof loadRequiredConfig;
  buildPaymentRetryHeader: typeof buildPaymentRetryHeader;
  runWrappedClient: typeof runWrappedClient;
};

type CallArgs = {
  tool: string;
  args: string[];
};

function writeOutcomeOutput(
  outcome: Extract<WrappedRunResult, { kind: "completed" }>,
) {
  if (outcome.stderr.length > 0) {
    process.stderr.write(outcome.stderr);
  }
  if (outcome.stdout.length > 0) {
    process.stdout.write(outcome.stdout);
  }
  process.exitCode = outcome.exitCode;
}

function write402Error(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

async function handle402Retry(args: {
  deps: CallDeps;
  tool: WrappedClient;
  clientArgs: string[];
  firstAttempt: Extract<WrappedRunResult, { kind: "payment-required" }>;
}): Promise<void> {
  const loaded = await args.deps.loadRequiredConfig();
  const header = await args.deps.buildPaymentRetryHeader({
    config: loaded.resolved,
    url: args.firstAttempt.url,
    response: args.firstAttempt.response,
    requestInit: args.firstAttempt.requestInit,
  });
  const retry = await args.deps.runWrappedClient({
    tool: args.tool,
    args: args.clientArgs,
    extraHeader: header,
  });

  if (retry.kind === "completed") {
    writeOutcomeOutput(retry);
    return;
  }

  if (retry.kind === "payment-rejected") {
    write402Error(retry.reason);
    return;
  }

  write402Error(
    "server still returned 402 after payment or did not provide a supported x402 challenge",
  );
}

export function createCallCommand(deps: CallDeps) {
  return command({
    name: "call",
    description: "Run curl or wget against an x402-gated endpoint",
    args: {
      tool: positional({ type: string, displayName: "curl|wget" }),
      args: rest({ displayName: "args" }),
    },
    handler: async ({ tool, args: clientArgs }: CallArgs) => {
      await deps.loadRequiredConfig();
      const result = await deps.runWrappedClient({
        tool,
        args: clientArgs,
      });

      if (result.kind === "completed") {
        writeOutcomeOutput(result);
        return;
      }

      if (result.kind === "payment-rejected") {
        write402Error(result.reason);
        return;
      }

      await handle402Retry({
        deps,
        tool: result.tool,
        clientArgs,
        firstAttempt: result,
      });
    },
  });
}

export const call = createCallCommand({
  loadRequiredConfig,
  buildPaymentRetryHeader,
  runWrappedClient,
});
