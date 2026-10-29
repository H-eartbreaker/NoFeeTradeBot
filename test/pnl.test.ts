import assert from "node:assert/strict";
import { test } from "node:test";
import type { JournalEntry } from "../src/journal.ts";
import { calculatePnl, floatingPnl, unrecoveredPrincipal } from "../src/pnl.ts";
import { NATIVE } from "../src/kyber.ts";

const TOKEN = "0x1111111111111111111111111111111111111111";
let next = 0;
const entry = (kind: JournalEntry["kind"], amountIn: string, amountOut: string | undefined, balanceBefore?: string): JournalEntry => ({ id: String(++next), at: "2026-10-29T00:00:00Z", wallet: "main", chain: "bsc", status: "confirmed", kind, token: TOKEN, amountIn, amountOut, balanceBefore, gasCost: "1", feeComplete: true });
test("加权成本、分批卖出与本金回收分别核算，剩余成本不当成未回收本金", () => {
  const buy = entry("buy", "1000", "100", "0"); const add = entry("buy", "500", "100", "100"); const sale = entry("sell", "50", "1000", "200");
  const p = calculatePnl([sale, add, buy]); const b = p.books.get(TOKEN)!;
  assert.equal(p.realized, 625n); assert.equal(p.realizedTrades, 1); assert.equal(p.gas, 3n);
  assert.equal(b.cost, 1125n); assert.equal(b.quantity, 150n);
  assert.equal(unrecoveredPrincipal(b, 150n), 500n);
  assert.equal(floatingPnl(b, 150n, 1500n), 375n);
  assert.equal(floatingPnl(b, 151n, 1500n), null);
  assert.equal(unrecoveredPrincipal(b, 151n), null);
});
test("旧交易与外部入币成本未知，不虚增收益；完全清仓后的新周期可恢复核对", () => {
  const legacy = entry("buy", "100", "10"); const sale = entry("sell", "10", "200", "10");
  let p = calculatePnl([sale, legacy]); assert.equal(p.realized, 0n); assert.equal(p.unknownSales, 1);
  const fresh = entry("buy", "100", "10", "0"); const external = entry("sell", "5", "200", "20");
  p = calculatePnl([external, fresh, sale, legacy]); assert.equal(p.unknownSales, 2); assert.equal(p.books.get(TOKEN)!.cost, null);
  const full = entry("sell", "15", "300", "15"); const newest = entry("buy", "100", "20", "0");
  p = calculatePnl([newest, full, external, fresh, sale, legacy]); assert.equal(p.books.get(TOKEN)!.cost, 100n);
});
test("缺失卖出到账不填零，但可继续按实际数量保留剩余成本；失败费用和不完整 L1 单独统计", () => {
  const buy = entry("buy", "100", "10", "0"); const sale = entry("sell", "5", undefined, "10");
  const failed = { ...entry("approve", "0", undefined), status: "failed" as const, gasCost: "3", feeComplete: false };
  const p = calculatePnl([failed, sale, buy]);
  assert.equal(p.unknownSales, 1); assert.equal(p.realized, 0n); assert.equal(p.books.get(TOKEN)!.cost, 50n);
  assert.equal(unrecoveredPrincipal(p.books.get(TOKEN), 5n), null); assert.equal(p.gas, 5n); assert.equal(p.feeComplete, false);
});
test("转出代币按分数移走成本但不当作盈利，稳定币兑换也可形成成本链条", () => {
  const buy = { ...entry("swap", "100", "10", "1000"), token: NATIVE, outputToken: TOKEN, outputBalanceBefore: "0" };
  const transfer = entry("transfer", "2", undefined, "10");
  const sell = { ...entry("swap", "4", "100", "8"), outputToken: NATIVE, amountOutEstimated: true };
  const p = calculatePnl([sell, transfer, buy]);
  assert.equal(p.realized, 60n); assert.equal(p.estimated, true); assert.equal(p.books.get(TOKEN)!.cost, 40n);
  assert.equal(unrecoveredPrincipal(p.books.get(TOKEN), 4n), null);
});
test("同交易哈希去重，未确认操作不当作成交收益", () => {
  const buy = { ...entry("buy", "100", "10", "0"), hash: `0x${"1".repeat(64)}` as const };
  const pending = { ...entry("sell", "10", "200", "10"), status: "pending" as const };
  const p = calculatePnl([pending, { ...buy, id: "duplicate" }, buy]);
  assert.equal(p.books.get(TOKEN)!.cost, 100n); assert.equal(p.gas, 1n); assert.equal(p.realized, 0n); assert.equal(p.unresolved, 1);
});
