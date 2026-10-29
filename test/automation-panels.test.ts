import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import type { InlineKeyboard } from "grammy";
import { State } from "../src/state.ts";
import { OrderStore } from "../src/orders.ts";
import { Logos } from "../src/logos.ts";
import { CHAINS } from "../src/chains.ts";
import { registerOrders } from "../src/orders-panel.ts";
import { registerTracked } from "../src/tracked-panel.ts";
import { NATIVE } from "../src/kyber.ts";
import type { TradeDeps } from "../src/trade.ts";
const TOKEN = "0x1111111111111111111111111111111111111111";
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "automation-panels-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("不允许真实联网"); });
  const state = new State(join(dir, "state.json")); const store = new OrderStore(join(dir, "orders.json")); const logos = new Logos(state);
  const d = { chain: CHAINS.bsc, clients: { account: { address: TOKEN }, publicClient: { getBalance: async () => 100n * 10n ** 18n } } } as unknown as TradeDeps;
  const bot = new Bot("123:test");
  bot.use(async (ctx, next) => { if (ctx.from?.id === 1 && ctx.chat?.type === "private") await next(); });
  registerOrders(bot, { state, store, chains: [CHAINS.bsc], logos, deps: () => d, slippage: () => 100 }, {
    readToken: async (_c, token) => ({ address: token, decimals: 6, symbol: "TEST", name: "Test", balance: 1000000000n }),
    supplyOf: async () => 1000000000n,
    getRoute: async (_slug, tokenIn, _out, amount) => ({ routerAddress: TOKEN, routeSummary: { amountIn: String(amount), amountOut: String(tokenIn === NATIVE ? amount * 1000000n / 10000000000000000n : 10000000000000000n), amountOutUsd: "1", gas: "1" } }),
  });
  registerTracked(bot, { state, logos, activeChain: () => "bsc", deps: () => d });
  bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
  const messages: { text: string; kb?: InlineKeyboard }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as { text?: string; reply_markup?: InlineKeyboard };
    if (method === "answerCallbackQuery") return { ok: true, result: true } as never;
    assert.equal(method, "sendMessage"); messages.push({ text: p.text ?? "", kb: p.reply_markup });
    for (const row of p.reply_markup?.inline_keyboard ?? []) for (const button of row) if ("callback_data" in button) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    return { ok: true, result: { message_id: messages.length, date: 0, chat: { id: 1, type: "private" }, text: p.text ?? "" } } as never;
  });
  let id = 0; const user = (userId: number) => ({ id: userId, is_bot: false, first_name: "Test" }); const chat = (userId: number) => ({ id: userId, type: "private" as const, first_name: "Test" });
  const send = async (text: string, userId = 1) => { const command = /^\/\w+/.exec(text)?.[0]; await bot.handleUpdate({ update_id: ++id, message: { message_id: id, date: 0, from: user(userId), chat: chat(userId), text, entities: command ? [{ type: "bot_command", offset: 0, length: command.length }] : undefined } }); };
  const callback = async (data: string, userId = 1) => { await bot.handleUpdate({ update_id: ++id, callback_query: { id: String(id), from: user(userId), chat_instance: "test", data, message: { message_id: 1, date: 0, chat: chat(userId), text: "panel" } } }); };
  const button = (prefix: string) => {
    for (const m of [...messages].reverse()) for (const row of m.kb?.inline_keyboard ?? []) for (const b of row) if ("callback_data" in b && b.callback_data.startsWith(prefix)) return b.callback_data;
    throw new Error(`找不到 ${prefix}`);
  };
  return { state, store, send, callback, button, last: () => messages.at(-1)!.text };
}

test("限价买卖、市值买卖、定投都先预览，确认后只创建一次并支持暂停/恢复/取消", async (t) => {
  const f = fixture(t);
  for (const [kind, input] of [["lb", "0.005 0.001"], ["ls", "0.02 50"], ["mb", "5 0.001"], ["ms", "20 50"], ["dca", "0.001 5 2"]]) {
    const previous = f.store.list().length;
    await f.callback(`ord:k:${kind}:bsc:main:${TOKEN}`); await f.send(input); assert.match(f.last(), /确认自动订单/); assert.equal(f.store.list().length, previous);
    const confirm = f.button("ord:ok:"); await f.callback(confirm, 2); assert.equal(f.store.list().length, previous);
    await f.callback(confirm); await f.callback(confirm); assert.equal(f.store.list().length, previous + 1);
  }
  const order = f.store.list()[0]; await f.callback(`ord:t:${order.id}`); assert.equal(f.store.get(order.id)?.status, "paused");
  await f.callback(`ord:t:${order.id}`); assert.equal(f.store.get(order.id)?.status, "active");
  await f.callback(`ord:x:${order.id}`); assert.equal(f.store.get(order.id)?.status, "cancelled");
});

test("自动单非法格式、立即触发、取消与过期不会偷偷创建任务", async (t) => {
  const f = fixture(t); await f.callback(`ord:k:dca:bsc:main:${TOKEN}`); await f.send("0.1 0 2"); assert.match(f.last(), /格式不正确/); assert.equal(f.store.list().length, 0);
  await f.send("取消"); await f.callback(`ord:k:lb:bsc:main:${TOKEN}`); await f.send("0.02 0.001"); assert.match(f.last(), /会立即买入/); assert.equal(f.store.list().length, 0);
  await f.callback(`ord:k:lb:bsc:main:${TOKEN}`); await f.send("0.005 0.001"); const pending = f.button("ord:ok:"); const now = Date.now(); t.mock.method(Date, "now", () => now + 61000); await f.callback(pending); assert.equal(f.store.list().length, 0);
});

test("追踪列表批量添加、去重、备注转义、导出/删除只读且有白名单限制", async (t) => {
  const f = fixture(t); await f.callback("trk:add", 2); await f.send(`${TOKEN} blocked`, 2); assert.equal(f.state.trackedWallets().length, 0);
  await f.callback("trk:add"); await f.send(`${TOKEN} <聪明钱>\n${TOKEN} duplicate\ninvalid`); assert.equal(f.state.trackedWallets().length, 1);
  await f.callback(`trk:view:${TOKEN}`); assert.match(f.last(), /&lt;聪明钱&gt;/); assert.match(f.last(), /只读/);
  await f.callback("trk:export"); assert.match(f.last(), new RegExp(TOKEN)); await f.callback(`trk:del:${TOKEN}`); assert.equal(f.state.trackedWallets().length, 0);
});
