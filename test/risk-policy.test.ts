import assert from "node:assert/strict";
import { test } from "node:test";
import { filterBlocks, NO_FILTER, impactPct, blacklistReasons, parseRiskLimit } from "../src/risk-policy.ts";
import type { Route } from "../src/kyber.ts";

test("买入风控开启后未知税率、流动性与价差都拒绝，关闭则不拦截", () => {
  assert.deepEqual(filterBlocks(NO_FILTER, null, null), []);
  assert.equal(filterBlocks({ maxBuyTaxPct: 0, maxSellTaxPct: 5, minLiquidityUsd: 1000, maxImpactPct: 2 }, null, null).length, 4);
  assert.deepEqual(filterBlocks({ ...NO_FILTER, maxBuyTaxPct: 0 }, { isHoneypot: false, buyTax: 0, sellTax: null, liquidityUsd: null, risk: null, holders: null }, null), []);
});

test("缺失报价金额不应当作零美元而绕过价差限制", () => {
  const route: Route = { routerAddress: "0x1111111111111111111111111111111111111111", routeSummary: { amountIn: "1", amountOut: "1", gas: "1", amountInUsd: "100", amountOutUsd: "" } };
  assert.equal(impactPct(route), null);
  assert.equal(filterBlocks({ ...NO_FILTER, maxImpactPct: 5 }, null, route).length, 1);
  assert.ok(Math.abs(impactPct({ ...route, routeSummary: { ...route.routeSummary, amountOutUsd: "90" } })! - 10) < 1e-8);
});

test("黑名单只按指定链和地址判断，零 owner 不误拦截；风控数值边界", () => {
  const calls: string[] = [];
  const list = { isBlacklisted: (kind: string, chain: string, addr: string) => { calls.push(`${kind}:${chain}:${addr}`); return true; } };
  assert.deepEqual(blacklistReasons(list, { chain: "bsc", token: "token", owner: "0x0000" }), ["代币在黑名单中"]); assert.equal(calls.length, 1);
  assert.deepEqual(parseRiskLimit("0%", 100), { value: 0 }); assert.deepEqual(parseRiskLimit("off", 100), { value: null });
  for (const v of ["-1", "1e2", "100.01", "NaN"]) assert.equal(parseRiskLimit(v, 100), null);
});
