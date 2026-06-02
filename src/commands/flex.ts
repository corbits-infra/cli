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
  parsePositiveBaseUnitAmount,
  readFlexSessionStore,
  type FlexSessionRecord,
  type FlexSessionRuntimeView,
} from "../payment/flex.js";

function parseBaseUnitAmount(name: string, value: string): string {
  return parsePositiveBaseUnitAmount(name, value);
}

function statusRows(views: FlexSessionRuntimeView[]) {
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
    healthy: view.healthy,
    reason: view.reason ?? view.session.close_error ?? "",
  }));
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
  if (rows.length === 0) {
    writeLine("No Flex sessions found.");
    return;
  }
  printTable(
    [
      "ID",
      "Status",
      "Network",
      "Mint",
      "Facilitator",
      "Escrow",
      "On-chain Available",
      "On-chain Pending",
      "Health",
    ],
    rows.map((row) => [
      row.id,
      row.status,
      row.network,
      row.mint,
      row.facilitator,
      row.escrow,
      row.onChainAvailableAmount,
      row.onChainPendingAmount,
      row.healthy ? "healthy" : row.reason,
    ]),
  );
}

async function promptForFlexConfirmation(args: {
  session: FlexSessionRecord;
  amount: string;
}): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error("Flex top-up requires an interactive terminal or --yes");
  }
  const prompt = `Top up Flex session ${args.session.id} by ${args.amount} base units? [y/N] `;
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
    ["#", "ID", "Network", "Mint", "Escrow", "On-chain Available", "Health"],
    views.map((view, index) => [
      String(index + 1),
      view.session.id,
      view.session.network,
      view.session.mint,
      view.session.escrow,
      view.availableAmount ?? "",
      view.healthy ? "healthy" : (view.reason ?? "unknown"),
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
      description: "Top-up amount in token base units",
    }),
    yes: flag({
      long: "yes",
      description: "Run without an interactive confirmation prompt",
    }),
  },
  handler: async ({ sessionId, amount, yes }) => {
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
    const parsedAmount = parseBaseUnitAmount("--amount", amount);
    if (!yes) {
      const approved = await promptForFlexConfirmation({
        session,
        amount: parsedAmount,
      });
      if (!approved) {
        throw new Error("Flex top-up cancelled");
      }
    }
    await topUpFlexSession({
      config: resolved,
      session,
      amount: parsedAmount,
      note: (message) => process.stderr.write(`${message}\n`),
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
