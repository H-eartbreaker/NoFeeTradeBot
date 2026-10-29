import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrderStore } from "../src/orders.ts";
import type { Order } from "../src/orders.ts";
import { startOrderRunner, ORDER_INTERVAL_MS } from "../src/order-runner.ts";
import { State } from "../src/state.ts";
import { CHAINS } from "../src/chains.ts";
import type { TradeDeps } from "../src/trade.ts";
import { PendingTransactionError, LimitNotMetError } from "../src/trade.ts";
const TOKEN = "0x1111111111111111111111111111111111111111";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
function fixture(t: TestContext, patch: Partial<Order> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "order-runner-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("不允许真实网络请求"); });
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000000 });
  const store = new OrderStore(join(dir, "orders.json")); const state = new State(join(dir, "state.json"));
  const order: Order = { id: "111111111111", kind: "limit-buy", wallet: "main", chain: "bsc", token: TOKEN, symbol: "TEST", decimals: 0, status: "active", createdAt: Date.now(), expiresAt: null, target: "10", amount: "100", pct: null, intervalMs: null, runsLeft: null, nextRunAt: null, spent: "0", runs: 0, skipped: 0, failures: 0, note: "", lastHash: null, ...patch };
  store.add(order);
  let buyCalls = 0; let sellCalls = 0; let fail: Error | null = null; let gate: Promise<void> | undefined; let honeypot = false; let quoteWait: Promise<void> | undefined;
  const notes: string[] = []; const floors: (bigint | undefined)[] = [];
  const d = { chain: CHAINS.bsc, clients: { account: { address: TOKEN } } } as unknown as TradeDeps;
  const stop = startOrderRunner({ store, state, getDeps: () => d, slippageBps: () => 100, notify: async (text) => { notes.push(text); }, ops: {
    balanceOf: async () => 100n, readOwner: async () => null, checkToken: async () => ({ isHoneypot: honeypot, buyTax: 0, sellTax: 0, risk: "low", liquidityUsd: 1000, holders: 1 }),
    supply: async () => 3n, getRoute: async (_slug, _in, _out, amount) => { await quoteWait; return { routerAddress: TOKEN, routeSummary: { amountIn: String(amount), amountOut: "10", gas: "1", amountOutUsd: "1" } }; },
    buy: async (_d, _token, _amount, _slip, _gate, _route, floor) => { buyCalls++; floors.push(floor); await gate; if (typeof _gate === "function") await _gate(); if (fail) throw fail; return { hash: hash(buyCalls), received: 10n, blockNumber: 1n }; },
    sell: async () => { sellCalls++; if (fail) throw fail; return { hash: hash(sellCalls), soldAmount: 50n, balanceBefore: 100n, receivedNative: 500n, approveHash: null, blockNumber: 1n }; },
  } }); t.after(stop);
  return { store, state, order, notes, floors, stop, tick: async (ms = ORDER_INTERVAL_MS) => { t.mock.timers.tick(ms); await settle(); }, counts: () => ({ buyCalls, sellCalls }),
    fail: (v: Error | null) => { fail = v; }, wait: (v: Promise<void>) => { gate = v; }, honeypot: () => { honeypot = true; }, quoteWait: (v: Promise<void>) => { quoteWait = v; }, result: () => store.get(order.id)! };
}

test("限价单触发仅执行一次，最低到手量传到交易层，重启保存成交哈希", async (t) => {
  const f = fixture(t); await f.tick(); await f.tick(); assert.equal(f.counts().buyCalls, 1); assert.equal(f.floors[0], 10n); assert.equal(f.result().status, "done"); assert.equal(f.result().lastHash, hash(1)); assert.equal(f.state.position("bsc", TOKEN)?.cost, 100n);
});

test("自动订单暂停、过期、黑名单与貔貅拦截不买入", async (t) => {
  const f = fixture(t); f.state.setAutoPaused(true); await f.tick(); assert.equal(f.counts().buyCalls, 0);
  f.state.setAutoPaused(false); f.state.setBlacklisted("token", "bsc", TOKEN, true); await f.tick(); assert.equal(f.result().status, "cancelled"); assert.equal(f.counts().buyCalls, 0);
});

test("自动订单过期直接结束，不检查报价或执行交易", async (t) => {
  const f = fixture(t, { expiresAt: 1000001 }); await f.tick(); assert.equal(f.result().status, "cancelled"); assert.equal(f.counts().buyCalls, 0);
});

test("定投只花设定次数预算，错过的时段不补买", async (t) => {
  const f = fixture(t, { kind: "dca", target: null, intervalMs: 300000, nextRunAt: 1010000, runsLeft: 2 });
  await f.tick(); assert.equal(f.result().spent, "100"); assert.equal(f.result().runsLeft, 1);
  await f.tick(950000); assert.equal(f.counts().buyCalls, 1); assert.ok(f.result().skipped > 0); assert.ok(f.result().nextRunAt! > Date.now());
  await f.tick(f.result().nextRunAt! - Date.now() + ORDER_INTERVAL_MS); assert.equal(f.counts().buyCalls, 2); assert.equal(f.result().spent, "200"); assert.equal(f.result().status, "done");
});

test("定投连续失败三次后暂停，未成交不扣次数和预算", async (t) => {
  const f = fixture(t, { kind: "dca", target: null, intervalMs: 300000, nextRunAt: 1010000, runsLeft: 2 }); f.fail(new Error("模拟余额不足"));
  await f.tick(); await f.tick(); await f.tick(); await f.tick(); assert.equal(f.counts().buyCalls, 3); assert.equal(f.result().status, "paused"); assert.equal(f.result().spent, "0"); assert.equal(f.result().runsLeft, 2);
});

test("上轮未结束不重复执行，结果未知停止重发并保留链上哈希", async (t) => {
  const f = fixture(t); let release!: () => void; f.wait(new Promise((r) => { release = r; })); await f.tick(); await f.tick(); assert.equal(f.counts().buyCalls, 1);
  f.fail(new PendingTransactionError(hash(5))); release(); await settle(); await f.tick(); assert.equal(f.counts().buyCalls, 1); assert.equal(f.result().status, "needs-check"); assert.match(f.result().note, new RegExp(hash(5))); assert.equal(f.result().lastHash, hash(5));
});

test("程序重启遇 executing 订单改为待核对，不重新买入", async (t) => {
  const f = fixture(t, { status: "executing" }); await f.tick(); assert.equal(f.result().status, "needs-check"); assert.equal(f.counts().buyCalls, 0);
});

test("未达限价不计失败；卖出不受买入黑名单和貔貅检测阻挡", async (t) => {
  const f = fixture(t, { kind: "limit-sell", amount: "0", pct: 50 }); f.honeypot(); f.state.setBlacklisted("token", "bsc", TOKEN, true);
  f.fail(new LimitNotMetError()); await f.tick(); assert.equal(f.result().failures, 0); assert.equal(f.result().status, "active");
  f.fail(null); await f.tick(); assert.equal(f.result().status, "done"); assert.equal(f.counts().sellCalls, 2);
});


test("等待报价时取消或全局暂停的订单，报价返回后不得继续下单", async (t) => {
  const f = fixture(t); let release!: () => void; f.quoteWait(new Promise((r) => { release = r; }));
  await f.tick(); f.store.update(f.order.id, { status: "cancelled" }); release(); await settle();
  assert.equal(f.counts().buyCalls, 0); assert.equal(f.result().status, "cancelled");
});

test("等待报价时全局暂停，不能在报价返回后买入", async (t) => {
  const f = fixture(t); let release!: () => void; f.quoteWait(new Promise((r) => { release = r; }));
  await f.tick(); f.state.setAutoPaused(true); release(); await settle(); assert.equal(f.counts().buyCalls, 0); assert.equal(f.result().status, "active");
});
