import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { errMsg, escapeHtml, extractAddress, fmtUnits, pctToBps } from "../src/util.ts";

const A = "0x55d398326f99059fF775485246999027B3197955";

test("extractAddress 提取并转小写", () => {
  assert.equal(extractAddress(`看这个 ${A} 怎么样`), A.toLowerCase());
  assert.equal(extractAddress("没有地址"), null);
  assert.equal(extractAddress("0x" + "a".repeat(41)), null);
});

test("fmtUnits 格式化", () => {
  assert.equal(fmtUnits(1_234_567_890_000_000_000_000n, 18), "1,234.56789");
  assert.equal(fmtUnits(0n, 18), "0");
  assert.equal(fmtUnits(1_000_000n, 6), "1");
});

test("pctToBps 边界", () => {
  assert.equal(pctToBps(10), 1000);
  assert.equal(pctToBps(20), 2000);
  assert.equal(pctToBps(20.1), null);
  assert.equal(pctToBps(0), null);
  assert.equal(pctToBps(NaN), null);
});

test("escapeHtml / errMsg", () => {
  assert.equal(escapeHtml("<b>&"), "&lt;b&gt;&amp;");
  assert.equal(errMsg(new Error("a\nb")), "a");
});

const goodEnv = {
  TELEGRAM_BOT_TOKEN: "t",
  ALLOWED_USER_ID: "123",
  PRIVATE_KEY: "0x" + "1".repeat(64),
};

test("loadConfig 默认值与校验", () => {
  const c = loadConfig(goodEnv);
  assert.equal(c.chain.key, "bsc");
  assert.equal(c.buyAmounts.length, 3);
  assert.equal(c.defaultSlippageBps, 1000);
  assert.throws(() => loadConfig({ ...goodEnv, PRIVATE_KEY: "abc" }), /PRIVATE_KEY/);
  assert.throws(() => loadConfig({ ...goodEnv, ALLOWED_USER_ID: "x" }), /ALLOWED_USER_ID/);
  assert.throws(() => loadConfig({ ...goodEnv, CHAIN: "solana" }), /不支持/);
  assert.throws(() => loadConfig({ ...goodEnv, DEFAULT_SLIPPAGE_PCT: "50" }), /SLIPPAGE/);
  assert.equal(loadConfig({ ...goodEnv, RPC_URL: "https://x" }).chain.rpcUrls[0], "https://x");
});
