import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { address } from "@solana/kit";
import type { KeyPairSigner, Signature } from "@solana/kit";
import { SolanaWallet } from "../src/sol-wallet.ts";
import { holdings, mintInfo, quote, swapTransaction, SOL_MINT, TOKEN_PROGRAMS, isSolanaAddress } from "../src/sol-chain.ts";
import type { SolRpc } from "../src/sol-chain.ts";
import { buySol, sellToken, serial, awaitLanding, SolPendingError } from "../src/sol-trade.ts";
import { parseSolAmount, parseSolPresets, solSettings } from "../src/sol-settings.ts";
import { State } from "../src/state.ts";
import { loadConfig } from "../src/config.ts";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = address(SOL_MINT);

test("SOL 精度、金额上限、按钮去重以及分链设置/旧滑点迁移", (t) => {
  for (const v of ["0", "-1", "1e3", "100.000000001", "0.0000000001"]) assert.equal(parseSolAmount(v), null);
  assert.equal(parseSolAmount("0.000000001"), 1n); assert.equal(parseSolAmount("100"), 100000000000n);
  assert.deepEqual(parseSolPresets("0.10, 0.1 100"), ["0.1", "100"]); assert.equal(parseSolPresets("1 2 3 4 5 6 7"), null);
  const dir = mkdtempSync(join(tmpdir(), "sol-settings-")); t.after(() => rmSync(dir, { recursive: true, force: true })); const file = join(dir, "state.json");
  const state = new State(file); state.setSolanaSlippageBps(250); state.setChainSettings("sol", { buySlippageBps: 300, buyAmounts: ["0.000000001"] });
  const result = solSettings(new State(file)); assert.equal(result.buySlippageBps, 300); assert.equal(result.sellSlippageBps, 250); assert.equal(result.buyAmounts[0], 1n); assert.equal(state.chainSettings("bsc").buySlippageBps, undefined);
});

test("Solana 测试钱包只写临时 .env，权限 0600，签名器地址一致且不可覆盖", async (t) => {
  assert.equal(process.env.SOLANA_PRIVATE_KEY, undefined, "测试前必须清除真实 Solana 私钥环境变量");
  const dir = mkdtempSync(join(tmpdir(), "sol-wallet-")); t.after(() => rmSync(dir, { recursive: true, force: true })); const file = join(dir, ".env");
  writeFileSync(file, "UNCHANGED=example\nSOLANA_PRIVATE_KEY= \n", { mode: 0o600 });
  const wallet = new SolanaWallet(file); const addr = wallet.generate(); const saved = readFileSync(file, "utf8");
  assert.ok(isSolanaAddress(addr)); assert.equal((await wallet.signer()).address, addr); assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(parseEnv(saved).UNCHANGED, "example"); assert.equal(saved.split("\n").filter((line) => line.startsWith("SOLANA_PRIVATE_KEY=")).length, 1);
  assert.throws(() => wallet.generate(), /不会覆盖/); assert.throws(() => new SolanaWallet(file).generate(), /未覆盖/); assert.equal(readFileSync(file, "utf8"), saved);
});

test("Solana 缺配置、并发保存锁和错误私钥均拒绝，文件不变且错误不泄露私钥", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sol-key-error-")); t.after(() => rmSync(dir, { recursive: true, force: true })); const file = join(dir, ".env");
  assert.throws(() => new SolanaWallet(file).generate(), /不存在/);
  writeFileSync(file, "SAFE=value\n"); mkdirSync(join(dir, "data")); writeFileSync(join(dir, "data/wallet-env.lock"), "");
  assert.throws(() => new SolanaWallet(file).generate(), /正在进行/); assert.equal(readFileSync(file, "utf8"), "SAFE=value\n");
  const secret = "not-a-test-secret!"; process.env.SOLANA_PRIVATE_KEY = secret;
  try { assert.throws(() => new SolanaWallet(file), (e: unknown) => e instanceof Error && !e.message.includes(secret) && /格式/.test(e.message)); }
  finally { delete process.env.SOLANA_PRIVATE_KEY; }
});

const account = (mint: string, amount: string, decimals = 6) => ({ account: { data: { parsed: { type: "account", info: { mint, tokenAmount: { amount, decimals } } } } } });

test("Solana 聚合 SPL 与 Token-2022 同 mint 余额，跳过零余额", async () => {
  const rpc = { getTokenAccountsByOwner: (_owner: unknown, filter: { programId: string }) => ({ send: async () => ({ value: filter.programId === TOKEN_PROGRAMS.spl ? [account(MINT, "3"), account(SOL_MINT, "0")] : [account(MINT, "7")] }) }) } as unknown as SolRpc;
  assert.deepEqual(await holdings(rpc, OWNER), [{ mint: MINT, amount: 10n, decimals: 6 }]);
});

test("Solana 代币校验拒绝错误 owner/非 mint，增发和冻结权限如实读取", async () => {
  let owner: string = TOKEN_PROGRAMS.spl; let type = "mint";
  const rpc = { getAccountInfo: () => ({ send: async () => ({ value: { owner, data: { parsed: { type, info: { decimals: 6, mintAuthority: MINT, freezeAuthority: null } } } } }) }) } as unknown as SolRpc;
  assert.deepEqual(await mintInfo(rpc, MINT), { decimals: 6, mintAuthority: MINT, freezeAuthority: null });
  owner = SOL_MINT; await assert.rejects(mintInfo(rpc, MINT), /不是代币/); owner = TOKEN_PROGRAMS.token2022; type = "account"; await assert.rejects(mintInfo(rpc, MINT), /不是代币/);
  for (const bad of ["0".repeat(32), "O".repeat(44), "I".repeat(32), "l".repeat(32), "1".repeat(31), "1".repeat(45)]) assert.equal(isSolanaAddress(bad), false);
});

test("Jupiter 报价/构建仅模拟 HTTP，核对请求金额并正确处理失败响应", async (t) => {
  let fail = false; let builds = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    if (fail) return Response.json({ error: "unavailable" }, { status: 503 });
    if (String(url).includes("/quote?")) { const params = new URL(String(url)).searchParams; assert.equal(params.get("amount"), "10"); assert.equal(params.get("slippageBps"), "100"); return Response.json({ inAmount: "10", outAmount: "20", otherAmountThreshold: "19" }); }
    builds++; assert.equal(JSON.parse(String(init?.body)).userPublicKey, OWNER);
    return Response.json({ swapTransaction: "unsigned-test", lastValidBlockHeight: 123 });
  });
  const q = await quote(SOL_MINT, MINT, 10n, 100); const built = await swapTransaction(q, OWNER); assert.equal(built.lastValidBlockHeight, 123n); assert.equal(builds, 1);
  fail = true; await assert.rejects(quote(SOL_MINT, MINT, 10n, 100), /报价失败/); await assert.rejects(swapTransaction(q, OWNER), /生成交易失败/);
});

test("Solana 余额/手续费不足、非法卖出比例和持仓变化不广播", async (t) => {
  let balance = 1n; let sends = 0;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("不允许联网"); });
  const signer = { address: OWNER } as KeyPairSigner;
  const rpc = { getBalance: () => ({ send: async () => ({ value: balance }) }),
    getTokenAccountsByOwner: () => ({ send: async () => ({ value: [account(MINT, "10000")] }) }),
    sendTransaction: () => { sends++; throw new Error("禁止广播"); } } as unknown as SolRpc;
  await assert.rejects(buySol(rpc, signer, MINT, 10n, 100), /余额不足/);
  await assert.rejects(sellToken(rpc, signer, MINT, 25, 100), /余额不足/);
  balance = 1000000000n;
  for (const pct of [0, -1, 100.01, NaN, 1.001]) await assert.rejects(sellToken(rpc, signer, MINT, pct, 100), /比例无效/);
  await assert.rejects(sellToken(rpc, signer, MINT, 25, 100, { inAmount: "4999", outAmount: "1", otherAmountThreshold: "1" }), /持仓数量已变化/);
  assert.equal(sends, 0);
});

test("Solana 同钱包排队，其他钱包独立，失败后后续任务仍能执行", async () => {
  let release!: () => void; const events: string[] = [];
  const first = serial("a", async () => { await new Promise<void>((r) => { release = r; }); events.push("first"); });
  const second = serial("a", async () => { events.push("second"); });
  await serial("b", async () => { events.push("other"); }); assert.deepEqual(events, ["other"]);
  release(); await Promise.all([first, second]); assert.deepEqual(events, ["other", "first", "second"]);
  await assert.rejects(serial("a", async () => { throw new Error("expected"); })); assert.equal(await serial("a", async () => 7), 7);
});


test("Solana 链上确认/失败/过期分别判断，并先读区块高度再查签名", async () => {
  const signature = "test-signature" as Signature; const sequence: string[] = []; let status: { err: object | null; confirmationStatus: string } | null = { err: null, confirmationStatus: "confirmed" };
  const rpc = { getBlockHeight: () => ({ send: async () => { sequence.push("height"); return 100n; } }), getSignatureStatuses: () => ({ send: async () => { sequence.push("status"); return { value: [status] }; } }) } as unknown as SolRpc;
  await awaitLanding(rpc, signature, 50n); assert.deepEqual(sequence, ["height", "status"]);
  status = { err: { failed: true }, confirmationStatus: "confirmed" }; await assert.rejects(awaitLanding(rpc, signature, 50n), /执行失败/);
  status = null; await assert.rejects(awaitLanding(rpc, signature, 50n), /过期未上链/);
});

test("Solana 广播后断网或等确认超时，保留签名为待确认，不能误报为可重试失败", async (t) => {
  const signature = "test-signature" as Signature;
  const rpc = { getBlockHeight: () => ({ send: async () => { throw new Error("offline"); } }) } as unknown as SolRpc;
  await assert.rejects(awaitLanding(rpc, signature, 50n), (e: unknown) => e instanceof SolPendingError && e.signature === signature);
  let time = 0; t.mock.method(Date, "now", () => { time += 120001; return time; });
  await assert.rejects(awaitLanding(rpc, signature, 50n), (e: unknown) => e instanceof SolPendingError && e.signature === signature);
});


test("Solana 默认使用已验证能查持仓的官方免费 RPC，保留用户自定义节点", () => {
  const env = { TELEGRAM_BOT_TOKEN: "test", ALLOWED_USER_ID: "1", PRIVATE_KEY: "0x" + "1".repeat(64) };
  assert.equal(loadConfig(env).solanaRpcUrl, "https://api.mainnet-beta.solana.com");
  assert.equal(loadConfig({ ...env, SOLANA_RPC_URL: "https://example.invalid/rpc" }).solanaRpcUrl, "https://example.invalid/rpc");
});
