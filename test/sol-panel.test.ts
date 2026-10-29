import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address } from "@solana/kit";
import type { KeyPairSigner } from "@solana/kit";
import type { InlineKeyboard } from "grammy";
import { createBot } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import { State } from "../src/state.ts";
import { OrderStore } from "../src/orders.ts";
import { SOL_MINT } from "../src/sol-chain.ts";
import type { SolRpc } from "../src/sol-chain.ts";
import type { TradeDeps } from "../src/trade.ts";
import { presetVersion } from "../src/settings.ts";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = address(SOL_MINT);
const EVM = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"1".repeat(64)}` as const;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "sol-panel-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("离线测试禁止真实联网"); });
  const stateFile = join(dir, "state.json"); const state = new State(stateFile);
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "123:test", ALLOWED_USER_ID: "1", PRIVATE_KEY: "0x" + "1".repeat(64), CHAINS: "bsc,base,eth,rh" });
  const deps = new Map(cfg.chains.map((chain) => [chain.key, { chain, clients: { account: { address: EVM }, publicClient: { getBalance: async () => 1000000000000000000n } } } as unknown as TradeDeps]));
  let generated = 0; let hasWallet = true; let held = 1000000n; let buys = 0; let sells = 0; let evmTrades = 0;
  let waitQuote: Promise<void> | undefined;
  const bot = createBot(cfg, deps, state, {
    readToken: async (_c, token) => ({ address: token, name: "EVM", symbol: "EVM", balance: 0n, decimals: 6 }),
    buy: async () => { evmTrades++; return { hash: HASH, received: 1n, blockNumber: 1n }; },
  }, undefined, new OrderStore(join(dir, "orders.json")), {
    wallet: () => ({ address: () => hasWallet ? OWNER : null, signer: async () => ({ address: OWNER }) as KeyPairSigner, generate: () => { generated++; hasWallet = true; return OWNER; } }),
    openRpc: () => ({}) as SolRpc,
    holdings: async () => held ? [{ mint: MINT, amount: held, decimals: 6 }] : [],
    solBalance: async () => 1000000000n,
    mintInfo: async () => ({ decimals: 6, mintAuthority: null, freezeAuthority: null }),
    tokenMeta: async () => ({ symbol: "USDC", name: "Test <USDC>" }),
    quote: async (inputMint, outputMint, amount) => { await waitQuote; return { inputMint, outputMint, inAmount: amount.toString(), outAmount: "1000000", otherAmountThreshold: "990000", routePlan: [{ swapInfo: { label: "DEX", ammKey: MINT } }] }; },
    buySol: async (_rpc, _signer, _mint, _amount, _slip, q, guard) => { guard?.(); buys++; return { signature: "fake-signature", quote: q! }; },
    sellToken: async (_rpc, _signer, _mint, _pct, _slip, q, guard) => { guard?.(); sells++; return { signature: "fake-signature", quote: q! }; },
  });
  bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
  const messages: { text: string; kb?: InlineKeyboard }[] = []; const answers: string[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    const p = payload as { text?: string; reply_markup?: InlineKeyboard };
    if (method === "answerCallbackQuery") { answers.push(p.text ?? ""); return { ok: true, result: true } as never; }
    assert.ok(["sendMessage", "editMessageText", "editMessageReplyMarkup"].includes(method), method);
    assert.ok((p.text?.length ?? 0) <= 4096);
    for (const row of p.reply_markup?.inline_keyboard ?? []) for (const b of row) if ("callback_data" in b) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
    messages.push({ text: p.text ?? "", kb: p.reply_markup });
    return { ok: true, result: { message_id: messages.length, date: 0, chat: { id: 1, type: "private" }, text: p.text ?? "" } } as never;
  });
  let sequence = 0;
  async function send(text: string, userId = 1) {
    const command = /^\/\w+/.exec(text)?.[0];
    await bot.handleUpdate({ update_id: ++sequence, message: { message_id: sequence, date: 0, from: { id: userId, is_bot: false, first_name: "Test" }, chat: { id: userId, type: "private", first_name: "Test" }, text, entities: command ? [{ type: "bot_command", offset: 0, length: command.length }] : undefined } });
  }
  async function callback(data: string, userId = 1) {
    await bot.handleUpdate({ update_id: ++sequence, callback_query: { id: String(sequence), from: { id: userId, is_bot: false, first_name: "Test" }, chat_instance: "test", data, message: { message_id: 1, date: 0, chat: { id: userId, type: "private", first_name: "Test" }, text: "card" } } });
  }
  function button(prefix: string) {
    for (const m of [...messages].reverse()) for (const row of m.kb?.inline_keyboard ?? []) for (const b of row) if ("callback_data" in b && b.callback_data.startsWith(prefix)) return b.callback_data;
    throw new Error(`按钮不存在 ${prefix}`);
  }
  return { state, stateFile, messages, answers, send, callback, button, last: () => messages.at(-1)!.text,
    counts: () => ({ buys, sells, generated, evmTrades }), setWallet: (v: boolean) => { hasWallet = v; }, waitQuote: (v?: Promise<void>) => { waitQuote = v; } };
}

test("Solana 共用链选择/首页/设置，选择与分链参数重启后保留", async (t) => {
  const f = fixture(t); await f.send("/chain"); assert.equal(f.button("c:sol"), "c:sol");
  await f.callback("c:sol"); assert.match(f.last(), /demo bot/); assert.match(f.last(), /当前链：Solana/);
  assert.ok(!f.messages.at(-1)!.kb?.inline_keyboard.flat().some((b) => b.text.includes("Solana 买卖")));
  assert.equal(new State(f.stateFile).activeChain, "sol");
  await f.send("/settings"); assert.match(f.last(), /正在设置：Solana/); assert.equal(f.button("settings:bsc"), "settings:bsc");
  await f.callback("set:sol:buy-slip"); await f.send("2.5%"); assert.equal(f.state.chainSettings("sol").buySlippageBps, 250); assert.equal(f.state.chainSettings("bsc").buySlippageBps, undefined);
  await f.callback("set:sol:buy-presets"); await f.send("100.000000001"); assert.match(f.last(), /最多/);
  await f.send("0.000000001 0.1 100"); assert.deepEqual(new State(f.stateFile).chainSettings("sol").buyAmounts, ["0.000000001", "0.1", "100"]);
});

test("Solana 确认显示真实池和未知税费；取消、过期、重复点击及非白名单不下单", async (t) => {
  const f = fixture(t); await f.callback("c:sol"); await f.send(MINT); await f.callback(f.button("sol:b:"));
  assert.match(f.last(), /Test &lt;USDC&gt;/); assert.match(f.last(), /交易池/); assert.match(f.last(), /买入税 \/ 卖出税：未知/);
  const pending = f.button("sol:ok:"); await f.callback(pending, 2); assert.equal(f.counts().buys, 0);
  await f.callback(pending); await f.callback(pending); await settle(); assert.equal(f.counts().buys, 1);
  await f.callback(f.button("sol:b:")); await f.callback(f.button("sol:no:")); assert.equal(f.counts().buys, 1);
  await f.callback(f.button("sol:b:")); const expires = f.button("sol:ok:"); const now = Date.now(); t.mock.method(Date, "now", () => now + 61000);
  await f.callback(expires); assert.equal(f.counts().buys, 1);
});

test("Solana 切链和改设置使旧确认作废，其他链的旧卡片不能误买", async (t) => {
  const f = fixture(t); await f.callback("c:sol"); await f.send(MINT); await f.callback(f.button("sol:b:")); const pending = f.button("sol:ok:");
  await f.callback("c:bsc"); await f.callback(pending); assert.equal(f.counts().buys, 0);
  await f.callback("c:sol"); await f.callback(pending); assert.equal(f.counts().buys, 0);
  await f.callback(f.button("sol:b:")); const pending2 = f.button("sol:ok:");
  await f.callback("set:sol:sell-slip"); await f.send("2"); await f.callback(pending2); assert.equal(f.counts().buys, 0);
  await f.callback(`b:bsc:main:${EVM}:0:${presetVersion([1000000000000000n])}`); assert.equal(f.counts().evmTrades, 0);
});

test("Solana 快速买入和买前确认的四种组合遵守开关，卖出仍确认", async (t) => {
  const f = fixture(t); await f.callback("c:sol");
  await f.send(MINT); assert.equal(f.counts().buys, 0); assert.match(f.last(), /Solana 代币/);
  f.state.setChainSettings("sol", { buyConfirmation: false }); await f.send(MINT); assert.equal(f.counts().buys, 0);
  await f.callback(f.button("sol:b:")); assert.equal(f.counts().buys, 1);
  f.state.setChainSettings("sol", { quickBuy: true, buyConfirmation: true }); await f.send(MINT); assert.match(f.last(), /确认买入/); assert.equal(f.counts().buys, 1);
  await f.callback(f.button("sol:no:")); f.state.setChainSettings("sol", { buyConfirmation: false }); await f.send(MINT); assert.equal(f.counts().buys, 2);
  await f.callback(`sol:s:${MINT}:12.5`); assert.match(f.last(), /12.5%/); assert.equal(f.counts().sells, 0);
  await f.callback(f.button("sol:ok:")); await settle(); assert.equal(f.counts().sells, 1);
});

test("Solana 报价等待时切链不会迟到创建确认；旧金额按钮不执行", async (t) => {
  const f = fixture(t); await f.callback("c:sol"); await f.send(MINT); const oldButton = f.button("sol:b:");
  f.state.setChainSettings("sol", { buyAmounts: ["0.2"] }); await f.callback(oldButton); assert.match(f.last(), /刷新/);
  await f.send(MINT); let release!: () => void; f.waitQuote(new Promise((r) => { release = r; }));
  const creating = f.callback(f.button("sol:b:")); await settle(); await f.callback("c:bsc"); const count = f.messages.length;
  release(); await creating; assert.equal(f.messages.length, count); assert.equal(f.counts().buys, 0);
});

test("Solana 钱包/充值/持仓共用入口，未支持功能不落到 EVM，错误地址不误交易", async (t) => {
  const f = fixture(t); await f.callback("c:sol"); await f.send("/wallets"); assert.match(f.last(), /Solana 主钱包/);
  await f.send("/deposit"); assert.match(f.last(), new RegExp(OWNER)); await f.send("/positions"); assert.match(f.last(), /USDC/);
  for (const command of ["/orders", "/funds", "/history", "/approvals", "/track", "/tpsl"]) { await f.send(command); assert.match(f.last(), /尚未接入/); }
  await f.send(EVM); assert.match(f.last(), /不是有效的 Solana/); assert.equal(f.counts().evmTrades, 0);
  f.setWallet(false); await f.send("/wallets"); assert.equal(f.button("sol:gen"), "sol:gen"); await f.callback("sol:gen"); assert.equal(f.counts().generated, 0);
});
