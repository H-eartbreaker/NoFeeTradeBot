import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { InlineKeyboard } from "grammy";
import type { Address, Hex } from "viem";
import { createBot } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import { Journal } from "../src/journal.ts";
import { State } from "../src/state.ts";
import type { TradeDeps } from "../src/trade.ts";
import type { WalletProfile, Wallets } from "../src/wallets.ts";
import { main as importWallet } from "../scripts/import-wallet.ts";

const TOKEN = "0x55d398326f99059ff775485246999027b3197955" as Address;
const HASH = `0x${"a".repeat(64)}` as Hex;
const ADDRESS1 = "0x1111111111111111111111111111111111111111" as Address;
const ADDRESS2 = "0x2222222222222222222222222222222222222222" as Address;
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "wallet-panel-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "state.json"); const state = new State(stateFile); const journal = new Journal(join(dir, "trades.jsonl"));
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "123:test", ALLOWED_USER_ID: "123", PRIVATE_KEY: `0x${"1".repeat(64)}`, CHAINS: "bsc,base,eth,rh" });
  const profiles: WalletProfile[] = [{ id: "main", label: "主钱包", address: ADDRESS1 }, { id: "w001", label: "钱包 &lt;2&gt;", address: ADDRESS2 }];
  let creates = 0; let failCreate = false; let failBalance = false;
  const perWallet = new Map<string, Map<string, TradeDeps>>();
  const get = (wallet: string, key: string) => {
    if (!profiles.some((p) => p.id === wallet) || !cfg.chains.some((c) => c.key === key)) return undefined;
    let deps = perWallet.get(wallet);
    if (!deps) {
      deps = new Map(cfg.chains.map((chain) => [chain.key, { walletId: wallet, chain, journal, clients: {
        account: { address: profiles.find((p) => p.id === wallet)!.address },
        publicClient: { getBalance: async () => { if (failBalance) throw new Error("RPC offline"); return wallet === "main" ? 10n ** 18n : 2n * 10n ** 18n; } },
      } } as unknown as TradeDeps])); perWallet.set(wallet, deps);
    }
    return deps.get(key);
  };
  const directory = { list: () => profiles.map((p) => ({ ...p })), get,
    create: () => { if (failCreate) throw new Error("cannot save"); creates++; const w = { id: "w002", label: "钱包 3", address: "0x3333333333333333333333333333333333333333" as Address }; profiles.push(w); return w; } } as unknown as Wallets;
  const buys: string[] = [];
  const bot = createBot(cfg, new Map(cfg.chains.map((c) => [c.key, get("main", c.key)!])), state, {
    readToken: async (_clients, address) => ({ address, name: "Test", symbol: "TEST", decimals: 6, balance: 1000000n }),
    checkToken: async () => null,
    getRoute: async (_chain, _in, _out, amount) => ({ routerAddress: ADDRESS1, routeSummary: { amountIn: amount.toString(), amountOut: "1000000", amountOutUsd: "1", gas: "100000", route: [[{ pool: ADDRESS2, exchange: "Test" }]] } }),
    buy: async (d, _token, _amount, _slip, gate) => { if (typeof gate === "function") await gate(); else await gate; buys.push(d.walletId!); return { hash: HASH, received: 100n, blockNumber: 5n }; },
    sell: async () => { throw new Error("Unexpected sell"); },
  }, directory);
  bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot" } as never;
  const messages: { text: string; kb?: InlineKeyboard; method: string }[] = []; const answers: string[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as { text?: string; reply_markup?: InlineKeyboard };
    if (method === "answerCallbackQuery") { answers.push(p.text ?? ""); return { ok: true, result: true } as never; }
    assert.ok(["sendMessage", "editMessageText", "editMessageReplyMarkup"].includes(method));
    if (p.text) assert.ok(p.text.length < 4096, "Telegram 单条长度");
    for (const row of p.reply_markup?.inline_keyboard ?? []) for (const b of row) if ("callback_data" in b) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    messages.push({ text: p.text ?? "", kb: p.reply_markup, method });
    return { ok: true, result: { message_id: messages.length, date: 0, chat: { id: 123, type: "private" }, text: p.text } } as never;
  });
  let id = 0;
  const from = (user: number) => ({ id: user, first_name: "User", is_bot: false });
  async function send(text: string, user = 123) {
    const command = /^\/\w+/.exec(text)?.[0];
    await bot.handleUpdate({ update_id: ++id, message: { message_id: id, date: 0, from: from(user), chat: { id: user, type: "private", first_name: "User" }, text,
      entities: command ? [{ type: "bot_command", offset: 0, length: command.length }] : [] } });
  }
  async function callback(data: string, user = 123) {
    await bot.handleUpdate({ update_id: ++id, callback_query: { id: String(id), from: from(user), chat_instance: "test", data,
      message: { message_id: 1, date: 0, chat: { id: user, type: "private", first_name: "User" }, text: "card" } } });
  }
  const button = (prefix: string) => messages.flatMap((m) => m.kb?.inline_keyboard.flat() ?? []).filter((b) => "callback_data" in b && b.callback_data.startsWith(prefix)).map((b) => "callback_data" in b ? b.callback_data : "").at(-1)!;
  return { state, stateFile, journal, messages, answers, send, callback, button, buys, creates: () => creates,
    failCreate: () => { failCreate = true; }, failBalance: () => { failBalance = true; } };
}

test("钱包入口、充值网络和默认钱包切换，重启仍记住选择", async (t) => {
  const f = fixture(t);
  await f.send("/start"); assert.equal(f.button("wallet:page:"), "wallet:page:0");
  await f.send("/wallets"); assert.match(f.messages.at(-1)!.text, /钱包管理/);
  await f.callback("wallet:view:w001"); assert.match(f.messages.at(-1)!.text, /2 ETH/); assert.match(f.messages.at(-1)!.text, /钱包 &amp;lt;2&amp;gt;/);
  await f.callback("wallet:select:w001"); assert.equal(f.state.activeWallet, "w001");
  assert.equal(new State(f.stateFile).activeWallet, "w001");
  await f.send("/deposit"); const message = f.messages.at(-1)!.text;
  assert.ok(message.includes(ADDRESS2)); assert.ok(!message.includes(ADDRESS1));
  for (const c of ["BNB", "Base", "Ethereum", "Robinhood"]) assert.ok(message.includes(c));
  await f.send("/balance"); assert.ok(f.messages.at(-1)!.text.includes(ADDRESS2));
  await f.callback("wallet:select:w999"); assert.equal(f.state.activeWallet, "w001");
});
test("切换钱包让旧买入确认失效，新卡片和自定义输入绑定各自钱包", async (t) => {
  const f = fixture(t);
  await f.send(TOKEN); const oldCard = f.button("b:bsc:main:");
  await f.callback(oldCard); const confirm = f.button("confirm:");
  await f.callback("wallet:select:w001"); await f.callback(confirm); assert.deepEqual(f.buys, []);
  await f.send(TOKEN); assert.ok(f.button("b:bsc:w001:"));
  await f.callback(f.button("b:bsc:w001:")); await f.callback(f.button("confirm:"));
  assert.deepEqual(f.buys, ["w001"]);
  assert.ok(f.state.position("bsc", TOKEN, "w001")); assert.equal(f.state.position("bsc", TOKEN, "main"), null);
  // 旧卡片仍明确绑定主钱包；切换默认钱包不会改写旧按钮的交易对象。
  await f.callback(oldCard); assert.ok(f.messages.at(-1)!.text.includes(ADDRESS1));
  await f.callback("wallet:select:main"); await f.callback(`custom:b:bsc:w001:${TOKEN}`); await f.send("0.001");
  assert.ok(f.messages.at(-1)!.text.includes(ADDRESS2));
});
test("创建前确认、双击去重、取消、过期和非白名单均不会额外创建", async (t) => {
  const f = fixture(t);
  await f.callback("wallet:create", 456); assert.equal(f.creates(), 0); assert.equal(f.messages.length, 0);
  await f.callback("wallet:create"); const confirm = f.button("wallet:new:"); assert.equal(f.creates(), 0);
  await Promise.all([f.callback(confirm), f.callback(confirm)]); assert.equal(f.creates(), 1); assert.equal(f.state.activeWallet, "main");
  assert.match(f.messages.filter((m) => m.text.includes("新钱包已创建")).at(-1)!.text, /聊天里只显示地址/);
  await f.callback("wallet:create"); const cancelled = f.button("wallet:new:"); await f.callback("wallet:cancel"); await f.callback(cancelled); assert.equal(f.creates(), 1);
  await f.callback("wallet:create"); const expired = f.button("wallet:new:"); const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now + 61_000); await f.callback(expired); clock.mock.restore(); assert.equal(f.creates(), 1);
  await f.callback("wallet:create"); const abandoned = f.button("wallet:new:"); await f.send("/start"); await f.callback(abandoned); assert.equal(f.creates(), 1);
});
test("创建保存失败和余额查询失败给出明确结果，不切换钱包", async (t) => {
  const f = fixture(t); f.failCreate(); await f.callback("wallet:create"); await f.callback(f.button("wallet:new:"));
  assert.match(f.messages.at(-1)!.text, /未能保存/); assert.equal(f.creates(), 0); assert.equal(f.state.activeWallet, "main");
  f.failBalance(); await f.callback("wallet:view:main"); assert.match(f.messages.at(-1)!.text, /查询失败/);
});
test("历史按钱包和链隔离，真实金额与 Gas 区分，分页不重复，待确认不误报成功", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) {
    const id = f.journal.start({ wallet: "main", chain: "bsc", kind: "buy", token: TOKEN, amountIn: "1000000000000000" });
    f.journal.update(id, { status: i === 6 ? "pending" : "confirmed", hash: `0x${String(i + 1).repeat(64)}` as Hex,
      amountOut: i === 6 ? undefined : "2000000", gasCost: i === 6 ? undefined : "2000000000", feeComplete: i !== 5 });
  }
  const other = f.journal.start({ wallet: "w001", chain: "base", kind: "sell", token: TOKEN, amountIn: "1000000" });
  f.journal.update(other, { status: "confirmed", amountOut: "1230000000000000", gasCost: "10000", feeComplete: false });
  await f.send("/history"); let text = f.messages.at(-1)!.text;
  assert.match(text, /共 7 笔/); assert.match(text, /买入 · 链上确认中/); assert.match(text, /实际到账：2 TEST/); assert.match(text, /支出：0.001 BNB/);
  assert.match(text, /部分费用不完整/); assert.match(text, /勿重复提交/); assert.ok(!text.includes("实际换回"));
  assert.equal((text.match(/<b>买入 ·/g) ?? []).length, 5);
  await f.callback(f.button("history:main:bsc:1")); text = f.messages.at(-1)!.text; assert.equal((text.match(/<b>买入 ·/g) ?? []).length, 2);
  await f.callback("history:main:base:0"); assert.match(f.messages.at(-1)!.text, /还没有本地交易记录/);
  await f.callback("history:w001:base:0"); text = f.messages.at(-1)!.text;
  assert.match(text, /共 1 笔/); assert.match(text, /实际换回：0.00123 ETH/); assert.ok(!text.includes(ADDRESS1));
  const before = f.messages.length; await f.send("/history", 456); assert.equal(f.messages.length, before);
});
test("本地导入入口不会接收聊天私钥；非交互导入在读取配置前退出", async (t) => {
  const f = fixture(t); await f.callback("wallet:import"); assert.match(f.messages.at(-1)!.text, /npm run wallet:import/);
  assert.equal(f.creates(), 0);
  if (!process.stdin.isTTY) await assert.rejects(importWallet(), /交互终端/);
});
