import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrderStore, triggered, targetPrice, metricValue, minimumTokensOut, minimumNativeOut, nextSlot, MAX_OPEN_ORDERS } from "../src/orders.ts";
import type { Order } from "../src/orders.ts";

export function sampleOrder(patch: Partial<Order> = {}): Order {
  return { id: "111111111111", kind: "limit-buy", wallet: "main", chain: "bsc", token: "0x1111111111111111111111111111111111111111", symbol: "TEST", decimals: 6,
    status: "active", createdAt: 0, expiresAt: null, target: "10", amount: "100", pct: null, intervalMs: null, runsLeft: null, nextRunAt: null,
    spent: "0", runs: 0, skipped: 0, failures: 0, note: "", lastHash: null, ...patch };
}

test("限价/市值的买卖触发方向、相等边界与总量换算", () => {
  for (const kind of ["limit-buy", "mcap-buy"] as const) { assert.equal(triggered(kind, 9n, 10n), true); assert.equal(triggered(kind, 11n, 10n), false); assert.equal(triggered(kind, 10n, 10n), true); }
  for (const kind of ["limit-sell", "mcap-sell"] as const) { assert.equal(triggered(kind, 9n, 10n), false); assert.equal(triggered(kind, 11n, 10n), true); }
  assert.equal(metricValue("mcap-buy", 2n, 3000000n, 6), 6n);
  assert.equal(targetPrice("mcap-buy", 6n, 3000000n, 6), 2n);
  assert.throws(() => targetPrice("mcap-buy", 1n, 0n, 6));
});

test("限价最小到手量向上取整，不能因舍入突破目标价", () => {
  assert.equal(minimumTokensOut(10n, 3n, 0), 4n);
  assert.equal(minimumNativeOut(1n, 1n, 6), 1n);
  assert.equal(targetPrice("mcap-sell", 10n, 3n, 0), 4n);
  assert.equal(minimumTokensOut(10n, 2n, 6), 5000000n);
});

test("订单保存、隔离返回值与重启读取，损坏文件不静默清空", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orders-")); t.after(() => rmSync(dir, { recursive: true, force: true })); const file = join(dir, "orders.json");
  const store = new OrderStore(file); store.add(sampleOrder()); const copy = store.get("111111111111")!; copy.status = "done";
  assert.equal(store.get(copy.id)?.status, "active");
  store.update(copy.id, { status: "paused" }); assert.equal(new OrderStore(file).get(copy.id)?.status, "paused");
  writeFileSync(file, "broken"); assert.throws(() => new OrderStore(file), /损坏/);
});

test("订单上限与重复 ID 不会增加重复任务", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "order-limits-")); t.after(() => rmSync(dir, { recursive: true, force: true })); const store = new OrderStore(join(dir, "orders.json"));
  store.add(sampleOrder()); assert.throws(() => store.add(sampleOrder()), /存在|重复/);
  for (let i = 1; i < MAX_OPEN_ORDERS; i++) store.add(sampleOrder({ id: String(i) }));
  assert.throws(() => store.add(sampleOrder({ id: "overflow" })), /上限/);
  assert.equal(store.openCount(), MAX_OPEN_ORDERS);
});

test("定投错过时段只计算下一次，不返回过去时点", () => {
  assert.equal(nextSlot(100, 10, 100), 110); assert.equal(nextSlot(100, 10, 130), 140);
});
