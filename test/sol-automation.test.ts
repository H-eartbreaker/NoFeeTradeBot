import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { address } from "@solana/kit";
import type { KeyPairSigner } from "@solana/kit";
import { Journal } from "../src/journal.ts";
import { State } from "../src/state.ts";
import { OrderStore } from "../src/orders.ts";
import type { Order } from "../src/orders.ts";
import { createSolAutomation } from "../src/sol-automation.ts";
import { SOL_MINT, type SolRpc } from "../src/sol-chain.ts";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function fixture(t: TestContext, patch: Partial<Order> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sol-auto-")); t.after(() => rmSync(dir, { recursive: true }));
  const state = new State(join(dir, "state.json")); const store = new OrderStore(join(dir, "orders.json")); const journal = new Journal(join(dir, "trades.jsonl"));
  const order: Order = { id: "abc123", wallet: "main", chain: "sol", token: MINT, symbol: "TEST", decimals: 0, kind: "limit-buy", status: "active", createdAt: Date.now(), expiresAt: null, target: "2000000000", amount: "1000000000000000000", pct: null, intervalMs: null, runsLeft: null, nextRunAt: null, spent: "0", runs: 0, skipped: 0, failures: 0, note: "", lastHash: null, ...patch };
  store.add(order); let calls = 0; let quotes = 0; let release: (() => void) | undefined; let gate: Promise<void> | undefined; let floor = "";
  const q = { inputMint: SOL_MINT, outputMint: MINT, inAmount: "1000000000", outAmount: "1000000000", otherAmountThreshold: "990000000" };
  const tick = createSolAutomation({ state, store, journal, rpc: {} as SolRpc, wallet: { address: () => address(SOL_MINT), signer: async () => ({ address: address(SOL_MINT) }) as KeyPairSigner }, notify: async () => {}, ops: {
    reconcile: async () => {}, holdings: async () => [], quote: async () => { quotes++; await gate; return q; },
    buy: async (_rpc, _signer, _mint, amount, _slip, approved, ensure) => { ensure?.(); assert.equal(amount, 1000000000n); calls++; floor = approved!.otherAmountThreshold; return { signature: "sig", quote: approved!, entry: { id: "x", at: "", chain: "sol", wallet: "main", kind: "buy", status: "confirmed" } }; },
  } });
  return { state, store, journal, tick, calls: () => calls, quotes: () => quotes, floor: () => floor, hold: () => { gate = new Promise((r) => { release = r; }); }, release: () => release?.() };
}
test("Solana 限价单只执行一次，18 位订单金额准确转换 lamports，保护下限保留", async (t) => {
  const f = fixture(t); await f.tick(); await f.tick(); assert.equal(f.calls(), 1); assert.equal(f.store.get("abc123")?.status, "done"); assert.equal(f.store.get("abc123")?.spent, "1000000000000000000"); assert.equal(f.floor(), "990000000");
});
test("Solana 全局暂停、待确认签名和重启执行中任务均不重发", async (t) => {
  const f = fixture(t); f.state.setAutoPaused(true); await f.tick(); assert.equal(f.quotes(), 0); f.state.setAutoPaused(false);
  const id = f.journal.start({ wallet: "main", chain: "sol", kind: "buy" }); f.journal.update(id, { status: "unknown", signature: "sig" }); await f.tick(); assert.equal(f.calls(), 0);
  const recovered = fixture(t, { status: "executing" }); await recovered.tick(); assert.equal(recovered.store.get("abc123")?.status, "needs-check"); assert.equal(recovered.calls(), 0);
});
test("Solana 报价期间取消订单不会迟到执行", async (t) => {
  const f = fixture(t); f.hold(); const running = f.tick(); await new Promise((r) => setImmediate(r)); f.store.update("abc123", { status: "cancelled" }); f.release(); await running; assert.equal(f.calls(), 0);
});
test("Solana 错过定投不补买，达到次数后停止", async (t) => {
  const f = fixture(t, { kind: "dca", target: null, intervalMs: 300000, nextRunAt: Date.now() - 900000, runsLeft: 1 });
  await f.tick(); assert.equal(f.calls(), 0); assert.ok(f.store.get("abc123")!.skipped >= 3);
  f.store.update("abc123", { nextRunAt: Date.now() - 1 }); await f.tick(); await f.tick(); assert.equal(f.calls(), 1); assert.equal(f.store.get("abc123")?.runsLeft, 0); assert.equal(f.store.get("abc123")?.status, "done");
});
