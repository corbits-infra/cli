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
  brandStrong,
  formatKeyValue,
  formatProgressNote,
  formatPromptChoice,
  formatSectionTitle,
  formatStatus,
  isBrandOutputEnabled,
} from "../output/brand.js";
import {
  formatCompactDisplayTokenAmount,
  formatJSON,
  formatDisplayTokenAmount,
  formatYaml,
  type OutputFormat,
} from "../output/format.js";
import {
  buildPaymentRetryHeader,
  extractPaymentRequiredResponse,
  extractPaymentResponseTransaction,
  type PaymentMetadata,
  type RetryHeader,
} from "../payment/signer.js";
import {
  buildFlexPaymentRetryHeader,
  getFlexSessionViews,
  type FlexConfirmArgs,
  type FlexPaymentMetadata,
} from "../payment/flex-solana.js";
import {
  type FlexRequirementDetails,
  hasFlexRequirements,
  isFlexScheme,
  selectFlexRequirement,
} from "../payment/flex.js";
import {
  formatPaymentAttemptIssues,
  resolvePaymentAttempt,
  type PaymentAttemptResolution,
} from "../payment/resolve.js";
import {
  getPaymentRequirementInspection,
  printPaymentRequirementInspection,
  type PaymentRequirementInspection,
} from "../payment/options.js";
import {
  formatPaymentOptionNetwork,
  type PaymentRequirementDetails,
} from "../payment/requirements.js";
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
  buildFlexPaymentRetryHeader?: typeof buildFlexPaymentRetryHeader;
  runWrappedClient: typeof runWrappedClient;
  appendHistoryRecord?: typeof appendHistoryRecord;
  canPromptForConfirmation?: () => boolean;
  confirmPayment?: (args: ConfirmPaymentArgs) => Promise<boolean>;
  checkPreflightBalance?: (
    config: ResolvedConfig,
    firstAttempt: Extract<WrappedRunResult, { kind: "payment-required" }>,
    deps: PreflightBalanceDeps,
    requirement?: PaymentRequirementDetails,
  ) => Promise<void>;
  preflightBalanceDeps?: PreflightBalanceDeps;
};

type ResponseStatusMetadata = {
  status: number | null;
};

type PaymentDisplayMetadata = PaymentMetadata & {
  txSignature?: string;
  flexSessionId?: string;
  flexEscrow?: string;
};

type PaymentInfoOutput = {
  payment: {
    amount: string;
    asset: string;
    network: string;
    decimals?: number;
    txSignature?: string;
    flexSessionId?: string;
    flexEscrow?: string;
  };
  response?: {
    status: number | null;
  };
};

type ConfirmPaymentArgs = {
  thresholdUsd: string;
  amountUsd: string;
  assetAmount: string;
  assetDisplay: string;
  networkDisplay: string;
};

type HistoryPaymentInfo = {
  amount: string;
  asset: string;
  assetSymbol?: string;
  decimals?: number;
};

export function isSelectedFlexInspectionRequirement(
  requirement: PaymentRequirementInspection["requirements"][number],
  selected: FlexRequirementDetails,
): boolean {
  const facilitator = requirement.extra?.facilitator;
  return (
    isFlexScheme(requirement.scheme) &&
    requirement.network === formatPaymentOptionNetwork(selected.network) &&
    requirement.assetAddress === selected.asset &&
    typeof facilitator === "string" &&
    facilitator === selected.facilitator
  );
}

const USD_NORMALIZATION_STABLECOIN_SYMBOLS = new Set([
  "USDC",
  "PYUSD",
  "USDT",
  "USDG",
  "USD1",
  "USX",
  "CASH",
  "JupUSD",
  "USDS",
  "USDtb",
  "USDu",
  "USDGO",
  "FDUSD",
]);

function formatResponseStatus(status: number | null): string {
  return status == null ? "unknown" : `HTTP ${status}`;
}

function isSupportedUsdNormalizationAsset(args: {
  network: string;
  symbol: string;
}): boolean {
  if (!USD_NORMALIZATION_STABLECOIN_SYMBOLS.has(args.symbol)) {
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

function normalizePaymentToUsd(selected: PaymentRequirementDetails) {
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
  const prompt = formatPaymentConfirmationPrompt(args);
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

function formatPaymentConfirmationPrompt(args: ConfirmPaymentArgs): string {
  if (!isBrandOutputEnabled(process.stderr)) {
    return `This call will pay $${args.amountUsd} USD (${args.assetAmount} ${args.assetDisplay} on ${args.networkDisplay}), which exceeds spending.confirmAboveUsd=$${args.thresholdUsd}. Continue? ${formatPromptChoice(process.stderr)} `;
  }

  return [
    formatSectionTitle("Payment approval", process.stderr),
    formatKeyValue("USD amount", `$${args.amountUsd}`, process.stderr),
    formatKeyValue(
      "Asset amount",
      `${args.assetAmount} ${args.assetDisplay}`,
      process.stderr,
    ),
    formatKeyValue("Network", args.networkDisplay, process.stderr),
    formatKeyValue("Confirm above", `$${args.thresholdUsd}`, process.stderr),
    `Continue? ${formatPromptChoice(process.stderr)} `,
  ].join("\n");
}

function formatPaymentSummary(args: {
  paymentInfo: PaymentDisplayMetadata;
  responseStatus?: ResponseStatusMetadata;
}): string {
  const { paymentInfo, responseStatus } = args;
  const assetDisplay = paymentInfo.assetSymbol ?? paymentInfo.asset;
  const amount = formatDisplayTokenAmount({
    amount: paymentInfo.amount,
    asset: assetDisplay,
    ...(paymentInfo.decimals == null ? {} : { decimals: paymentInfo.decimals }),
  });

  if (isBrandOutputEnabled(process.stderr)) {
    return [
      formatSectionTitle("Payment complete", process.stderr),
      formatKeyValue(
        "Amount",
        brandStrong(`${amount} ${assetDisplay}`, process.stderr),
        process.stderr,
      ),
      formatKeyValue("Network", paymentInfo.network, process.stderr),
      ...(paymentInfo.txSignature == null
        ? []
        : [formatKeyValue("Tx", paymentInfo.txSignature, process.stderr)]),
      ...(paymentInfo.flexSessionId == null
        ? []
        : [
            formatKeyValue(
              "Flex session",
              paymentInfo.flexSessionId,
              process.stderr,
            ),
          ]),
      ...(responseStatus == null
        ? []
        : [
            formatKeyValue(
              "Response",
              formatStatus(
                formatResponseStatus(responseStatus.status),
                responseStatus.status != null &&
                  responseStatus.status >= 200 &&
                  responseStatus.status < 300
                  ? "success"
                  : "danger",
                process.stderr,
              ),
              process.stderr,
            ),
          ]),
    ].join("\n");
  }

  const parts = [
    `Payment: ${amount} ${assetDisplay} on ${paymentInfo.network}`,
  ];

  if (paymentInfo.txSignature != null) {
    parts.push(`tx ${paymentInfo.txSignature}`);
  }
  if (paymentInfo.flexSessionId != null) {
    parts.push(`flex session ${paymentInfo.flexSessionId}`);
  }

  if (responseStatus != null) {
    parts.push(`response ${formatResponseStatus(responseStatus.status)}`);
  }

  return parts.join(", ");
}

function formatPaymentInfoOutput(args: {
  paymentInfo: PaymentDisplayMetadata;
  responseStatus?: ResponseStatusMetadata;
}): PaymentInfoOutput {
  const { paymentInfo, responseStatus } = args;
  const assetDisplay = paymentInfo.assetSymbol ?? paymentInfo.asset;
  return {
    payment: {
      amount: formatDisplayTokenAmount({
        amount: paymentInfo.amount,
        asset: assetDisplay,
        ...(paymentInfo.decimals == null
          ? {}
          : { decimals: paymentInfo.decimals }),
      }),
      asset: assetDisplay,
      network: paymentInfo.network,
      ...(paymentInfo.decimals == null
        ? {}
        : { decimals: paymentInfo.decimals }),
      ...(paymentInfo.txSignature == null
        ? {}
        : { txSignature: paymentInfo.txSignature }),
      ...(paymentInfo.flexSessionId == null
        ? {}
        : { flexSessionId: paymentInfo.flexSessionId }),
      ...(paymentInfo.flexEscrow == null
        ? {}
        : { flexEscrow: paymentInfo.flexEscrow }),
    },
    ...(responseStatus == null
      ? {}
      : {
          response: {
            status: responseStatus.status,
          },
        }),
  };
}

function formatPaymentInfo(args: {
  format: OutputFormat;
  paymentInfo: PaymentDisplayMetadata;
  responseStatus?: ResponseStatusMetadata;
}): string {
  if (args.format === "json") {
    return formatJSON(formatPaymentInfoOutput(args));
  }

  if (args.format === "yaml") {
    return formatYaml(formatPaymentInfoOutput(args)).trimEnd();
  }

  return formatPaymentSummary(args);
}

function writeOutcomeOutput(
  outcome: Extract<
    WrappedRunResult,
    { kind: "completed" } | { kind: "streamed-completed" }
  >,
  paymentInfo?: PaymentDisplayMetadata,
  responseStatus?: ResponseStatusMetadata,
  paymentInfoFormat: OutputFormat = "table",
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
    const summary = formatPaymentInfo({
      format: paymentInfoFormat,
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

async function persistPaidCallHistory(args: {
  persistHistory: typeof appendHistoryRecord;
  config: ResolvedConfig;
  tool: WrappedClient;
  firstAttempt: Extract<WrappedRunResult, { kind: "payment-required" }>;
  retry: Extract<
    WrappedRunResult,
    { kind: "completed" } | { kind: "streamed-completed" }
  >;
  paymentInfo: HistoryPaymentInfo;
  saveResponse: boolean;
  txSignature?: string;
}): Promise<void> {
  const responseBody =
    args.saveResponse && args.retry.kind === "completed"
      ? args.retry.stdout
      : undefined;

  await args.persistHistory(
    createHistoryRecord({
      tool: args.tool,
      url: args.firstAttempt.url,
      responseStatus: args.retry.status,
      amount: args.paymentInfo.amount,
      asset: args.paymentInfo.asset,
      ...(args.paymentInfo.assetSymbol == null
        ? {}
        : { assetSymbol: args.paymentInfo.assetSymbol }),
      ...(args.paymentInfo.decimals == null
        ? {}
        : { decimals: args.paymentInfo.decimals }),
      network: formatPaymentNetworkDisplay(args.config.payment.network),
      walletAddress: args.config.activeWallet.address,
      walletKind: args.config.activeWallet.kind,
      ...(typeof args.firstAttempt.requestInit.method === "string"
        ? { method: args.firstAttempt.requestInit.method }
        : {}),
      ...(args.txSignature == null ? {} : { txSignature: args.txSignature }),
    }),
    responseBody == null ? undefined : { responseBody },
  );
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

async function promptForFlexConfirmation(
  args: FlexConfirmArgs,
): Promise<boolean> {
  const asset = args.requirement.symbol ?? args.requirement.asset;
  const amount = `${formatCompactDisplayTokenAmount({
    amount: args.amount,
    asset,
    ...(args.requirement.decimals == null
      ? {}
      : { decimals: args.requirement.decimals }),
  })} ${asset}`;
  const prompt = formatFlexConfirmationPrompt(args, amount);
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

function formatFlexConfirmationPrompt(
  args: FlexConfirmArgs,
  amount: string,
): string {
  if (!isBrandOutputEnabled(process.stderr)) {
    return args.kind === "create"
      ? `Create a reusable Flex session and deposit ${amount}? ${formatPromptChoice(process.stderr)} `
      : `Top up Flex session ${args.session.id} by ${amount}? ${formatPromptChoice(process.stderr)} `;
  }

  const heading =
    args.kind === "create" ? "Create Flex session" : "Top up Flex session";
  return [
    formatSectionTitle(heading, process.stderr),
    ...(args.kind === "topup"
      ? [formatKeyValue("Session", args.session.id, process.stderr)]
      : []),
    formatKeyValue("Amount", amount, process.stderr),
    `Continue? ${formatPromptChoice(process.stderr)} `,
  ].join("\n");
}

type PaidRetryContext = {
  config: ResolvedConfig;
  tool: WrappedClient;
  clientArgs: string[];
  printPaymentInfo: boolean;
  paymentInfoFormat: OutputFormat;
  saveResponse: boolean;
  firstAttempt: Extract<WrappedRunResult, { kind: "payment-required" }>;
};

type PaidRetryHeader<TPaymentInfo> = {
  header: RetryHeader;
  paymentInfo: TPaymentInfo;
};

type CompletedPaidRetry = Extract<
  WrappedRunResult,
  { kind: "completed" } | { kind: "streamed-completed" }
>;

type PreparedPaidRetry<TPaymentInfo> = {
  preflight: (() => Promise<void>) | null;
  confirm: (() => Promise<boolean>) | null;
  buildHeader: () => Promise<PaidRetryHeader<TPaymentInfo>>;
  getOutputPaymentInfo: (
    payment: PaidRetryHeader<TPaymentInfo>,
    retry: CompletedPaidRetry,
  ) => PaymentDisplayMetadata;
  getHistoryPayment: (
    payment: PaidRetryHeader<TPaymentInfo>,
    retry: CompletedPaidRetry,
  ) => { paymentInfo: HistoryPaymentInfo; txSignature?: string } | null;
  retryFailureMessage: string;
};

async function runPaidRetry<TPaymentInfo>(args: {
  deps: Pick<CallDeps, "appendHistoryRecord" | "runWrappedClient">;
  context: PaidRetryContext;
  prepared: PreparedPaidRetry<TPaymentInfo>;
}): Promise<void> {
  const { context, prepared } = args;
  const persistHistory = args.deps.appendHistoryRecord ?? appendHistoryRecord;

  try {
    await prepared.preflight?.();
  } catch (err) {
    write402Error(err instanceof Error ? err.message : String(err));
    return;
  }

  if (prepared.confirm != null && !(await prepared.confirm())) {
    return;
  }

  let payment: PaidRetryHeader<TPaymentInfo>;
  try {
    payment = await prepared.buildHeader();
  } catch (err) {
    write402Error(err instanceof Error ? err.message : String(err));
    return;
  }

  const retry = await args.deps.runWrappedClient({
    tool: context.tool,
    args: context.clientArgs,
    extraHeader: payment.header,
    streamOutput: !context.saveResponse,
  });
  if (retry.kind === "completed" || retry.kind === "streamed-completed") {
    const paidCallInfo = context.printPaymentInfo
      ? prepared.getOutputPaymentInfo(payment, retry)
      : undefined;
    const responseStatus = context.printPaymentInfo
      ? { status: retry.status }
      : undefined;
    writeOutcomeOutput(
      retry,
      paidCallInfo,
      responseStatus,
      context.paymentInfoFormat,
    );

    if (retry.exitCode !== 0) {
      return;
    }

    const historyPayment = prepared.getHistoryPayment(payment, retry);
    if (historyPayment != null) {
      try {
        await persistPaidCallHistory({
          persistHistory,
          config: context.config,
          tool: context.tool,
          firstAttempt: context.firstAttempt,
          retry,
          paymentInfo: historyPayment.paymentInfo,
          saveResponse: context.saveResponse,
          ...(historyPayment.txSignature == null
            ? {}
            : { txSignature: historyPayment.txSignature }),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeHistoryWarning(
          context.saveResponse
            ? `paid call succeeded, but history and saved response could not be persisted: ${message}`
            : `paid call succeeded, but history could not be persisted: ${message}`,
        );
      }
    }
    return;
  }

  if (retry.kind === "payment-rejected") {
    write402Error(retry.reason);
    return;
  }

  write402Error(prepared.retryFailureMessage);
}

function prepareExactPaidRetry(args: {
  deps: Pick<
    CallDeps,
    | "buildPaymentRetryHeader"
    | "checkPreflightBalance"
    | "preflightBalanceDeps"
    | "canPromptForConfirmation"
    | "confirmPayment"
  >;
  context: PaidRetryContext;
  yes: boolean;
  requirement: PaymentRequirementDetails;
}): PreparedPaidRetry<PaymentMetadata> {
  const checkPreflight =
    args.deps.checkPreflightBalance ?? checkPreflightBalance;
  const preflightBalanceDeps =
    args.deps.preflightBalanceDeps ?? defaultPreflightBalanceDeps;

  return {
    preflight: () =>
      checkPreflight(
        args.context.config,
        args.context.firstAttempt,
        preflightBalanceDeps,
        args.requirement,
      ),
    confirm: () =>
      maybeConfirmPayment({
        deps: {
          canPromptForConfirmation:
            args.deps.canPromptForConfirmation ?? canPromptForConfirmation,
          confirmPayment:
            args.deps.confirmPayment ?? promptForPaymentConfirmation,
        },
        config: args.context.config,
        yes: args.yes,
        requirement: args.requirement,
      }),
    buildHeader: () =>
      args.deps.buildPaymentRetryHeader({
        config: args.context.config,
        url: args.context.firstAttempt.url,
        response: args.context.firstAttempt.response,
        requestInit: args.context.firstAttempt.requestInit,
        requirement: args.requirement,
      }),
    getOutputPaymentInfo: (payment, retry) => {
      const settledTransaction = extractPaymentResponseTransaction(
        retry.headers,
      );
      return {
        ...payment.paymentInfo,
        asset: args.context.config.payment.asset,
        network: formatPaymentNetworkDisplay(
          args.context.config.payment.network,
        ),
        ...(settledTransaction == null
          ? {}
          : { txSignature: settledTransaction }),
      };
    },
    getHistoryPayment: (payment, retry) => {
      const settledTransaction = extractPaymentResponseTransaction(
        retry.headers,
      );
      return {
        paymentInfo: payment.paymentInfo,
        ...(settledTransaction == null
          ? {}
          : { txSignature: settledTransaction }),
      };
    },
    retryFailureMessage:
      "server still returned 402 after payment or did not provide a supported x402 challenge",
  };
}

function prepareFlexPaidRetry(args: {
  deps: Pick<CallDeps, "buildFlexPaymentRetryHeader">;
  context: PaidRetryContext;
  flexSession?: string;
  allowCreateOrTopup: boolean;
  confirm?: (args: FlexConfirmArgs) => Promise<boolean>;
}): PreparedPaidRetry<FlexPaymentMetadata> {
  const buildFlexRetry =
    args.deps.buildFlexPaymentRetryHeader ?? buildFlexPaymentRetryHeader;

  return {
    preflight: null,
    confirm: null,
    buildHeader: async () => {
      const payment = await buildFlexRetry({
        config: args.context.config,
        url: args.context.firstAttempt.url,
        response: args.context.firstAttempt.response,
        requestInit: args.context.firstAttempt.requestInit,
        ...(args.flexSession == null ? {} : { sessionId: args.flexSession }),
        allowCreateOrTopup: args.allowCreateOrTopup,
        ...(args.confirm == null ? {} : { confirm: args.confirm }),
        note: (message) =>
          process.stderr.write(`${formatProgressNote(message)}\n`),
      });
      return payment;
    },
    getOutputPaymentInfo: (payment) => {
      const { paymentInfo } = payment;
      return {
        ...paymentInfo,
        network: formatPaymentNetworkDisplay(
          args.context.config.payment.network,
        ),
        flexSessionId: paymentInfo.sessionId,
        flexEscrow: paymentInfo.escrow,
      };
    },
    getHistoryPayment: (payment) => {
      const { amount, asset, assetSymbol, decimals } = payment.paymentInfo;
      return {
        paymentInfo: {
          amount,
          asset,
          ...(assetSymbol == null ? {} : { assetSymbol }),
          ...(decimals == null ? {} : { decimals }),
        },
      };
    },
    retryFailureMessage:
      "server still returned 402 after Flex authorization or did not accept the session payment",
  };
}

async function maybeConfirmPayment(args: {
  deps: Pick<CallDeps, "canPromptForConfirmation" | "confirmPayment">;
  config: ResolvedConfig;
  yes: boolean;
  requirement: PaymentRequirementDetails;
}): Promise<boolean> {
  const thresholdUsd = args.config.spending?.confirmAboveUsd;
  if (thresholdUsd == null) {
    return true;
  }

  let normalizedPayment;
  try {
    normalizedPayment = normalizePaymentToUsd(args.requirement);
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
      flexSession: option({
        type: optional(string),
        long: "flex-session",
        description: "Use a specific stored Flex session id",
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
      flexSession,
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
        const inspection = getPaymentRequirementInspection(paymentRequired);
        if (hasFlexRequirements(paymentRequired.accepts)) {
          try {
            const { resolved } = await deps.loadRequiredConfig();
            const selection = selectFlexRequirement({
              accepts: paymentRequired.accepts,
              config: resolved,
            });
            if (selection.kind === "selected") {
              const views = await getFlexSessionViews({
                config: resolved,
                requirement: selection.selected,
              });
              for (const requirement of inspection.requirements) {
                if (
                  !isSelectedFlexInspectionRequirement(
                    requirement,
                    selection.selected,
                  )
                ) {
                  continue;
                }
                requirement.flex = {
                  facilitator: selection.selected.facilitator,
                  matchingSessions: views.map((view) => ({
                    id: view.session.id,
                    status: view.session.status,
                    escrow: view.session.escrow,
                    ...(view.availableAmount == null
                      ? {}
                      : { onChainAvailableAmount: view.availableAmount }),
                    ...(view.vaultBalanceAmount == null
                      ? {}
                      : { onChainVaultBalance: view.vaultBalanceAmount }),
                    ...(view.pendingAmount == null
                      ? {}
                      : { onChainPendingAmount: view.pendingAmount }),
                    ...(view.issue == null ? {} : { issue: view.issue }),
                  })),
                };
              }
            }
          } catch {
            // `call --inspect` stays read-only and useful even without config.
          }
        }
        printPaymentRequirementInspection(format, inspection);
        return;
      }

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

      if (saveResponse) {
        try {
          assertSaveResponseSupported(result.tool, clientArgs);
        } catch (err) {
          write402Error(err instanceof Error ? err.message : String(err));
          return;
        }
      }

      let paymentRequired: Awaited<
        ReturnType<typeof extractPaymentRequiredResponse>
      >;
      try {
        paymentRequired = await extractPaymentRequiredResponse(
          result.response.clone(),
          result.url,
        );
      } catch (err) {
        write402Error(err instanceof Error ? err.message : String(err));
        return;
      }

      const context = {
        config: activeConfig,
        tool: result.tool,
        clientArgs,
        printPaymentInfo: paymentInfo,
        paymentInfoFormat: paymentInfo
          ? await resolveOutputFormat(formatArg)
          : "table",
        saveResponse,
        firstAttempt: result,
      };

      const resolution: PaymentAttemptResolution =
        flexSession == null
          ? resolvePaymentAttempt({
              challenge: paymentRequired,
              config: activeConfig,
            })
          : resolvePaymentAttempt({
              challenge: paymentRequired,
              config: activeConfig,
              intent: { method: "flex" },
            });

      if (resolution.kind === "unresolved") {
        write402Error(formatPaymentAttemptIssues(resolution.issues));
        return;
      }

      if (resolution.attempt.method === "flex") {
        const promptAllowed =
          deps.canPromptForConfirmation ?? canPromptForConfirmation;
        const canPrompt = !yes && promptAllowed();
        const allowCreateOrTopup = yes || canPrompt;
        await runPaidRetry({
          deps: {
            runWrappedClient: deps.runWrappedClient,
            ...(deps.appendHistoryRecord == null
              ? {}
              : { appendHistoryRecord: deps.appendHistoryRecord }),
          },
          context,
          prepared: prepareFlexPaidRetry({
            deps: {
              ...(deps.buildFlexPaymentRetryHeader == null
                ? {}
                : {
                    buildFlexPaymentRetryHeader:
                      deps.buildFlexPaymentRetryHeader,
                  }),
            },
            context,
            ...(flexSession == null ? {} : { flexSession }),
            allowCreateOrTopup,
            ...(canPrompt ? { confirm: promptForFlexConfirmation } : {}),
          }),
        });
        return;
      }
      await runPaidRetry({
        deps: {
          runWrappedClient: deps.runWrappedClient,
          appendHistoryRecord: deps.appendHistoryRecord ?? appendHistoryRecord,
        },
        context,
        prepared: prepareExactPaidRetry({
          deps: {
            buildPaymentRetryHeader: deps.buildPaymentRetryHeader,
            checkPreflightBalance:
              deps.checkPreflightBalance ?? checkPreflightBalance,
            preflightBalanceDeps:
              deps.preflightBalanceDeps ?? defaultPreflightBalanceDeps,
            canPromptForConfirmation:
              deps.canPromptForConfirmation ?? canPromptForConfirmation,
            confirmPayment: deps.confirmPayment ?? promptForPaymentConfirmation,
          },
          context,
          requirement: resolution.attempt.requirement,
          yes,
        }),
      });
    },
  });
}

export const call = createCallCommand({
  loadRequiredConfig,
  buildPaymentRetryHeader,
  buildFlexPaymentRetryHeader,
  runWrappedClient,
  appendHistoryRecord,
  checkPreflightBalance,
  preflightBalanceDeps: defaultPreflightBalanceDeps,
});
