#!/usr/bin/env pnpm tsx

import t from "tap";
import { formatPrice } from "../src/output/format.js";

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
