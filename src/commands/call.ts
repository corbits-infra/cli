import {
  command,
  flag,
  option,
  optional,
  positional,
  rest,
  string,
} from "cmd-ts";
import { createInterface } from "node:readline/promises";
import {
  caip2ToChainId,
  isKnownAsset,
  lookupKnownAsset,
} from "@faremeter/info/evm";
import {
  caip2ToCluster,
  isKnownSPLToken,
  lookupKnownSPLToken,
} from "@faremeter/info/solana";
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
  formatPaymentRequirementMismatch,
  type PaymentMetadata,
  selectPaymentRequirement,
} from "../payment/signer.js";
import {
  getPaymentRequirementInspection,
  printPaymentRequirementInspection,
} from "../payment/options.js";
import { formatPaymentOptionNetwork } from "../payment/requirements.js";
import {
  checkPreflightBalance,
  defaultPreflightBalanceDeps,
  type PreflightBalanceDeps,
} from "../payment/balance.js";
import { appendHistoryRecord, createHistoryRecord } from "../history/store.js";
import { parseCurlOutputTarget } from "../process/curl.js";
import { hasFileOutputTarget } from "../process/output-target.js";
import {
  type WrappedClient,
  type WrappedRunResult,
  runWrappedClient,
} from "../process/wrapped-client.js";
import { parseWgetOutputTarget } from "../process/wget.js";
import {
  formatFlag,
  resolveOutputFormat,
  tryParseOutputFormat,
} from "../flags.js";

type CallDeps = {
  loadRequiredConfig: typeof loadRequiredConfig;
  buildPaymentRetryHeader: typeof buildPaymentRetryHeader;
  runWrappedClient: typeof runWrappedClient;
  appendHistoryRecord?: typeof appendHistoryRecord;
  canPromptForConfirmation?: () => boolean;
  confirmPayment?: (args: ConfirmPaymentArgs) => Promise<boolean>;
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

type ConfirmPaymentArgs = {
  thresholdUsd: string;
  amountUsd: string;
  assetAmount: string;
  assetDisplay: string;
  networkDisplay: string;
};

const SPENDING_LIMIT_UNSUPPORTED_SYMBOLS = new Set(["EURC"]);

function formatResponseStatus(status: number | null): string {
  return status == null ? "unknown" : `HTTP ${status}`;
}

function isSupportedUsdNormalizationAsset(args: {
  network: string;
  symbol: string;
}): boolean {
  if (SPENDING_LIMIT_UNSUPPORTED_SYMBOLS.has(args.symbol)) {
    return false;
  }

  if (args.network.startsWith("solana:")) {
    const cluster = caip2ToCluster(args.network);
    if (cluster == null || !isKnownSPLToken(args.symbol)) {
      return false;
    }

    const token = lookupKnownSPLToken(cluster, args.symbol);
    return token != null;
  }

  if (args.network.startsWith("eip155:")) {
    const chainId = caip2ToChainId(args.network);
    if (chainId == null || !isKnownAsset(args.symbol)) {
      return false;
    }

    const asset = lookupKnownAsset(chainId, args.symbol);
    return asset != null;
  }

  return false;
}

function normalizeDecimalString(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid decimal amount "${value}"`);
  }

  const [wholePart, fractionalPart = ""] = trimmed.split(".");
  const normalizedWhole = (wholePart ?? "0").replace(/^0+(?=\d)/, "");
  const normalizedFractional = fractionalPart.replace(/0+$/, "");

  return normalizedFractional.length === 0
    ? normalizedWhole
    : `${normalizedWhole}.${normalizedFractional}`;
}

function formatBaseUnitsAsDecimalString(
  amount: string,
  decimals: number,
): string {
  if (!/^\d+$/.test(amount)) {
    throw new Error(`invalid base-unit amount "${amount}"`);
  }

  const whole = amount.padStart(decimals + 1, "0");
  if (decimals === 0) {
    return normalizeDecimalString(whole);
  }

  const splitIndex = whole.length - decimals;
  return normalizeDecimalString(
    `${whole.slice(0, splitIndex)}.${whole.slice(splitIndex)}`,
  );
}

function compareNormalizedDecimalStrings(left: string, right: string): number {
  const [leftWhole, leftFractional = ""] = left.split(".");
  const [rightWhole, rightFractional = ""] = right.split(".");
  const normalizedLeftWhole = leftWhole ?? "0";
  const normalizedRightWhole = rightWhole ?? "0";
  const wholeLengthDifference =
    normalizedLeftWhole.length - normalizedRightWhole.length;
  if (wholeLengthDifference !== 0) {
    return wholeLengthDifference > 0 ? 1 : -1;
  }

  if (normalizedLeftWhole !== normalizedRightWhole) {
    return normalizedLeftWhole > normalizedRightWhole ? 1 : -1;
  }

  const fractionLength = Math.max(
    leftFractional.length,
    rightFractional.length,
  );
  const paddedLeft = leftFractional.padEnd(fractionLength, "0");
  const paddedRight = rightFractional.padEnd(fractionLength, "0");

  if (paddedLeft === paddedRight) {
    return 0;
  }

  return paddedLeft > paddedRight ? 1 : -1;
}

function normalizePaymentToUsd(
  selection: ReturnType<typeof selectPaymentRequirement>,
) {
  if (selection.kind !== "selected") {
    throw new Error("expected a selected payment requirement");
  }

  const { selected } = selection;
  if (selected.symbol == null) {
    throw new Error(
      "selected payment asset could not be normalized to USD safely",
    );
  }

  const canNormalizeSafely = isSupportedUsdNormalizationAsset({
    network: selected.network,
    symbol: selected.symbol,
  });
  if (!canNormalizeSafely) {
    throw new Error(
      "selected payment asset could not be normalized to USD safely",
    );
  }
  if (selected.decimals == null) {
    throw new Error(
      "selected payment amount is missing asset decimals, so USD normalization is not possible",
    );
  }

  return {
    amountUsd: formatBaseUnitsAsDecimalString(
      selected.amount,
      selected.decimals,
    ),
    assetAmount: formatDisplayTokenAmount({
      amount: selected.amount,
      asset: selected.symbol,
      decimals: selected.decimals,
    }),
    assetDisplay: selected.symbol,
    networkDisplay: formatPaymentOptionNetwork(selected.network),
  };
}

function canPromptForConfirmation(): boolean {
  return process.stdin.isTTY && process.stderr.isTTY;
}

async function promptForPaymentConfirmation(
  args: ConfirmPaymentArgs,
): Promise<boolean> {
  const prompt = `This call will pay $${args.amountUsd} USD (${args.assetAmount} ${args.assetDisplay} on ${args.networkDisplay}), which exceeds spending.confirmAboveUsd=$${args.thresholdUsd}. Continue? [y/N] `;
  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const answer = await readline.question(prompt);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

function formatPaymentSummary(args: {
  paymentInfo: PaymentMetadata;
  responseStatus?: ResponseStatusMetadata;
}): string {
  const { paymentInfo, responseStatus } = args;
  const assetDisplay = paymentInfo.assetSymbol ?? paymentInfo.asset;
  const amount = formatDisplayTokenAmount({
    amount: paymentInfo.amount,
    asset: assetDisplay,
    ...(paymentInfo.decimals == null ? {} : { decimals: paymentInfo.decimals }),
  });
  const parts = [
    `Payment: ${amount} ${assetDisplay} on ${paymentInfo.network}`,
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

function writeHistoryWarning(message: string): void {
  process.stderr.write(`Warning: ${message}\n`);
}

function assertSaveResponseSupported(
  tool: WrappedClient,
  clientArgs: string[],
): void {
  if (tool === "curl") {
    const outputTarget = parseCurlOutputTarget(clientArgs);
    if (hasFileOutputTarget(outputTarget.bodyPath)) {
      throw new Error(
        "--save-response cannot be used with -o/--output; remove -o/--output or omit --save-response",
      );
    }
    if (outputTarget.remoteName) {
      throw new Error(
        "--save-response cannot be used with -O/--remote-name; remove -O/--remote-name or omit --save-response",
      );
    }
    return;
  }

  const bodyPath = parseWgetOutputTarget(clientArgs).bodyPath;
  if (!hasFileOutputTarget(bodyPath)) {
    return;
  }

  throw new Error(
    "--save-response cannot be used with -O/--output-document; remove -O/--output-document or omit --save-response",
  );
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
    | "appendHistoryRecord"
    | "runWrappedClient"
    | "checkPreflightBalance"
    | "preflightBalanceDeps"
  >;
  config: ResolvedConfig;
  tool: WrappedClient;
  clientArgs: string[];
  printPaymentInfo: boolean;
  saveResponse: boolean;
  firstAttempt: Extract<WrappedRunResult, { kind: "payment-required" }>;
}): Promise<void> {
  const checkPreflight =
    args.deps.checkPreflightBalance ?? checkPreflightBalance;
  const preflightBalanceDeps =
    args.deps.preflightBalanceDeps ?? defaultPreflightBalanceDeps;
  const persistHistory = args.deps.appendHistoryRecord ?? appendHistoryRecord;

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
    streamOutput: !args.saveResponse,
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

    const responseBody =
      args.saveResponse && retry.kind === "completed"
        ? Buffer.from(retry.stdout).toString("utf8")
        : undefined;

    if (retry.exitCode !== 0) {
      return;
    }

    try {
      await persistHistory(
        createHistoryRecord({
          tool: args.tool,
          url: args.firstAttempt.url,
          responseStatus: retry.status,
          amount: payment.paymentInfo.amount,
          asset: payment.paymentInfo.asset,
          ...(payment.paymentInfo.assetSymbol == null
            ? {}
            : { assetSymbol: payment.paymentInfo.assetSymbol }),
          ...(payment.paymentInfo.decimals == null
            ? {}
            : { decimals: payment.paymentInfo.decimals }),
          network: formatPaymentNetworkDisplay(args.config.payment.network),
          walletAddress: args.config.activeWallet.address,
          walletKind: args.config.activeWallet.kind,
          ...(typeof args.firstAttempt.requestInit.method === "string"
            ? { method: args.firstAttempt.requestInit.method }
            : {}),
          ...(settledTransaction == null
            ? {}
            : { txSignature: settledTransaction }),
        }),
        responseBody == null ? undefined : { responseBody },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeHistoryWarning(
        args.saveResponse
          ? `paid call succeeded, but history and saved response could not be persisted: ${message}`
          : `paid call succeeded, but history could not be persisted: ${message}`,
      );
      return;
    }

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

async function maybeConfirmPayment(args: {
  deps: Pick<CallDeps, "canPromptForConfirmation" | "confirmPayment">;
  config: ResolvedConfig;
  yes: boolean;
  firstAttempt: Extract<WrappedRunResult, { kind: "payment-required" }>;
}): Promise<boolean> {
  const thresholdUsd = args.config.spending?.confirmAboveUsd;
  if (thresholdUsd == null) {
    return true;
  }

  let paymentRequired;
  try {
    paymentRequired = await extractPaymentRequiredResponse(
      args.firstAttempt.response.clone(),
      args.firstAttempt.url,
    );
  } catch (err) {
    write402Error(err instanceof Error ? err.message : String(err));
    return false;
  }

  const selection = selectPaymentRequirement({
    accepts: paymentRequired.accepts,
    config: args.config,
  });
  if (selection.kind !== "selected") {
    write402Error(formatPaymentRequirementMismatch(args.config, selection));
    return false;
  }

  if (
    selection.selected.symbol != null &&
    SPENDING_LIMIT_UNSUPPORTED_SYMBOLS.has(selection.selected.symbol)
  ) {
    return true;
  }

  let normalizedPayment;
  try {
    normalizedPayment = normalizePaymentToUsd(selection);
  } catch (err) {
    write402Error(
      `${err instanceof Error ? err.message : String(err)}; use --inspect to review the payment challenge before retrying`,
    );
    return false;
  }

  if (
    compareNormalizedDecimalStrings(
      normalizeDecimalString(normalizedPayment.amountUsd),
      normalizeDecimalString(thresholdUsd),
    ) <= 0
  ) {
    return true;
  }

  if (args.yes) {
    return true;
  }

  const promptAllowed =
    args.deps.canPromptForConfirmation ?? canPromptForConfirmation;
  if (!promptAllowed()) {
    write402Error(
      `payment of $${normalizedPayment.amountUsd} exceeds spending.confirmAboveUsd=$${thresholdUsd}, but confirmation requires an interactive terminal; rerun with --yes to continue`,
    );
    return false;
  }

  const confirmPayment =
    args.deps.confirmPayment ?? promptForPaymentConfirmation;
  const approved = await confirmPayment({
    thresholdUsd,
    amountUsd: normalizedPayment.amountUsd,
    assetAmount: normalizedPayment.assetAmount,
    assetDisplay: normalizedPayment.assetDisplay,
    networkDisplay: normalizedPayment.networkDisplay,
  });

  if (approved) {
    return true;
  }

  write402Error("payment cancelled");
  return false;
}

export function createCallCommand(deps: CallDeps) {
  return command({
    name: "call",
    description: "Run curl or wget against an x402-gated endpoint",
    args: {
      inspect: flag({
        long: "inspect",
        description:
          "Probe the endpoint, print parsed x402 requirements, and exit without paying",
      }),
      paymentInfo: flag({
        long: "payment-info",
        description:
          "Print paid-call metadata and response status to stderr after a paid retry",
      }),
      saveResponse: flag({
        long: "save-response",
        description:
          "Save the successful paid response body in local history when it is not streamed",
      }),
      yes: flag({
        long: "yes",
        description:
          "Skip interactive payment confirmation when a call exceeds spending.confirmAboveUsd",
      }),
      asset: option({
        type: optional(string),
        long: "asset",
        description:
          "Preferred payment asset symbol for paid retries on the active payment network",
      }),
      format: formatFlag,
      tool: positional({ type: string, displayName: "curl|wget" }),
      args: rest({ displayName: "args" }),
    },
    handler: async ({
      inspect,
      paymentInfo,
      saveResponse,
      yes,
      asset,
      format: formatArg,
      tool,
      args: clientArgs,
    }) => {
      if (inspect && asset != null) {
        write402Error("--asset cannot be used with --inspect");
        return;
      }

      const inlineFormat = inspect
        ? extractInlineFormatArg(clientArgs)
        : { args: clientArgs };
      const result = await deps.runWrappedClient({
        tool,
        args: inlineFormat.args,
      });

      if (inspect) {
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
        printPaymentRequirementInspection(
          format,
          getPaymentRequirementInspection(paymentRequired),
        );
        return;
      }

      const { resolved } = await deps.loadRequiredConfig();
      const activeConfig =
        asset == null
          ? resolved
          : {
              ...resolved,
              payment: {
                ...resolved.payment,
                asset,
              },
            };

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

      if (saveResponse) {
        try {
          assertSaveResponseSupported(result.tool, clientArgs);
        } catch (err) {
          write402Error(err instanceof Error ? err.message : String(err));
          return;
        }
      }

      if (
        !(await maybeConfirmPayment({
          deps: {
            canPromptForConfirmation:
              deps.canPromptForConfirmation ?? canPromptForConfirmation,
            confirmPayment: deps.confirmPayment ?? promptForPaymentConfirmation,
          },
          config: activeConfig,
          yes,
          firstAttempt: result,
        }))
      ) {
        return;
      }

      await handle402Retry({
        deps: {
          buildPaymentRetryHeader: deps.buildPaymentRetryHeader,
          runWrappedClient: deps.runWrappedClient,
          appendHistoryRecord: deps.appendHistoryRecord ?? appendHistoryRecord,
          checkPreflightBalance:
            deps.checkPreflightBalance ?? checkPreflightBalance,
          preflightBalanceDeps:
            deps.preflightBalanceDeps ?? defaultPreflightBalanceDeps,
        },
        config: activeConfig,
        tool: result.tool,
        clientArgs,
        printPaymentInfo: paymentInfo,
        saveResponse,
        firstAttempt: result,
      });
    },
  });
}

export const call = createCallCommand({
  loadRequiredConfig,
  buildPaymentRetryHeader,
  runWrappedClient,
  appendHistoryRecord,
  checkPreflightBalance,
  preflightBalanceDeps: defaultPreflightBalanceDeps,
});
