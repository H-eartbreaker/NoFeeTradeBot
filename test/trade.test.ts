import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { maxUint256 } from "viem";
import { CHAINS } from "../src/chains.ts";
import { routeIdentity } from "../src/kyber.ts";
import type { Route } from "../src/kyber.ts";
import { buy, sell, serial, queueKey } from "../src/trade.ts";
import type { TradeDeps } from "../src/trade.ts";

const TOKEN = "0x55d398326f99059ff775485246999027b3197955";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const ROUTE: Route = { routerAddress: ADDRESS, routeSummary: { amountIn: "1000", amountOut: "100", amountOutUsd: "1", gas: "100", route: [[{ pool: "pool-a", exchange: "dex" }]] } };
function fixture(t: TestContext) {
  let writes = 0;
  let quotedAmount = "";
  let currentRoute = ROUTE;
  let nativeInput = false;
  let buildSlippage: number | undefined;
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/routes?")) {
      quotedAmount = new URL(String(url)).searchParams.get("amountIn")!;
      nativeInput = new URL(String(url)).searchParams.get("tokenIn") === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      return Response.json({ code: 0, data: { ...currentRoute, routeSummary: { ...currentRoute.routeSummary, amountIn: quotedAmount } } });
    }
    assert.ok(String(url).endsWith("/route/build"));
    const body = JSON.parse(init!.body as string);
    buildSlippage = body.slippageTolerance;
    return Response.json({ code: 0, data: { data: "0x12345678", routerAddress: ADDRESS, amountOut: body.routeSummary.amountOut, transactionValue: nativeInput ? body.routeSummary.amountIn : "0" } });
  });
  const d = { chain: CHAINS.bsc, clients: {
    account: { address: ADDRESS },
    publicClient: {
      getBalance: async () => 10n ** 18n,
      readContract: async (args: { functionName: string; blockNumber?: bigint }) => args.functionName === "allowance" ? maxUint256 : args.blockNumber ? 1100n : 1000n,
      waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 7n, gasUsed: 100n, effectiveGasPrice: 1n }),
    },
    walletClient: { chain: CHAINS.bsc.viemChain, prepareTransactionRequest: async (args: object) => ({ ...args, gas: 100n, gasPrice: 1n }), sendTransaction: async () => { writes++; return `0x${"1".repeat(64)}`; } },
  } } as unknown as TradeDeps;
  return { d, writes: () => writes, quotedAmount: () => quotedAmount, buildSlippage: () => buildSlippage, setOutput: (amountOut: string) => { currentRoute = { ...ROUTE, routeSummary: { ...ROUTE.routeSummary, amountOut } }; }, changePool: () => { currentRoute = { ...ROUTE, routeSummary: { ...ROUTE.routeSummary, route: [[{ pool: "pool-b", exchange: "dex" }]] } }; } };
}
test("确认后换池或风控失败，实际交易层不广播", async (t) => {
  const f = fixture(t);
  f.changePool();
  await assert.rejects(buy(f.d, TOKEN, 1000n, 1000, Promise.resolve(), { route: routeIdentity(ROUTE), minimumOutput: 90n }), /交易池或路由已变化/);
  assert.equal(f.writes(), 0);
  const gate = Promise.reject(new Error("风险检查失败")); gate.catch(() => undefined);
  await assert.rejects(buy(f.d, TOKEN, 1000n, 1000, gate), /风险检查失败/);
  assert.equal(f.writes(), 0);
});
test("确认后的新报价不能低于确认页的最低可接受数量", async (t) => {
  const f = fixture(t); f.setOutput("80");
  await assert.rejects(buy(f.d, TOKEN, 1000n, 1000, Promise.resolve(), { route: routeIdentity(ROUTE), minimumOutput: 90n }), /价格已超出确认时/);
  assert.equal(f.writes(), 0);
});
test("价格在允许范围内变化时收紧构建滑点，保留确认页的下限", async (t) => {
  const f = fixture(t); f.setOutput("95");
  await buy(f.d, TOKEN, 1000n, 1000, Promise.resolve(), { route: routeIdentity(ROUTE), minimumOutput: 90n });
  assert.equal(f.writes(), 1);
  assert.equal(f.buildSlippage(), 526);
});
test("自定义小数卖出比例在交易层按整数基点计算", async (t) => {
  const f = fixture(t);
  const result = await sell(f.d, TOKEN, 12.5, 1000);
  assert.equal(result.soldAmount, 125n);
  assert.equal(f.quotedAmount(), "125");
  assert.equal(f.writes(), 1);
  await assert.rejects(sell(f.d, TOKEN, 101, 1000), /卖出比例/);
  assert.equal(f.writes(), 1);
});
test("排队期间过期的确认在交易层被拒绝，风控在出队后执行", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const blocking = serial(() => new Promise<void>((resolve) => { release = resolve; }), queueKey(f.d));
  await new Promise((resolve) => setImmediate(resolve));
  let checks = 0;
  const now = Date.now();
  const pending = buy(f.d, TOKEN, 1000n, 1000, async () => { checks++; }, { route: routeIdentity(ROUTE), minimumOutput: 90n, expiresAt: now + 60_000 });
  t.mock.method(Date, "now", () => now + 61_000);
  release(); await blocking;
  await assert.rejects(pending, /确认已过期/);
  assert.equal(checks, 0); assert.equal(f.writes(), 0);
});
test("金额卖出使用确认的精确代币数，保留最低输出；余额变化或价格变化拒发", async (t) => {
  const f = fixture(t);
  const confirmation = { amount: 133n, balance: 1000n, route: routeIdentity(ROUTE), minimumOutput: 90n, maxGasCost: 1000n, expiresAt: Date.now() + 60000 };
  const result = await sell(f.d, TOKEN, 13.3, 1000, confirmation);
  assert.equal(result.soldAmount, 133n); assert.equal(result.balanceBefore, 1000n); assert.equal(f.quotedAmount(), "133");
  await assert.rejects(sell(f.d, TOKEN, 13.3, 1000, { ...confirmation, balance: 999n }), /余额已变化/);
  f.setOutput("80"); await assert.rejects(sell(f.d, TOKEN, 13.3, 1000, confirmation), /价格超出/);
  assert.equal(f.writes(), 1);
});
