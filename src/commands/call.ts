import { command, flag, positional, rest, string } from "cmd-ts";
import { loadRequiredConfig, type ResolvedConfig } from "../config/index.js";
import { formatPaymentNetworkDisplay } from "../config/schema.js";
import { formatTokenAmount } from "../output/format.js";
import {
  buildPaymentRetryHeader,
  extractPaymentResponseTransaction,
  type PaymentMetadata,
} from "../payment/signer.js";
import {
  checkPreflightBalance,
  defaultPreflightBalanceDeps,
  type PreflightBalanceDeps,
} from "../payment/balance.js";
import {
  type WrappedClient,
  type WrappedRunResult,
  runWrappedClient,
} from "./call-wrapper.js";

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

type CallArgs = {
  paymentInfo: boolean;
  tool: string;
  args: string[];
};

function getPaymentDisplayDecimals(
  paymentInfo: PaymentMetadata,
): number | undefined {
  if (paymentInfo.decimals != null) {
    return paymentInfo.decimals;
  }
  if (paymentInfo.asset === "USDC") {
    return 6;
  }
  return undefined;
}

function writeOutcomeOutput(
  outcome: Extract<
    WrappedRunResult,
    { kind: "completed" } | { kind: "streamed-completed" }
  >,
  paymentInfo?: PaymentMetadata,
) {
  if (outcome.kind === "completed" && outcome.stderr.length > 0) {
    process.stderr.write(outcome.stderr);
  }
  if (paymentInfo != null) {
    const displayDecimals = getPaymentDisplayDecimals(paymentInfo);
    const lines = [
      "Payment:",
      `  amount: ${
        displayDecimals == null
          ? paymentInfo.amount
          : formatTokenAmount(paymentInfo.amount, displayDecimals)
      }`,
      `  asset: ${paymentInfo.asset}`,
      `  network: ${paymentInfo.network}`,
    ];
    if (paymentInfo.txSignature != null) {
      lines.push(`  tx_signature: ${paymentInfo.txSignature}`);
    }
    process.stderr.write(lines.join("\n") + "\n");
  }
  if (outcome.kind === "completed" && outcome.stdout.length > 0) {
    process.stdout.write(outcome.stdout);
  }
  process.exitCode = outcome.exitCode;
}

function write402Error(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
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
    writeOutcomeOutput(retry, paidCallInfo);
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
      paymentInfo: flag({
        long: "payment-info",
        description:
          "Print paid-call metadata to stderr after a successful retry",
      }),
      tool: positional({ type: string, displayName: "curl|wget" }),
      args: rest({ displayName: "args" }),
    },
    handler: async ({ paymentInfo, tool, args: clientArgs }: CallArgs) => {
      const { resolved } = await deps.loadRequiredConfig();
      const result = await deps.runWrappedClient({
        tool,
        args: clientArgs,
      });

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
