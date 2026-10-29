import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Bot } from "grammy";
import type { InlineKeyboard } from "grammy";
import { decodeFunctionData, erc20Abi } from "viem";
import type { Address, Hex } from "viem";
import { assets, parseAssetAmount } from "../src/assets.ts";
import { bridge, bridgeQuote, bridgeStatus, startBridgeMonitor } from "../src/bridge.ts";
import type { BridgeQuote } from "../src/bridge.ts";
import { CHAINS } from "../src/chains.ts";
import { registerFundsPanel } from "../src/funds-panel.ts";
import { Journal } from "../src/journal.ts";
import { NATIVE } from "../src/kyber.ts";
import type { Route } from "../src/kyber.ts";
import { Logos } from "../src/logos.ts";
import { feeBudget, swapCurrency, transfer, transferData } from "../src/money.ts";
import { State } from "../src/state.ts";
import { ConfirmedTransactionError, PendingTransactionError, queueKey, serial } from "../src/trade.ts";
import type { TradeDeps } from "../src/trade.ts";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;
const HASH = `0x${"a".repeat(64)}` as Hex;
const ROUTE: Route = { routerAddress: RECIPIENT, routeSummary: { amountIn: "1000", amountOut: "1000", amountOutUsd: "1", gas: "100", route: [[{ pool: RECIPIENT, exchange: "Test" }]] } };
function directory(t: TestContext) { const dir = mkdtempSync(join(tmpdir(), "funds-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function fixture(t: TestContext) {
  const dir = directory(t); const journal = new Journal(join(dir, "trades.jsonl"));
  const writes: { to: Address; data: Hex; value: bigint }[] = [];
  let native = 10n ** 18n; let allowance = 0n; let gas = 100n; let receiptFails = false; let afterFails = false;
  const d = { walletId: "main", chain: CHAINS.bsc, journal, clients: { account: { address: OWNER }, publicClient: {
    getBalance: async (arg?: { blockNumber?: bigint }) => { if (arg?.blockNumber && afterFails) throw new Error("lag"); return arg?.blockNumber ? native + 1000n - 100n : native; },
    readContract: async (p: { functionName: string; blockNumber?: bigint }) => p.functionName === "decimals" ? 18 : p.functionName === "allowance" ? allowance : p.blockNumber ? 200000n : 100000n,
    getGasPrice: async () => 1n, estimateGas: async () => gas,
    waitForTransactionReceipt: async () => { if (receiptFails) throw new Error("timeout"); return { status: "success", blockNumber: 7n, gasUsed: 100n, effectiveGasPrice: 1n }; },
  }, walletClient: { chain: CHAINS.bsc.viemChain, prepareTransactionRequest: async (tx: object) => ({ ...tx, gas, gasPrice: 1n }),
    sendTransaction: async (tx: { to: Address; data: Hex; value: bigint }) => { writes.push(tx); return `0x${String(writes.length).repeat(64)}` as Hex; } } } } as unknown as TradeDeps;
  return { d, journal, writes, native: (v: bigint) => { native = v; }, gas: (v: bigint) => { gas = v; }, allowance: (v: bigint) => { allowance = v; }, timeout: () => { receiptFails = true; }, afterFails: () => { afterFails = true; } };
}
function kyber(t: TestContext, options: { low?: boolean; badBuild?: boolean } = {}) {
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/routes?")) {
      const amount = new URL(String(url)).searchParams.get("amountIn")!;
      return Response.json({ code: 0, data: { ...ROUTE, routeSummary: { ...ROUTE.routeSummary, amountIn: amount, amountOut: options.low ? "1" : "1000" } } });
    }
    return Response.json({ code: 0, data: { routerAddress: RECIPIENT, data: "0x12345678", amountOut: options.badBuild ? "1" : "1000", transactionValue: "0" } });
  });
}

test("金额保留币种精度；转账正确编码地址与金额，Gas 预算累计而非每笔重置", () => {
  assert.equal(parseAssetAmount("1.000001", 6), 1000001n);
  for (const bad of ["0", "-1", "1e3", "1.0000001", "10 USDT"]) assert.equal(parseAssetAmount(bad, 6), null);
  const native = assets({ chain: CHAINS.bsc } as TradeDeps)[0];
  assert.deepEqual(transferData(native, RECIPIENT, 123n), { to: RECIPIENT, value: 123n, data: "0x" });
  const stable = assets({ chain: CHAINS.bsc } as TradeDeps)[1];
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transferData(stable, RECIPIENT, 123n).data }).args, [RECIPIENT, 123n]);
  assert.throws(() => transferData(native, "0x0000000000000000000000000000000000000000", 1n));
  const validate = feeBudget(Date.now() + 60000, 250n); validate({ gas: 100n, gasPrice: 1n }); validate({ gas: 100n, gasPrice: 1n });
  assert.throws(() => validate({ gas: 100n, gasPrice: 1n }), /预算/);
});
test("转账过期、余额不足、费用变高或队列中过期都不广播；成功记录完整币种信息", async (t) => {
  const f = fixture(t); const asset = assets(f.d)[0];
  await assert.rejects(transfer(f.d, asset, RECIPIENT, 1n, Date.now() - 1, 1000n), /过期/);
  await assert.rejects(transfer(f.d, asset, RECIPIENT, 10n ** 19n, Date.now() + 60000, 1000n), /余额不足/);
  await assert.rejects(transfer(f.d, asset, RECIPIENT, 1n, Date.now() + 60000, 100n), /预算/);
  assert.equal(f.writes.length, 0);
  await transfer(f.d, asset, RECIPIENT, 1000n, Date.now() + 60000, 1000n);
  assert.equal(f.writes.length, 1); const entry = f.journal.entries()[0];
  assert.equal(entry.recipient, RECIPIENT); assert.equal(entry.symbol, "BNB"); assert.equal(entry.amountIn, "1000"); assert.equal(entry.status, "confirmed");
  let release!: () => void;
  const blocked = serial(() => new Promise<void>((r) => { release = r; }), queueKey(f.d)); await new Promise((r) => setImmediate(r));
  const expires = Date.now() + 60000; const queued = transfer(f.d, asset, RECIPIENT, 1n, expires, 1000n);
  t.mock.method(Date, "now", () => expires + 1); release(); await blocked;
  await assert.rejects(queued, /过期/); assert.equal(f.writes.length, 1);
});
test("转账回执超时保留 hash，下一次操作不会自动补发", async (t) => {
  const f = fixture(t); f.timeout(); const asset = assets(f.d)[0];
  await assert.rejects(transfer(f.d, asset, RECIPIENT, 1n, Date.now() + 60000, 1000n), PendingTransactionError);
  await assert.rejects(transfer(f.d, asset, RECIPIENT, 1n, Date.now() + 60000, 1000n), PendingTransactionError);
  assert.equal(f.writes.length, 1); assert.ok(f.journal.entries()[0].hash);
});
test("稳定币兑换精确授权，旧额度先清零；行情变差不先浪费授权，构建输出不符拒发", async (t) => {
  const f = fixture(t); f.allowance(1n); kyber(t); const [native, stable] = assets(f.d);
  const r = await swapCurrency(f.d, stable, native, 1000n, 1000, ROUTE, Date.now() + 60000, 1000n);
  assert.equal(r.received, 1000n); assert.equal(f.writes.length, 3);
  const approvals = f.writes.slice(0, 2).map((tx) => decodeFunctionData({ abi: erc20Abi, data: tx.data }).args);
  assert.deepEqual(approvals, [[RECIPIENT, 0n], [RECIPIENT, 1000n]]);
  assert.equal(f.journal.entries()[0].outputSymbol, "BNB"); assert.equal(f.journal.entries()[0].amountOutEstimated, true);
  t.mock.restoreAll(); const bad = fixture(t); kyber(t, { low: true });
  await assert.rejects(swapCurrency(bad.d, stable, native, 1000n, 1000, ROUTE, Date.now() + 60000, 1000n), /报价/); assert.equal(bad.writes.length, 0);
  t.mock.restoreAll(); const built = fixture(t); built.allowance(1000n); kyber(t, { badBuild: true });
  await assert.rejects(swapCurrency(built.d, stable, native, 1000n, 1000, ROUTE, Date.now() + 60000, 1000n), /输出/); assert.equal(built.writes.length, 0);
});
test("兑换已成交但 RPC 余额滞后时，不误报为失败或自动重发", async (t) => {
  const f = fixture(t); kyber(t); f.allowance(1000n); f.afterFails(); const [native, stable] = assets(f.d);
  await assert.rejects(swapCurrency(f.d, stable, native, 1000n, 1000, ROUTE, Date.now() + 60000, 1000n), ConfirmedTransactionError);
  assert.equal(f.journal.entries()[0].status, "confirmed"); assert.equal(f.writes.length, 1);
});

function relayBody() { return { details: { sender: OWNER, recipient: OWNER, currencyIn: { currency: { chainId: 56, address: "0x0000000000000000000000000000000000000000" }, amount: "1000" }, currencyOut: { currency: { chainId: 8453, address: "0x0000000000000000000000000000000000000000" }, amount: "900", minimumAmount: "800" }, timeEstimate: 5 }, fees: { app: { amount: "0" }, relayer: { amountUsd: "0.01" }, gas: { amountUsd: "0.001" } }, steps: [{ kind: "transaction", requestId: HASH, items: [{ data: { from: OWNER, to: RECIPIENT, chainId: 56, value: "1000", data: "0x12345678" } }] }] }; }
test("跨链报价核对来源/目标/收款人/金额和平台费，拒绝多步骤或任意签名", async (t) => {
  const f = fixture(t); let body = relayBody();
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const quote = await bridgeQuote(f.d, CHAINS.base, 1000n); assert.equal(quote.minimumOut, 800n);
  await bridge(f.d, quote, 1000n); const entry = f.journal.entries()[0];
  assert.equal(entry.status, "confirmed"); assert.equal(entry.bridgeStatus, "pending"); assert.equal(entry.amountOut, undefined); assert.equal(entry.quotedAmountOut, "900");
  for (const change of [(b: ReturnType<typeof relayBody>) => { b.details.recipient = RECIPIENT; }, (b: ReturnType<typeof relayBody>) => { b.details.currencyOut.currency.chainId = 1; }, (b: ReturnType<typeof relayBody>) => { b.steps[0].items[0].data.value = "2000"; }, (b: ReturnType<typeof relayBody>) => { b.fees.app.amount = "1"; }, (b: ReturnType<typeof relayBody>) => { b.steps[0].kind = "signature"; }]) {
    body = relayBody(); change(body); await assert.rejects(bridgeQuote(f.d, CHAINS.base, 1000n));
  }
  assert.equal(f.writes.length, 1);
});
test("跨链状态独立轮询，重启已有待到账记录继续查询而不重新发送", async (t) => {
  const f = fixture(t); const id = f.journal.start({ wallet: "main", chain: "bsc", kind: "bridge", requestId: HASH, destinationChain: "base", bridgeStatus: "pending" }); f.journal.update(id, { status: "confirmed", hash: HASH });
  t.mock.timers.enable({ apis: ["setInterval"] }); let calls = 0; const notices: string[] = [];
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ status: "success" }); });
  const stop = startBridgeMonitor(f.journal, async (message) => { notices.push(message); });
  t.mock.timers.tick(15000); await new Promise((r) => setImmediate(r));
  assert.equal(f.journal.entries()[0].bridgeStatus, "success"); assert.equal(notices.length, 1); assert.equal(f.writes.length, 0);
  t.mock.timers.tick(15000); await new Promise((r) => setImmediate(r)); assert.equal(calls, 1); stop();
  await assert.rejects(bridgeStatus("../../other"));
});

function ui(t: TestContext) {
  const f = fixture(t); const state = new State(join(directory(t), "state.json")); const bot = new Bot("123:test");
  bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot" } as never;
  const messages: { text: string; kb?: InlineKeyboard }[] = []; let sends = 0; let failMessages = false; let failOperation: Error | null = null; let holdQuote: (() => Promise<void>) | null = null;
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "answerCallbackQuery") return { ok: true, result: true } as never;
    assert.equal(method, "sendMessage"); if (failMessages) throw new Error("Telegram offline");
    const p = payload as { text: string; reply_markup?: InlineKeyboard }; assert.ok(p.text.length < 4096);
    messages.push({ text: p.text, kb: p.reply_markup }); return { ok: true, result: { message_id: messages.length, date: 0, chat: { id: 123, type: "private" }, text: p.text } } as never;
  });
  let clear!: () => void;
  bot.use(async (ctx, next) => { if (ctx.from?.id !== 123) return; if (ctx.callbackQuery && !ctx.callbackQuery.data?.startsWith("funds:")) clear(); await next(); });
  clear = registerFundsPanel(bot, { chains: [CHAINS.bsc, CHAINS.base], logos: new Logos(state), activeChain: () => "bsc", activeWallet: () => "main", deps: (chain, wallet) => chain === "bsc" && wallet === "main" ? f.d : undefined, slippage: () => 1000 }, {
    assetBalance: async () => 10n ** 18n, verifyAsset: async () => undefined, transferEstimate: async () => ({ tx: { to: RECIPIENT, value: 0n, data: "0x" }, gasCost: 1000n }),
    getRoute: async (_c, _a, _b, amount) => { await holdQuote?.(); return { ...ROUTE, routeSummary: { ...ROUTE.routeSummary, amountIn: amount.toString() } }; }, swapBudget: async () => 1000n,
    transfer: async () => { sends++; if (failOperation) throw failOperation; return { hash: HASH, receipt: {} as never, journalId: undefined }; },
    swapCurrency: async () => { sends++; return { hash: HASH, receipt: {} as never, journalId: undefined, received: 1000n }; },
    bridgeQuote: async (_d, destination, amount) => ({ requestId: HASH, to: RECIPIENT, data: "0x12345678", value: amount, fromChain: 56, destination: destination.key, recipient: OWNER, amountOut: 900n, minimumOut: 800n, relayerUsd: "0.01", gasUsd: "0.001", seconds: 5, expires: Date.now() + 60000 }),
    bridgeBudget: async () => 1000n, bridge: async () => { sends++; return { hash: HASH, receipt: {} as never, journalId: undefined }; },
  });
  let id = 0; const user = (n: number) => ({ id: n, is_bot: false, first_name: "User" });
  const callback = async (data: string, n = 123) => bot.handleUpdate({ update_id: ++id, callback_query: { id: String(id), from: user(n), chat_instance: "test", data, message: { message_id: 1, date: 0, chat: { id: n, type: "private", first_name: "User" }, text: "card" } } });
  const send = async (text: string, n = 123) => bot.handleUpdate({ update_id: ++id, message: { message_id: id, date: 0, from: user(n), chat: { id: n, type: "private", first_name: "User" }, text } });
  const confirm = () => messages.flatMap((m) => m.kb?.inline_keyboard.flat() ?? []).filter((b) => "callback_data" in b && b.callback_data.startsWith("funds:confirm:")).map((b) => "callback_data" in b ? b.callback_data : "").at(-1)!;
  return { messages, sends: () => sends, callback, send, confirm, failMessages: () => { failMessages = true; }, failOperation: (e: Error) => { failOperation = e; }, holdQuote: (fn: () => Promise<void>) => { holdQuote = fn; } };
}
test("资金输入直接回复，确认页核对收款地址与金额，双击和非白名单不重复提交", async (t) => {
  const f = ui(t); await f.callback("funds:transfer:bsc:main:native"); await f.send("错误地址"); assert.match(f.messages.at(-1)!.text, /完整有效/);
  await f.send(RECIPIENT); await f.send("0.001"); const text = f.messages.at(-1)!.text;
  for (const value of [RECIPIENT, OWNER, "0.001 BNB", "Gas 预算", "BNB"]) assert.ok(text.includes(value));
  assert.equal(f.sends(), 0); const confirm = f.confirm(); await f.callback(confirm, 456); assert.equal(f.sends(), 0);
  await Promise.all([f.callback(confirm), f.callback(confirm)]); assert.equal(f.sends(), 1);
});
test("兑换、跨链均要确认，取消、过期与切换菜单会废弃旧确认", async (t) => {
  const f = ui(t); await f.callback("funds:swap:bsc:main:usdt"); await f.send("0.001");
  assert.match(f.messages.at(-1)!.text, /仅授权本次/); const cancelled = f.confirm(); await f.callback("funds:cancel"); await f.callback(cancelled); assert.equal(f.sends(), 0);
  await f.callback("funds:bridge:bsc:main:base"); await f.send("0.001"); const text = f.messages.at(-1)!.text;
  for (const value of ["目标链：Base", "服务费", "服务报价最低到账", "仍需等待目标链到账"]) assert.ok(text.includes(value));
  const stale = f.confirm(); const expires = Date.now() + 61000; const clock = t.mock.method(Date, "now", () => expires);
  await f.callback(stale); assert.equal(f.sends(), 0); clock.mock.restore();
  await f.callback("funds:bridge:bsc:main:base"); await f.send("0.001"); const old = f.confirm(); await f.callback("logos:settings"); await f.callback(old); assert.equal(f.sends(), 0);
  await f.callback("funds:bridge:bsc:main:base"); await f.send("0.001"); await f.callback(f.confirm()); assert.equal(f.sends(), 1);
  assert.match(f.messages.at(-1)!.text, /正在等待目标链到账/); assert.ok(!f.messages.at(-1)!.text.includes("跨链已到账"));
});
test("提交结果未知或消息发送失败不自动重发，不伪造成交失败", async (t) => {
  const f = ui(t); await f.callback("funds:transfer:bsc:main:native"); await f.send(RECIPIENT); await f.send("0.001");
  f.failOperation(new PendingTransactionError(HASH)); await f.callback(f.confirm()); assert.match(f.messages.at(-1)!.text, /请勿重复操作/); assert.equal(f.sends(), 1);
  const g = ui(t); await g.callback("funds:transfer:bsc:main:native"); await g.send(RECIPIENT); await g.send("0.001"); const confirm = g.confirm(); g.failMessages(); await g.callback(confirm); await g.callback(confirm); assert.equal(g.sends(), 1);
});
test("报价还在等待时取消，不会迟到生成一个可提交的旧确认", async (t) => {
  const f = ui(t); let release!: () => void;
  f.holdQuote(() => new Promise<void>((r) => { release = r; }));
  await f.callback("funds:swap:bsc:main:usdt"); const waiting = f.send("0.001");
  await new Promise((r) => setImmediate(r)); await f.callback("funds:cancel");
  release(); await waiting;
  assert.equal(f.confirm(), undefined); assert.equal(f.sends(), 0);
});
