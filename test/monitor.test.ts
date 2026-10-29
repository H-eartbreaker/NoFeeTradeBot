import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { CHAINS } from "../src/chains.ts";
import { INTERVAL_MS, startMonitor } from "../src/monitor.ts";
import { State } from "../src/state.ts";
import { ConfirmedTransactionError } from "../src/trade.ts";
import type { TradeDeps } from "../src/trade.ts";

test("止盈止损每 3 秒调度，停止后不再调度", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let checks = 0;
  const state = { positions: () => { checks++; return []; } } as unknown as State;
  const stop = startMonitor({ state, deps: new Map(), slippageBps: () => 1000, notify: async () => undefined });
  assert.equal(INTERVAL_MS, 3000);
  t.mock.timers.tick(2999); assert.equal(checks, 0);
  t.mock.timers.tick(1); assert.equal(checks, 1);
  await Promise.resolve();
  t.mock.timers.tick(3000); assert.equal(checks, 2);
  stop(); t.mock.timers.tick(3000); assert.equal(checks, 2);
});

const TOKEN = "0x1111111111111111111111111111111111111111";
const E = 10n ** 18n;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function harness(t: TestContext, options: { confirmed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "monitor-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(join(dir, "state.json"));
  state.recordBuy("bsc", TOKEN, E);
  let balance = 100n; let multiplier = 100n; let hashes = 0; let failNext = options.confirmed === true;
  const sells: { pct: number; sold: bigint }[] = []; const notes: string[] = [];
  const d = { chain: CHAINS.bsc, clients: { account: { address: "0x2222222222222222222222222222222222222222" } } } as unknown as TradeDeps;
  const ops = {
    balanceOf: async () => balance,
    getRoute: async (_slug: string, _token: Address, _native: Address, amount: bigint) => ({ routeSummary: { amountOut: (amount * (E / 100n) * multiplier / 100n).toString() } }),
    sell: async (_d: TradeDeps, _token: Address, pct: number) => {
      const before = balance; const sold = before * BigInt(Math.round(pct)) / 100n; balance -= sold; sells.push({ pct, sold });
      if (failNext) { failNext = false; throw new ConfirmedTransactionError(`0x${String(++hashes).padStart(64, "a")}` as Hex); }
      return { hash: `0x${String(++hashes).padStart(64, "b")}` as Hex, soldAmount: sold, receivedNative: 0n, approveHash: null, blockNumber: 1n, balanceBefore: before };
    },
  };
  t.mock.timers.enable({ apis: ["setInterval"] });
  const stop = startMonitor({ state, deps: new Map(), slippageBps: () => 1000, notify: async (html) => { notes.push(html); }, getDeps: () => d, ops: ops as never });
  t.after(stop);
  return { state, sells, notes, tick: async () => { t.mock.timers.tick(INTERVAL_MS); await settle(); }, setMultiplier: (m: number) => { multiplier = BigInt(m); }, balance: () => balance };
}

test("分档止盈按顺序卖出部分仓位，成本和进度同步，重复检查不重复卖", async (t) => {
  const h = harness(t);
  h.state.setRule("bsc", TOKEN, { tp: null, sl: null, tiers: [{ at: 50, pct: 50 }, { at: 100, pct: 100 }] });
  h.setMultiplier(160); await h.tick();
  assert.deepEqual(h.sells.map((s) => s.pct), [50]);
  assert.equal(h.state.position("bsc", TOKEN)!.done, 1);
  assert.equal(h.state.position("bsc", TOKEN)!.cost, E / 2n);
  await h.tick(); assert.equal(h.sells.length, 1);
  h.setMultiplier(200); await h.tick();
  assert.deepEqual(h.sells.map((s) => s.pct), [50, 100]);
  assert.equal(h.state.position("bsc", TOKEN), null);
});

test("移动止损记录最高价，从高点回撤超过阈值时全部卖出", async (t) => {
  const h = harness(t);
  h.state.setRule("bsc", TOKEN, { tp: null, sl: null, trail: 20 });
  h.setMultiplier(150); await h.tick();
  assert.equal(h.state.position("bsc", TOKEN)!.peak, E * 150n / 100n);
  h.setMultiplier(130); await h.tick(); assert.equal(h.sells.length, 0);
  h.setMultiplier(110); await h.tick();
  assert.deepEqual(h.sells.map((s) => s.pct), [100]);
  assert.equal(h.state.position("bsc", TOKEN), null);
});

test("全局暂停时不卖出，恢复后按规则执行", async (t) => {
  const h = harness(t);
  h.state.setRule("bsc", TOKEN, { tp: 50, sl: null });
  h.state.setAutoPaused(true);
  h.setMultiplier(200); await h.tick(); assert.equal(h.sells.length, 0);
  h.state.setAutoPaused(false);
  await h.tick(); assert.equal(h.sells.length, 1);
});

test("已成交但到账数据不全的分档卖出仍推进进度，不再重复同一档", async (t) => {
  const h = harness(t, { confirmed: true });
  h.state.setRule("bsc", TOKEN, { tp: null, sl: null, tiers: [{ at: 50, pct: 50 }, { at: 100, pct: 100 }] });
  h.setMultiplier(160); await h.tick();
  assert.equal(h.state.position("bsc", TOKEN)!.done, 1);
  await h.tick(); assert.equal(h.sells.length, 1);
  assert.ok(h.notes.some((n) => n.includes("已成交")));
});
