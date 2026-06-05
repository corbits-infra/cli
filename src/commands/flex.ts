import {
  command,
  flag,
  option,
  optional,
  positional,
  string,
  subcommands,
} from "cmd-ts";
import { createInterface } from "node:readline/promises";

import { loadRequiredConfig } from "../config/index.js";
import { formatFlag, resolveOutputFormat } from "../flags.js";
import {
  formatCompactDisplayTokenAmount,
  formatDisplayTokenAmount,
  printJSON,
  printTable,
  printYaml,
  type OutputFormat,
  writeLine,
} from "../output/format.js";
import {
  getFlexSessionViews,
  topUpFlexSession,
} from "../payment/flex-solana.js";
import {
  isFlexSessionEligibleForTopup,
  readFlexSessionStore,
  type FlexSessionRecord,
  type FlexSessionRuntimeView,
} from "../payment/flex.js";
import {
  formatPaymentOptionNetwork,
  getKnownPaymentAssetDecimals,
  resolvePaymentAssetSymbol,
} from "../payment/requirements.js";

function getSessionAssetDisplay(session: FlexSessionRecord): {
  asset: string;
  assetAddress: string;
  decimals: number | null;
} {
  const symbol = resolvePaymentAssetSymbol(session.network, session.mint);
  return {
    asset: symbol ?? session.mint,
    assetAddress: session.mint,
    decimals: getKnownPaymentAssetDecimals(session.network, session.mint),
  };
}

function formatSessionAmount(
  session: FlexSessionRecord,
  amount: string | undefined,
): string | undefined {
  if (amount == null) {
    return undefined;
  }
  const asset = getSessionAssetDisplay(session);
  return formatDisplayTokenAmount({
    amount,
    asset: asset.asset,
    decimals: asset.decimals,
  });
}

function formatSessionAmountWithAsset(
  session: FlexSessionRecord,
  amount: string,
): string {
  const asset = getSessionAssetDisplay(session);
  return `${formatCompactDisplayTokenAmount({
    amount,
    asset: asset.asset,
    decimals: asset.decimals,
  })} ${asset.asset}`;
}

export function parsePositiveDisplayAmount(
  name: string,
  value: string,
  decimals: number,
): string {
  const trimmed = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
    throw new Error(`${name} must be a decimal amount`);
  }

  const [wholePartRaw = "", fractionalPartRaw = ""] = trimmed.split(".");
  const wholePart = wholePartRaw.length === 0 ? "0" : wholePartRaw;
  const excessFractional = fractionalPartRaw.slice(decimals);
  if (/[1-9]/.exec(excessFractional) != null) {
    throw new Error(
      `${name} has more decimal places than this Flex session asset supports`,
    );
  }

  const fractionalPart = fractionalPartRaw
    .slice(0, decimals)
    .padEnd(decimals, "0");
  const amount = `${wholePart}${fractionalPart}`.replace(/^0+(?=\d)/, "");
  if (amount === "0") {
    throw new Error(`${name} must be greater than zero`);
  }
  return amount;
}

function parseFlexTopupAmount(
  name: string,
  value: string,
  session: FlexSessionRecord,
): string {
  const asset = getSessionAssetDisplay(session);
  if (asset.decimals == null) {
    throw new Error(
      `Cannot parse ${name} for ${asset.asset}; asset decimals are unknown`,
    );
  }
  return parsePositiveDisplayAmount(name, value, asset.decimals);
}

function getSessionIssueDisplay(view: FlexSessionRuntimeView): {
  issue?: string;
} {
  const issue = view.issue ?? view.session.close_error;
  if (issue == null || issue.length === 0) {
    return {};
  }
  return {
    issue,
  };
}

export function statusRows(views: FlexSessionRuntimeView[]) {
  return views.map((view) => ({
    id: view.session.id,
    status: view.session.status,
    owner: view.session.owner_address,
    network: view.session.network,
    mint: view.session.mint,
    facilitator: view.session.facilitator,
    escrow: view.session.escrow,
    sessionKey: view.session.session_key_address,
    totalDepositedAmount: view.session.deposited_amount,
    onChainVaultBalance: view.vaultBalanceAmount ?? "",
    onChainAvailableAmount: view.availableAmount ?? "",
    onChainPendingAmount: view.pendingAmount ?? "",
    issue: view.issue ?? view.session.close_error ?? "",
  }));
}

export function statusDisplayRows(views: FlexSessionRuntimeView[]) {
  return views.map((view) => {
    const asset = getSessionAssetDisplay(view.session);
    return {
      id: view.session.id,
      status: view.session.status,
      network: formatPaymentOptionNetwork(view.session.network),
      asset: asset.asset,
      assetAddress: asset.assetAddress,
      deposited: formatSessionAmount(
        view.session,
        view.session.deposited_amount,
      ),
      ...(view.availableAmount == null
        ? {}
        : {
            available: formatSessionAmount(view.session, view.availableAmount),
          }),
      ...getSessionIssueDisplay(view),
      owner: view.session.owner_address,
      escrow: view.session.escrow,
      sessionKey: view.session.session_key_address,
    };
  });
}

function printStatus(
  format: OutputFormat,
  views: FlexSessionRuntimeView[],
): void {
  const rows = statusRows(views);
  if (format === "json") {
    printJSON(rows);
    return;
  }
  if (format === "yaml") {
    printYaml(rows);
    return;
  }
  const displayRows = statusDisplayRows(views);
  if (displayRows.length === 0) {
    writeLine("No Flex sessions found.");
    return;
  }
  const showState = displayRows.some(
    (row) => row.status !== "open" || row.issue != null,
  );
  const head = showState
    ? ["ID", "Network", "Asset", "Total Deposited", "Available", "State"]
    : ["ID", "Network", "Asset", "Total Deposited", "Available"];
  printTable(
    head,
    displayRows.map((row) => {
      const base = [
        row.id,
        row.network,
        row.asset,
        row.deposited ?? "",
        row.available ?? "",
      ];
      if (!showState) {
        return base;
      }
      const state =
        row.issue == null
          ? row.status
          : row.status === "open"
            ? row.issue
            : `${row.status}: ${row.issue}`;
      return [...base, state];
    }),
  );
}

export function printTopupResult(
  format: OutputFormat,
  args: {
    session: FlexSessionRecord;
    amount: string;
    signature: string;
  },
): void {
  const asset = getSessionAssetDisplay(args.session);
  const result = {
    sessionId: args.session.id,
    amount: formatDisplayTokenAmount({
      amount: args.amount,
      asset: asset.asset,
      decimals: asset.decimals,
    }),
    asset: asset.asset,
    network: formatPaymentOptionNetwork(args.session.network),
    escrow: args.session.escrow,
    totalDepositedAmount: formatDisplayTokenAmount({
      amount: args.session.deposited_amount,
      asset: asset.asset,
      decimals: asset.decimals,
    }),
    txSignature: args.signature,
  };

  if (format === "json") {
    printJSON(result);
    return;
  }
  if (format === "yaml") {
    printYaml(result);
    return;
  }
  printTable(
    [
      "Session",
      "Amount",
      "Asset",
      "Network",
      "Escrow",
      "Total Deposited",
      "Tx Signature",
    ],
    [
      [
        result.sessionId,
        result.amount,
        result.asset,
        result.network,
        result.escrow,
        result.totalDepositedAmount,
        result.txSignature,
      ],
    ],
  );
}

async function promptForFlexConfirmation(args: {
  session: FlexSessionRecord;
  amount: string;
}): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error("Flex top-up requires an interactive terminal or --yes");
  }
  const prompt = `Top up Flex session ${args.session.id} by ${formatSessionAmountWithAsset(args.session, args.amount)}? [y/N] `;
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

async function promptForFlexSessionId(
  views: FlexSessionRuntimeView[],
): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Specify the Flex session id to top up");
  }
  if (views.length === 0) {
    throw new Error(
      "No open Flex sessions for the active wallet and network were found to top up",
    );
  }
  printTable(
    ["#", "ID", "Network", "Asset", "Available"],
    views.map((view, index) => [
      String(index + 1),
      view.session.id,
      formatPaymentOptionNetwork(view.session.network),
      getSessionAssetDisplay(view.session).asset,
      formatSessionAmount(view.session, view.availableAmount) ?? "",
    ]),
  );
  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const answer = await readline.question(
      "Flex session to top up (number or id): ",
    );
    const selection = answer.trim();
    if (selection.length === 0) {
      throw new Error("Flex session selection cancelled");
    }
    if (/^\d+$/.test(selection)) {
      const index = Number(selection);
      const selected = views[index - 1];
      if (selected == null) {
        throw new Error(`Flex session option ${selection} was not found`);
      }
      return selected.session.id;
    }
    if (!views.some((view) => view.session.id === selection)) {
      throw new Error(`Flex session ${selection} was not in the top-up list`);
    }
    return selection;
  } finally {
    readline.close();
  }
}

export function filterEligibleTopupSessionViews(
  views: FlexSessionRuntimeView[],
  config: Parameters<typeof isFlexSessionEligibleForTopup>[1],
): FlexSessionRuntimeView[] {
  return views.filter((view) =>
    isFlexSessionEligibleForTopup(view.session, config),
  );
}

function findStoredSession(
  sessions: FlexSessionRecord[],
  sessionId: string,
  allowedStatuses: readonly FlexSessionRecord["status"][],
): FlexSessionRecord {
  const session = sessions.find(
    (entry) => entry.id === sessionId && allowedStatuses.includes(entry.status),
  );
  if (session == null) {
    throw new Error(`Flex session ${sessionId} was not found`);
  }
  return session;
}

const flexTopup = command({
  name: "topup",
  description: "Top up a stored Solana Flex session",
  args: {
    sessionId: positional({
      type: optional(string),
      displayName: "session-id",
    }),
    amount: option({
      type: string,
      long: "amount",
      description: "Top-up amount",
    }),
    yes: flag({
      long: "yes",
      description: "Run without an interactive confirmation prompt",
    }),
    format: formatFlag,
  },
  handler: async ({ sessionId, amount, yes, format: formatArg }) => {
    const format = await resolveOutputFormat(formatArg);
    const { resolved } = await loadRequiredConfig();
    const store = await readFlexSessionStore();
    const eligibleViews =
      sessionId == null && !yes
        ? filterEligibleTopupSessionViews(
            await getFlexSessionViews({ config: resolved }),
            resolved,
          )
        : [];
    const selectedSessionId =
      sessionId ?? (yes ? null : await promptForFlexSessionId(eligibleViews));
    if (selectedSessionId == null) {
      throw new Error("Specify the Flex session id to top up");
    }
    const session = findStoredSession(store.sessions, selectedSessionId, [
      "open",
    ]);
    const parsedAmount = parseFlexTopupAmount("--amount", amount, session);
    if (!yes) {
      const approved = await promptForFlexConfirmation({
        session,
        amount: parsedAmount,
      });
      if (!approved) {
        throw new Error("Flex top-up cancelled");
      }
    }
    const result = await topUpFlexSession({
      config: resolved,
      session,
      amount: parsedAmount,
      note: (message) => process.stderr.write(`${message}\n`),
    });
    printTopupResult(format, {
      session: result.session,
      amount: parsedAmount,
      signature: result.signature,
    });
  },
});

const flexStatus = command({
  name: "status",
  description: "Show stored Solana Flex sessions and escrow state",
  args: {
    format: formatFlag,
  },
  handler: async ({ format: formatArg }) => {
    const format = await resolveOutputFormat(formatArg);
    const { resolved } = await loadRequiredConfig();
    const views = await getFlexSessionViews({ config: resolved });
    printStatus(format, views);
  },
});

export const flex = subcommands({
  name: "flex",
  description: "Manage Solana Flex payment sessions",
  cmds: {
    topup: flexTopup,
    status: flexStatus,
  },
});
