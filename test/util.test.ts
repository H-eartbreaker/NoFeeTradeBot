import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { State } from "../src/state.ts";
import { errMsg, escapeHtml, extractAddress, fmtUnits, parseSlippageInput, pctToBps } from "../src/util.ts";

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
  assert.equal(pctToBps(30), 3000);
  assert.equal(pctToBps(99.99), 9999);
  assert.equal(pctToBps(100), null);
  assert.equal(pctToBps(0.001), null);
  assert.equal(pctToBps(0), null);
  assert.equal(pctToBps(NaN), null);
});

test("滑点输入支持直接数字和百分号，拒绝模糊输入", () => {
  assert.equal(parseSlippageInput("30"), 3000);
  assert.equal(parseSlippageInput(" 30% "), 3000);
  assert.equal(parseSlippageInput("0.01％"), 1);
  for (const value of ["", "0", "100", "99.999", "-1", "30abc", "1e1", "0x20"]) {
    assert.equal(parseSlippageInput(value), null, value);
  }
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
  assert.equal(c.chains[0].key, "bsc");
  assert.equal(c.chains[0].buyAmounts.length, 3);
  assert.equal(c.defaultSlippageBps, 1000);
  assert.throws(() => loadConfig({ ...goodEnv, PRIVATE_KEY: "abc" }), /PRIVATE_KEY/);
  assert.throws(() => loadConfig({ ...goodEnv, ALLOWED_USER_ID: "x" }), /ALLOWED_USER_ID/);
  assert.throws(() => loadConfig({ ...goodEnv, CHAINS: "solana" }), /不支持/);
  assert.equal(loadConfig({ ...goodEnv, DEFAULT_SLIPPAGE_PCT: "30" }).defaultSlippageBps, 3000);
  assert.throws(() => loadConfig({ ...goodEnv, DEFAULT_SLIPPAGE_PCT: "100" }), /SLIPPAGE/);
  assert.equal(loadConfig({ ...goodEnv, RPC_URL: "https://x" }).chains[0].rpcUrls[0], "https://x");
  const multi = loadConfig({ ...goodEnv, CHAINS: "base,eth,rh", RPC_URL_ETH: "https://e", BUY_AMOUNTS_BASE: "0.01" });
  assert.deepEqual(multi.chains.map((x) => x.key), ["base", "eth", "rh"]);
  assert.equal(multi.chains[1].rpcUrls[0], "https://e");
  assert.equal(multi.chains[0].buyAmounts.length, 1);
});

const E = 10n ** 18n;


test("State 仓位成本、规则与旧格式迁移", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "st-"));
  const file = join(dir, "s.json");
  writeFileSync(file, JSON.stringify({ tokens: ["0xabc"], slippageBps: 500 }));
  const s = new State(file);
  assert.deepEqual(s.tokens("bsc"), ["0xabc"]);
  assert.equal(s.slippageBps, 500);

  s.setDefaultRule({ tp: 100, sl: 30 });
  s.recordBuy("bsc", "0xAbC", 10n);
  s.recordBuy("bsc", "0xabc", 10n);
  assert.equal(s.position("bsc", "0xabc")?.cost, 20n);
  assert.equal(s.position("bsc", "0xabc")?.tp, 100);
  s.setRule("bsc", "0xabc", { tp: null, sl: null });
  s.recordSell("bsc", "0xabc", 50);
  assert.equal(s.position("bsc", "0xabc")?.cost, 10n);
  assert.equal(new State(file).position("bsc", "0xabc")?.tp, null);
  s.recordSell("bsc", "0xabc", 100);
  assert.equal(s.position("bsc", "0xabc"), null);
});
