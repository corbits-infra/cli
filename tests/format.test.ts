#!/usr/bin/env pnpm tsx

import t from "tap";
import {
  formatPrice,
  printFormatted,
  printJson,
  printYaml,
  printTable,
} from "../src/output/format.js";
import { captureStdout } from "./helpers.js";

await t.test("formatPrice", async (t) => {
  await t.test("formats micro-USDC to dollars", async (t) => {
    t.equal(formatPrice(10000), "$0.010000");
    t.equal(formatPrice(100000), "$0.100000");
    t.equal(formatPrice(1000000), "$1.000000");
    t.equal(formatPrice(0), "$0.000000");
    t.equal(formatPrice(1), "$0.000001");
    t.equal(formatPrice(5000), "$0.005000");
    t.end();
  });
});

await t.test("printJson", async (t) => {
  await t.test("outputs formatted JSON", async (t) => {
    const output = await captureStdout(() => printJson({ a: 1, b: "two" }));
    const parsed = JSON.parse(output);
    t.equal(parsed.a, 1);
    t.equal(parsed.b, "two");
    t.end();
  });

  await t.test("outputs arrays", async (t) => {
    const output = await captureStdout(() => printJson([1, 2, 3]));
    t.same(JSON.parse(output), [1, 2, 3]);
    t.end();
  });
});

await t.test("printYaml", async (t) => {
  await t.test("outputs YAML", async (t) => {
    const output = await captureStdout(() =>
      printYaml({ name: "test", count: 5 }),
    );
    t.ok(output.includes("name: test"));
    t.ok(output.includes("count: 5"));
    t.end();
  });
});

await t.test("printTable", async (t) => {
  await t.test("outputs a table with headers and rows", async (t) => {
    const output = await captureStdout(() =>
      printTable(
        ["Name", "Value"],
        [
          ["foo", "1"],
          ["bar", "2"],
        ],
      ),
    );
    t.ok(output.includes("Name"));
    t.ok(output.includes("Value"));
    t.ok(output.includes("foo"));
    t.ok(output.includes("bar"));
    t.end();
  });

  await t.test("handles empty rows", async (t) => {
    const output = await captureStdout(() => printTable(["Name"], []));
    t.ok(output.includes("Name"));
    t.end();
  });
});

await t.test("printFormatted", async (t) => {
  const items = [
    { id: 1, name: "alpha" },
    { id: 2, name: "beta" },
  ];
  const toRow = (item: { id: number; name: string }) => [
    String(item.id),
    item.name,
  ];

  await t.test("routes to JSON output", async (t) => {
    const output = await captureStdout(() =>
      printFormatted("json", items, ["ID", "Name"], toRow),
    );
    const parsed = JSON.parse(output);
    t.equal(parsed.length, 2);
    t.equal(parsed[0].name, "alpha");
    t.end();
  });

  await t.test("routes to YAML output", async (t) => {
    const output = await captureStdout(() =>
      printFormatted("yaml", items, ["ID", "Name"], toRow),
    );
    t.ok(output.includes("name: alpha"));
    t.ok(output.includes("name: beta"));
    t.end();
  });

  await t.test("routes to table output", async (t) => {
    const output = await captureStdout(() =>
      printFormatted("table", items, ["ID", "Name"], toRow),
    );
    t.ok(output.includes("ID"));
    t.ok(output.includes("Name"));
    t.ok(output.includes("alpha"));
    t.ok(output.includes("beta"));
    t.end();
  });
});
