#!/usr/bin/env pnpm tsx

import fs from "node:fs/promises";
import path from "node:path";
import t from "tap";
import {
  appendHistoryRecord,
  createHistoryRecord,
  getHistoryPath,
} from "../src/history/store.js";
import { withTempDataHome } from "./test-helpers.js";

async function listDirectoryEntries(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return [];
    }

    throw cause;
  }
}

await t.test("history store", async (t) => {
  await t.test("stores history amounts in base units", async (t) => {
    const record = createHistoryRecord({
      tool: "curl",
      url: "https://example.com/items",
      responseStatus: 200,
      amount: "3000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      assetSymbol: "USDC",
      network: "solana-mainnet-beta",
      walletAddress: "Wallet-1",
      walletKind: "keypair",
    });

    t.equal(record.amount, "3000");
  });

  await t.test(
    "removes the saved response sidecar when metadata persistence fails",
    async (t) => {
      withTempDataHome(t);

      const historyPath = getHistoryPath();
      await fs.mkdir(historyPath, { recursive: true });

      const record = createHistoryRecord({
        tool: "curl",
        url: "https://example.com/items",
        responseStatus: 200,
        amount: "1000",
        asset: "USDC",
        network: "solana-devnet",
        walletAddress: "Wallet-1",
        walletKind: "keypair",
      });

      await t.rejects(
        appendHistoryRecord(record, {
          historyPath,
          responseBody: '{"ok":true}',
        }),
      );

      const responseDir = path.join(
        path.dirname(historyPath),
        "history-responses",
      );
      t.same(await listDirectoryEntries(responseDir), []);
    },
  );
});
