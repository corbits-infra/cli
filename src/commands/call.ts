import { command, flag, positional, rest, string } from "cmd-ts";
import { loadRequiredConfig, type ResolvedConfig } from "../config/index.js";
import { formatPaymentNetworkDisplay } from "../config/schema.js";
import {
  formatDisplayTokenAmount,
  type OutputFormat,
} from "../output/format.js";
import {
  buildPaymentRetryHeader,
  extractPaymentRequiredResponse,
  extractPaymentResponseTransaction,
  type PaymentMetadata,
} from "../payment/signer.js";
import { getPaymentOptions, printPaymentOptions } from "../payment/options.js";
import {
  checkPreflightBalance,
  defaultPreflightBalanceDeps,
  type PreflightBalanceDeps,
} from "../payment/balance.js";
import {
  type WrappedClient,
  type WrappedRunResult,
  runWrappedClient,
} from "../process/wrapped-client.js";
import {
  formatFlag,
  resolveOutputFormat,
  tryParseOutputFormat,
} from "../flags.js";

type CallDeps = {
  loadRequiredConfig: typeof loadRequiredConfig;
  buildPaymentRetryHeader: typeof buildPaymentRetryHeader;
  runWrappedClient: typeof runWrappedClient;
  checkPreflightBalance?: (
    config: ResolvedConfig,
    firstAttempt: Extract<WrappedRunResult, { kind: "payment-required" }>,
    deps: PreflightBalanceDeps,
  ) => Promise<void>;
  preflightBalanceDeps?: PreflightBalanceDeps;
};

type ResponseStatusMetadata = {
  status: number | null;
};

function formatResponseStatus(status: number | null): string {
  return status == null ? "unknown" : `HTTP ${status}`;
}

function formatPaymentSummary(args: {
  paymentInfo: PaymentMetadata;
  responseStatus?: ResponseStatusMetadata;
}): string {
  const { paymentInfo, responseStatus } = args;
  const amount = formatDisplayTokenAmount({
    amount: paymentInfo.amount,
    asset: paymentInfo.asset,
    ...(paymentInfo.decimals == null ? {} : { decimals: paymentInfo.decimals }),
  });
  const parts = [
    `Payment: ${amount} ${paymentInfo.asset} on ${paymentInfo.network}`,
  ];

  if (paymentInfo.txSignature != null) {
    parts.push(`tx ${paymentInfo.txSignature}`);
  }

  if (responseStatus != null) {
    parts.push(`response ${formatResponseStatus(responseStatus.status)}`);
  }

  return parts.join(", ");
}

function writeOutcomeOutput(
  outcome: Extract<
    WrappedRunResult,
    { kind: "completed" } | { kind: "streamed-completed" }
  >,
  paymentInfo?: PaymentMetadata,
  responseStatus?: ResponseStatusMetadata,
) {
  const completedStderr =
    outcome.kind === "completed" ? outcome.stderr : undefined;
  const completedStdout =
    outcome.kind === "completed" ? outcome.stdout : undefined;

  if (outcome.kind === "completed" && outcome.stderr.length > 0) {
    process.stderr.write(outcome.stderr);
  }
  if (outcome.kind === "completed" && outcome.stdout.length > 0) {
    process.stdout.write(outcome.stdout);
  }
  if (paymentInfo != null) {
    const summary = formatPaymentSummary({
      paymentInfo,
      ...(responseStatus == null ? {} : { responseStatus }),
    });
    const separator =
      outcome.kind === "streamed-completed"
        ? "\n"
        : completedStdout != null &&
            completedStdout.length > 0 &&
            completedStdout[completedStdout.length - 1] !== 0x0a
          ? "\n"
          : completedStderr != null &&
              completedStderr.length > 0 &&
              completedStderr[completedStderr.length - 1] !== 0x0a
            ? "\n"
            : "";
    process.stderr.write(separator + summary + "\n");
  }
  process.exitCode = outcome.exitCode;
}

function write402Error(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

function extractInlineFormatArg(args: string[]): {
  args: string[];
  format?: OutputFormat;
} {
  const nextArgs: string[] = [];
  let format: OutputFormat | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "-f" || arg === "--format") {
      const candidate = args[index + 1];
      const parsedFormat =
        candidate == null ? undefined : tryParseOutputFormat(candidate);
      if (parsedFormat != null) {
        format = parsedFormat;
        index += 1;
        continue;
      }
    }

    if (arg.startsWith("--format=")) {
      const candidate = arg.slice("--format=".length);
      const parsedFormat = tryParseOutputFormat(candidate);
      if (parsedFormat != null) {
        format = parsedFormat;
        continue;
      }
    }

    nextArgs.push(arg);
  }

  return format == null ? { args: nextArgs } : { args: nextArgs, format };
}

async function handle402Retry(args: {
  deps: Pick<
    CallDeps,
    | "buildPaymentRetryHeader"
    | "runWrappedClient"
    | "checkPreflightBalance"
    | "preflightBalanceDeps"
  >;
  config: ResolvedConfig;
  tool: WrappedClient;
  clientArgs: string[];
  printPaymentInfo: boolean;
  firstAttempt: Extract<WrappedRunResult, { kind: "payment-required" }>;
}): Promise<void> {
  const checkPreflight =
    args.deps.checkPreflightBalance ?? checkPreflightBalance;
  const preflightBalanceDeps =
    args.deps.preflightBalanceDeps ?? defaultPreflightBalanceDeps;

  try {
    await checkPreflight(args.config, args.firstAttempt, preflightBalanceDeps);
  } catch (err) {
    write402Error(err instanceof Error ? err.message : String(err));
    return;
  }

  const payment = await args.deps.buildPaymentRetryHeader({
    config: args.config,
    url: args.firstAttempt.url,
    response: args.firstAttempt.response,
    requestInit: args.firstAttempt.requestInit,
  });
  const retry = await args.deps.runWrappedClient({
    tool: args.tool,
    args: args.clientArgs,
    extraHeader: payment.header,
    streamOutput: true,
  });
  if (retry.kind === "completed" || retry.kind === "streamed-completed") {
    const settledTransaction = extractPaymentResponseTransaction(retry.headers);
    const paidCallInfo = args.printPaymentInfo
      ? {
          ...payment.paymentInfo,
          asset: args.config.payment.asset,
          network: formatPaymentNetworkDisplay(args.config.payment.network),
          ...(settledTransaction == null
            ? {}
            : { txSignature: settledTransaction }),
        }
      : undefined;
    const responseStatus = args.printPaymentInfo
      ? { status: retry.status }
      : undefined;
    writeOutcomeOutput(retry, paidCallInfo, responseStatus);
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
      listPaymentOptions: flag({
        long: "list-payment-options",
        description:
          "Probe the endpoint, print accepted x402 payment options, and exit without paying",
      }),
      paymentInfo: flag({
        long: "payment-info",
        description:
          "Print paid-call metadata and response status to stderr after a paid retry",
      }),
      format: formatFlag,
      tool: positional({ type: string, displayName: "curl|wget" }),
      args: rest({ displayName: "args" }),
    },
    handler: async ({
      listPaymentOptions,
      paymentInfo,
      format: formatArg,
      tool,
      args: clientArgs,
    }) => {
      const inlineFormat = listPaymentOptions
        ? extractInlineFormatArg(clientArgs)
        : { args: clientArgs };
      const result = await deps.runWrappedClient({
        tool,
        args: inlineFormat.args,
      });

      if (listPaymentOptions) {
        if (result.kind !== "payment-required") {
          write402Error("server did not return an x402 payment challenge");
          return;
        }

        const format = await resolveOutputFormat(
          formatArg ?? inlineFormat.format,
        );
        const paymentRequired = await extractPaymentRequiredResponse(
          result.response,
          result.url,
        );
        printPaymentOptions(format, getPaymentOptions(paymentRequired.accepts));
        return;
      }

      const { resolved } = await deps.loadRequiredConfig();

      if (result.kind === "completed") {
        writeOutcomeOutput(result);
        return;
      }

      if (result.kind === "streamed-completed") {
        writeOutcomeOutput(result);
        return;
      }

      if (result.kind === "payment-rejected") {
        write402Error(result.reason);
        return;
      }

      await handle402Retry({
        deps: {
          buildPaymentRetryHeader: deps.buildPaymentRetryHeader,
          runWrappedClient: deps.runWrappedClient,
          checkPreflightBalance:
            deps.checkPreflightBalance ?? checkPreflightBalance,
          preflightBalanceDeps:
            deps.preflightBalanceDeps ?? defaultPreflightBalanceDeps,
        },
        config: resolved,
        tool: result.tool,
        clientArgs,
        printPaymentInfo: paymentInfo,
        firstAttempt: result,
      });
    },
  });
}

export const call = createCallCommand({
  loadRequiredConfig,
  buildPaymentRetryHeader,
  runWrappedClient,
  checkPreflightBalance,
  preflightBalanceDeps: defaultPreflightBalanceDeps,
});
