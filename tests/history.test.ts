#!/usr/bin/env pnpm tsx

import fs from "node:fs/promises";
import path from "node:path";
import t from "tap";
import { createHistoryCommand } from "../src/commands/history.js";
import {
  getHistoryPath,
  listHistoryEntries,
  readHistoryEntry,
  type HistoryRecord,
} from "../src/history/store.js";
import { captureStdout, withTempDataHome } from "./test-helpers.js";

const historyCommand = createHistoryCommand({
  listHistoryEntries,
  readHistoryEntry,
});

let nextRecordId = 0;

function createRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  nextRecordId += 1;
  return {
    id: `entry-${nextRecordId}`,
    timestamp_ms: 1_713_782_400_000,
    tool: "curl",
    method: "GET",
    url: "https://example.com/items",
    host: "example.com",
    resource_path: "/items",
    response_status: 200,
    payment_status: "paid",
    amount: "1000",
    asset: "USDC",
    asset_symbol: "USDC",
    network: "solana-devnet",
    wallet_address: "Wallet-1",
    wallet_kind: "keypair",
    ...overrides,
  };
}

async function writeHistoryLines(
  lines: (string | HistoryRecord)[],
): Promise<void> {
  const historyPath = getHistoryPath();
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(
    historyPath,
    `${lines
      .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
      .join("\n")}\n`,
    "utf8",
  );
}

async function writeHistoryResponse(
  responsePath: string,
  responseBody: string | Uint8Array,
): Promise<void> {
  const historyPath = getHistoryPath();
  const targetPath = path.resolve(path.dirname(historyPath), responsePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, responseBody);
}

await t.test("history command", async (t) => {
  await t.test(
    "shows a clean empty state when the history file is missing",
    async (t) => {
      withTempDataHome(t);

      const output = await captureStdout(() =>
        historyCommand.handler({
          action: undefined,
          index: undefined,
          format: "table",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
      );

      t.equal(output.trim(), "No history entries found.");
    },
  );

  await t.test(
    "lists the 20 most recent entries sorted by timestamp",
    async (t) => {
      withTempDataHome(t);

      await writeHistoryLines(
        Array.from({ length: 21 }, (_, index) =>
          createRecord({
            timestamp_ms: 1_713_782_400_000 + index,
            url: `https://example.com/items/${index + 1}`,
            resource_path: `/items/${index + 1}`,
            wallet_address: `Wallet-${index + 1}`,
          }),
        ),
      );

      const output = await captureStdout(() =>
        historyCommand.handler({
          action: undefined,
          index: undefined,
          format: "json",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
      );

      const parsed = JSON.parse(output) as {
        index: number;
        resource_path: string;
        amount: string;
      }[];
      t.equal(parsed.length, 20);
      t.equal(parsed[0]?.index, 21);
      t.equal(parsed[0]?.resource_path, "/items/21");
      t.equal(parsed[0]?.amount, "0.001000");
      t.equal(parsed.at(-1)?.index, 2);
    },
  );

  await t.test(
    "applies substring and amount filters while keeping display formatting human-readable",
    async (t) => {
      withTempDataHome(t);

      await writeHistoryLines([
        createRecord({
          host: "exa.api.corbits.dev",
          resource_path: "/search",
          wallet_address: "Wallet-A",
          amount: "1000",
        }),
        createRecord({
          timestamp_ms: 1_713_782_400_100,
          host: "stableenrich.dev",
          resource_path: "/api/exa/search",
          wallet_address: "Wallet-B",
          amount: "2500000",
        }),
        createRecord({
          timestamp_ms: 1_713_782_400_200,
          host: "other.example.com",
          resource_path: "/health",
          wallet_address: "Wallet-C",
          amount: "9000000",
        }),
      ]);

      const filteredJson = await captureStdout(() =>
        historyCommand.handler({
          action: undefined,
          index: undefined,
          format: "json",
          wallet: "wallet-b",
          network: "devnet",
          host: "stable",
          resource: "exa",
          minAmount: "2",
          maxAmount: "3",
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
      );

      const parsed = JSON.parse(filteredJson) as {
        index: number;
        amount: string;
      }[];
      t.same(
        parsed.map((entry) => entry.index),
        [2],
      );
      t.equal(parsed[0]?.amount, "2.500000");

      const filteredTable = await captureStdout(() =>
        historyCommand.handler({
          action: undefined,
          index: undefined,
          format: "table",
          wallet: undefined,
          network: undefined,
          host: "stable",
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
      );

      t.match(filteredTable, /2\.500000 USDC/);
      t.notMatch(filteredTable, /stableenrich\.dev[\s\S]*2500000 /);
    },
  );

  await t.test(
    "formats non-USDC history amounts using stored decimals",
    async (t) => {
      withTempDataHome(t);

      await writeHistoryLines([
        createRecord({
          amount: "1234500000000000000",
          asset: "0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2",
          asset_symbol: "WETH",
          decimals: 18,
        }),
      ]);

      const output = await captureStdout(() =>
        historyCommand.handler({
          action: undefined,
          index: undefined,
          format: "table",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
      );

      t.match(output, /1\.234500000000000000 WETH/);
    },
  );

  await t.test(
    "accepts Unix seconds, Unix milliseconds, and ISO datetimes for time filters",
    async (t) => {
      withTempDataHome(t);

      await writeHistoryLines([
        createRecord({ timestamp_ms: 1_713_782_399_000 }),
        createRecord({
          timestamp_ms: 1_713_782_400_000,
          resource_path: "/later",
          url: "https://example.com/later",
        }),
      ]);

      const secondsOutput = await captureStdout(() =>
        historyCommand.handler({
          action: undefined,
          index: undefined,
          format: "json",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: "1713782400",
          until: undefined,
          limit: undefined,
        }),
      );
      t.equal((JSON.parse(secondsOutput) as unknown[]).length, 1);

      const millisOutput = await captureStdout(() =>
        historyCommand.handler({
          action: undefined,
          index: undefined,
          format: "json",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: "1713782399000",
          limit: undefined,
        }),
      );
      t.equal((JSON.parse(millisOutput) as unknown[]).length, 1);

      const isoOutput = await captureStdout(() =>
        historyCommand.handler({
          action: undefined,
          index: undefined,
          format: "json",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: "2024-04-22T10:40:00.000Z",
          until: undefined,
          limit: undefined,
        }),
      );
      t.equal((JSON.parse(isoOutput) as unknown[]).length, 1);
    },
  );

  await t.test("skips malformed lines during list reads", async (t) => {
    withTempDataHome(t);

    await writeHistoryLines([
      createRecord(),
      '{"bad": }',
      JSON.stringify({ wrong: "shape" }),
      createRecord({
        timestamp_ms: 1_713_782_400_500,
        resource_path: "/ok-again",
        url: "https://example.com/ok-again",
      }),
    ]);

    const output = await captureStdout(() =>
      historyCommand.handler({
        action: undefined,
        index: undefined,
        format: "json",
        wallet: undefined,
        network: undefined,
        host: undefined,
        resource: undefined,
        minAmount: undefined,
        maxAmount: undefined,
        since: undefined,
        until: undefined,
        limit: undefined,
      }),
    );

    const parsed = JSON.parse(output) as { index: number }[];
    t.same(
      parsed.map((entry) => entry.index),
      [4, 1],
    );
  });

  await t.test(
    "shows a single entry and prints the saved response body",
    async (t) => {
      withTempDataHome(t);

      const record = createRecord({
        tx_signature: "sig-123",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        asset_symbol: "USDC",
        response_path: path.join("history-responses", "saved-response.txt"),
      });
      if (record.response_path == null) {
        throw new Error("response_path should be set for saved-response tests");
      }
      await writeHistoryResponse(record.response_path, '{"ok":true}');

      await writeHistoryLines([record]);

      const output = await captureStdout(() =>
        historyCommand.handler({
          action: "show",
          index: "1",
          format: "table",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
      );

      t.match(output, /tx_signature/);
      t.match(output, /Response:/);
      t.match(output, /\{"ok":true\}/);
    },
  );

  await t.test(
    "shows binary saved responses as base64 in table output",
    async (t) => {
      withTempDataHome(t);

      const record = createRecord({
        response_path: path.join("history-responses", "saved-response.bin"),
      });
      if (record.response_path == null) {
        throw new Error("response_path should be set for saved-response tests");
      }
      await writeHistoryResponse(
        record.response_path,
        Buffer.from([0x00, 0xff, 0x41, 0x0a]),
      );

      await writeHistoryLines([record]);

      const output = await captureStdout(() =>
        historyCommand.handler({
          action: "show",
          index: "1",
          format: "table",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
      );

      t.match(output, /Response \(base64\):/);
      t.match(output, /AP9BCg==/);
    },
  );

  await t.test(
    "returns a clear error when a saved response file is missing",
    async (t) => {
      withTempDataHome(t);

      await writeHistoryLines([
        createRecord({
          response_path: path.join("history-responses", "missing.txt"),
        }),
      ]);

      await t.rejects(
        historyCommand.handler({
          action: "show",
          index: "1",
          format: "json",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
        /Saved response for history entry #1 is missing/,
      );
    },
  );

  await t.test(
    "rejects absolute saved response paths outside the history directory",
    async (t) => {
      withTempDataHome(t);

      await writeHistoryLines([
        createRecord({
          response_path: "/etc/hosts",
        }),
      ]);

      await t.rejects(
        historyCommand.handler({
          action: "show",
          index: "1",
          format: "json",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
        /Saved response for history entry #1 is invalid/,
      );
    },
  );

  await t.test(
    "rejects saved response paths that escape the history directory",
    async (t) => {
      withTempDataHome(t);

      await writeHistoryLines([
        createRecord({
          response_path: path.join("history-responses", "..", "escape.txt"),
        }),
      ]);

      await t.rejects(
        historyCommand.handler({
          action: "show",
          index: "1",
          format: "json",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
        /Saved response for history entry #1 is invalid/,
      );
    },
  );

  await t.test(
    "returns a clear error for out-of-range history show indexes",
    async (t) => {
      withTempDataHome(t);

      await writeHistoryLines([createRecord()]);

      await t.rejects(
        historyCommand.handler({
          action: "show",
          index: "2",
          format: "json",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
        /History entry #2 not found/,
      );
    },
  );

  await t.test(
    "returns a clear parse error for malformed history show lines",
    async (t) => {
      withTempDataHome(t);

      await writeHistoryLines(['{"bad": }']);

      await t.rejects(
        historyCommand.handler({
          action: "show",
          index: "1",
          format: "json",
          wallet: undefined,
          network: undefined,
          host: undefined,
          resource: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          since: undefined,
          until: undefined,
          limit: undefined,
        }),
        /History entry #1 is malformed/,
      );
    },
  );
});
