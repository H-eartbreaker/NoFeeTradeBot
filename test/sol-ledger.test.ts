import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { solReceiptPatch, type SolReceipt } from "../src/sol-ledger.ts";
import { State } from "../src/state.ts";
import { calculatePnl } from "../src/pnl.ts";
import type { JournalEntry } from "../src/journal.ts";

test("Solana 保留地址与交易编号大小写，新仓位自动规则默认关闭", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sol-ledger-")); t.after(() => rmSync(dir, { recursive: true }));
  const s = new State(join(dir, "state.json")); s.setDefaultRule({ tp: 100, sl: 30 });
  s.recordBuy("sol", "AbCd", 100n, "main", "SigA"); s.recordBuy("sol", "AbCd", 100n, "main", "SigA");
  s.recordBuy("sol", "AbCd", 100n, "main", "siga");
  assert.equal(s.position("sol", "AbCd")?.cost, 200n); assert.equal(s.position("sol", "abcd"), null);
  assert.equal(s.position("sol", "AbCd")?.tp, null); assert.deepEqual(s.tokens("sol"), ["AbCd"]);
});

test("实际成交抵消代币账户租金，并把网络费和小费分开记", () => {
  const receipt: SolReceipt = { transaction: { message: { accountKeys: ["owner", "ata"] } }, meta: {
    err: null, fee: 5_000n, preBalances: [1_000_000_000n, 0n], postBalances: [897_954_720n, 2_039_280n],
    preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: "AbCd", owner: "owner", uiTokenAmount: { amount: "50" } }],
  } };
  assert.deepEqual(solReceiptPatch(receipt, { owner: "owner", token: "AbCd", kind: "buy", tipLamports: "1000" }), {
    status: "confirmed", gasCost: "6000", feeComplete: true, amountIn: "100000000", amountOut: "50", balanceBefore: "0", amountOutEstimated: false,
  });
  receipt.meta!.err = { InstructionError: [0, "Custom"] };
  assert.deepEqual(solReceiptPatch(receipt, { owner: "owner", token: "AbCd", kind: "buy", tipLamports: "1000" }), { status: "failed", gasCost: "5000", feeComplete: true });
});

test("Solana 盈亏按实际数量核算，并按签名去重", () => {
  const buy: JournalEntry = { id: "a", at: "", chain: "sol", wallet: "main", kind: "buy", token: "AbCd", signature: "SigA", status: "confirmed", amountIn: "100", amountOut: "50", balanceBefore: "0", gasCost: "5", feeComplete: true };
  const sell: JournalEntry = { ...buy, id: "b", signature: "SigB", kind: "sell", amountIn: "25", amountOut: "70", balanceBefore: "50" };
  const p = calculatePnl([sell, sell, buy]); assert.equal(p.realized, 20n); assert.equal(p.gas, 10n);
  assert.equal(p.books.get("AbCd")?.cost, 50n); assert.equal(p.books.has("abcd"), false);
});
