import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEther } from "viem";
import { broadcastEvm, gasOverrides, PRIVATE_EVM, validateExecution } from "../src/execution.ts";
import type { ExecutionSettings } from "../src/execution.ts";
import type { TradeDeps } from "../src/trade.ts";
import { CHAINS } from "../src/chains.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.ts";
const HASH = `0x${"1".repeat(64)}` as const;
function fixture(chain = "bsc") {
  let policy: ExecutionSettings = {}; let publicWrites = 0;
  const d = { chain: CHAINS[chain], execution: () => policy, clients: { walletClient: { sendTransaction: async () => { publicWrites++; return HASH; } } } } as unknown as TradeDeps;
  return { d, set: (p: ExecutionSettings) => { policy = p; }, writes: () => publicWrites };
}

test("私有发送只用指定通道，失败不回退公开节点，普通模式保持原发送", async () => {
  const f = fixture(); await broadcastEvm(f.d, {}); assert.equal(f.writes(), 1); f.set({ mev: true });
  let calls = 0;
  assert.equal(await broadcastEvm(f.d, {}, async (url) => { assert.equal(url, PRIVATE_EVM.bsc.url); calls++; return HASH; }), HASH);
  await assert.rejects(broadcastEvm(f.d, {}, async () => { calls++; throw new Error("private offline"); }), /private offline/);
  assert.equal(calls, 2); assert.equal(f.writes(), 1);
});

test("不支持的链和错误链 ID 无法私有发送，Flashbots 拒绝零优先费", async () => {
  const f = fixture("base"); f.set({ mev: true }); await assert.rejects(broadcastEvm(f.d, {}), /没有已验证/);
  assert.throws(() => validateExecution(f.d, {}), /尚无已验证/); assert.equal(f.writes(), 0);
  const eth = fixture("eth"); eth.set({ mev: true }); assert.throws(() => validateExecution(eth.d, { gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 0n }), /优先费/);
  assert.doesNotThrow(() => validateExecution(eth.d, { gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }));
});

test("Gas 上限包含 20% gas buffer，未知费用拒发，自定义单价使用整数", () => {
  const f = fixture(); f.set({ maxTxFee: formatEther(1199n) }); assert.throws(() => validateExecution(f.d, { gas: 100n, gasPrice: 10n }), /超过/);
  f.set({ maxTxFee: formatEther(1200n) }); assert.doesNotThrow(() => validateExecution(f.d, { gas: 100n, gasPrice: 10n }));
  assert.throws(() => validateExecution(f.d, { gas: 100n }), /无法核对/); assert.deepEqual(gasOverrides({ gasPriceGwei: "0.000000001" }), { gasPrice: 1n });
  assert.throws(() => gasOverrides({ gasPriceGwei: "0" }), /大于 0/);
});

test("恢复交易按钮默认不会偷偷清除发送保护和费用设置", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "execution-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json"); const state = new State(file);
  state.setChainSettings("bsc", { buySlippageBps: 50, execution: { mev: true, maxTxFee: "0.001" } }); state.resetChainSettings("bsc");
  assert.deepEqual(new State(file).chainSettings("bsc").execution, { mev: true, maxTxFee: "0.001" }); assert.equal(state.chainSettings("bsc").buySlippageBps, undefined);
});
