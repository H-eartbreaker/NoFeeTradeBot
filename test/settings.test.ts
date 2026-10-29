import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHAINS } from "../src/chains.ts";
import { routeIdentity, routePools } from "../src/kyber.ts";
import type { Route } from "../src/kyber.ts";
import { parseBuyPresets, parseNativeAmount, parseSellPercentage, parseSellPresets, tradingSettings } from "../src/settings.ts";
import { State } from "../src/state.ts";

test("自定义金额和比例只接受明确有效的输入", () => {
  assert.equal(parseNativeAmount("0.001"), 1000000000000000n);
  assert.equal(parseNativeAmount("0.000000000000000001"), 1n);
  for (const value of ["", "0", "-1", "1e3", "0x20", "1.1234567890123456789", "1".repeat(100)]) assert.equal(parseNativeAmount(value), null, value);
  assert.equal(parseSellPercentage("12.5%"), 12.5);
  assert.equal(parseSellPercentage("100"), 100);
  for (const value of ["0", "100.01", "99.999", "-10", "abc", "1e1"]) assert.equal(parseSellPercentage(value), null, value);
  assert.deepEqual(parseBuyPresets("0.001，0.002 0.001"), ["0.001", "0.002"]);
  assert.deepEqual(parseSellPresets("12.5 50% 100"), [12.5, 50, 100]);
  assert.equal(parseBuyPresets("1 2 3 4 5 6 7"), null);
  assert.equal(parseSellPresets("25 101"), null);
});

test("新设置兼容旧文件、分链隔离、重启保留，重置不损坏持仓", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "settings-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  const legacy = JSON.stringify({ tokens: ["0xabc"], slippageBps: 1500 });
  writeFileSync(path, legacy);
  const s = new State(path);
  assert.equal(readFileSync(path, "utf8"), legacy, "仅加载不自动迁移或改写正式数据");
  assert.equal(tradingSettings(s, CHAINS.bsc, 1000).buySlippageBps, 1500);
  assert.equal(tradingSettings(s, CHAINS.bsc, 1000).buyConfirmation, true);
  assert.equal(tradingSettings(s, CHAINS.bsc, 1000).quickBuy, false);
  s.recordBuy("bsc", "0xabc", 1000n);
  s.setChainSettings("base", { buySlippageBps: 3000, buyAmounts: ["0.002"], buyConfirmation: false });
  s.setDisplay({ timeZone: "UTC", hour12: true });
  const restored = new State(path);
  assert.equal(tradingSettings(restored, CHAINS.base, 1000).buySlippageBps, 3000);
  assert.equal(tradingSettings(restored, CHAINS.bsc, 1000).buySlippageBps, 1500);
  assert.deepEqual(restored.display, { showChart: true, showExplorer: true, timeZone: "UTC", hour12: true });
  restored.recordSell("bsc", "0xabc", 12.5);
  assert.equal(restored.position("bsc", "0xabc")!.cost, 875n);
  restored.resetChainSettings("base");
  assert.equal(tradingSettings(restored, CHAINS.base, 1000).buyConfirmation, true);
  assert.equal(restored.position("bsc", "0xabc")!.cost, 875n);
});

test("交易池身份包含路由、DEX和资产，去重且不因报价变化而变化", () => {
  const hop = { pool: "0xABC", exchange: "dex", tokenIn: "0xAAA", tokenOut: "0xBBB" };
  const route: Route = { routerAddress: "0x1111111111111111111111111111111111111111", routeSummary: { amountIn: "1", amountOut: "2", amountOutUsd: "1", gas: "1", route: [[hop, hop]] } };
  assert.equal(routePools(route).length, 1);
  assert.equal(routeIdentity(route), routeIdentity({ ...route, routeSummary: { ...route.routeSummary, amountOut: "3" } }));
  assert.notEqual(routeIdentity(route), routeIdentity({ ...route, routeSummary: { ...route.routeSummary, route: [[{ ...hop, pool: "0xDEF" }]] } }));
  assert.equal(routePools({ ...route, routeSummary: { ...route.routeSummary, route: null } }).length, 0);
});
