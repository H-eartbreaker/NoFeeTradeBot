import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Bot } from "grammy";
import type { InlineKeyboard } from "grammy";
import type { Address, Hex } from "viem";
import { CHAINS } from "../src/chains.ts";
import { Journal } from "../src/journal.ts";
import { Logos } from "../src/logos.ts";
import { quoteExit, registerPositions } from "../src/positions-panel.ts";
import { State } from "../src/state.ts";
import type { SellConfirmation, TradeDeps } from "../src/trade.ts";
import type { Route } from "../src/kyber.ts";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const OWNER = "0x2222222222222222222222222222222222222222" as Address;
const HASH = `0x${"a".repeat(64)}` as Hex;
const route = (amount: bigint): Route => ({ routerAddress: OWNER, routeSummary: { amountIn: amount.toString(), amountOut: (amount * 20n).toString(), gas: "100", amountOutUsd: "1", route: [[{ pool: OWNER, exchange: "Test" }]] } });
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "positions-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(join(dir, "state.json")); const journal = new Journal(join(dir, "journal.jsonl"));
  state.recordBuy("bsc", TOKEN, 1000n);
  const id = journal.start({ kind: "buy", token: TOKEN, wallet: "main", chain: "bsc", amountIn: "1000", amountOut: "100", balanceBefore: "0" }); journal.update(id, { status: "confirmed", gasCost: "1", feeComplete: true });
  const d = { chain: CHAINS.bsc, walletId: "main", journal, clients: { account: { address: OWNER }, publicClient: { getBalance: async () => 10n ** 18n } } } as unknown as TradeDeps;
  const bot = new Bot("123:test"); bot.botInfo = { id: 999, username: "test_bot", first_name: "Test", is_bot: true } as never;
  const messages: { text: string; kb?: InlineKeyboard }[] = []; let confirmation: SellConfirmation | undefined; let trades = 0;
  bot.api.config.use(async (_p, method, payload) => {
    if (method === "answerCallbackQuery") return { ok: true, result: true } as never;
    assert.equal(method, "sendMessage"); const p = payload as { text: string; reply_markup?: InlineKeyboard };
    assert.ok(p.text.length < 4096); for (const b of p.reply_markup?.inline_keyboard.flat() ?? []) if ("callback_data" in b) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    messages.push({ text: p.text, kb: p.reply_markup }); return { ok: true, result: { message_id: messages.length, date: 0, chat: { id: 123, type: "private" }, text: p.text } } as never;
  });
  let clear!: () => void;
  bot.use(async (ctx, next) => { if (ctx.from?.id !== 123) return; if ((ctx.callbackQuery && !/^(exit|positions):/.test(ctx.callbackQuery.data ?? "")) || ctx.message?.text?.startsWith("/")) clear(); await next(); });
  clear = registerPositions(bot, { state, chains: [CHAINS.bsc], logos: new Logos(state), activeChain: () => "bsc", activeWallet: () => "main", deps: (chain, wallet) => chain === "bsc" && wallet === "main" ? d : undefined, slippage: () => 1000, refresh: async () => undefined }, {
    readToken: async () => ({ address: TOKEN, name: "Test", symbol: "TEST", decimals: 0, balance: 100n }),
    getRoute: async (_s, _in, _out, amount) => route(amount), swapBudget: async () => 1000n,
    sell: async (_d, _token, _pct, _slip, c) => { trades++; confirmation = c; return { hash: HASH, soldAmount: c!.amount, receivedNative: c!.minimumOutput, blockNumber: 7n, approveHash: null, balanceBefore: 100n }; },
  });
  let n = 0; const user = (id: number) => ({ id, is_bot: false, first_name: "User" });
  const callback = (data: string, id = 123) => bot.handleUpdate({ update_id: ++n, callback_query: { id: String(n), from: user(id), chat_instance: "test", data, message: { message_id: 1, date: 0, chat: { id, type: "private", first_name: "User" }, text: "card" } } });
  const send = (text: string) => bot.handleUpdate({ update_id: ++n, message: { message_id: n, date: 0, from: user(123), chat: { id: 123, type: "private", first_name: "User" }, text } });
  const confirm = () => messages.flatMap((m) => m.kb?.inline_keyboard.flat() ?? []).filter((b) => "callback_data" in b && b.callback_data.startsWith("exit:confirm:")).map((b) => "callback_data" in b ? b.callback_data : "").at(-1)!;
  return { state, journal, d, callback, send, messages, confirm, trades: () => trades, confirmation: () => confirmation };
}
test("目标卖出按最小接收量计算；全仓不足时拒绝，不自动全部卖", async (t) => {
  const f = fixture(t);
  const q = await quoteExit(f.d, TOKEN, 100n, 1000n, 1000, async (_s, _i, _o, amount) => route(amount));
  assert.ok(q.amount <= 100n && q.amount > 0n); assert.ok(BigInt(q.route.routeSummary.amountOut) * 9000n / 10000n >= 1000n);
  await assert.rejects(quoteExit(f.d, TOKEN, 100n, 2000n, 1000, async (_s, _i, _o, amount) => route(amount)), /全部持仓也不足/); assert.equal(f.trades(), 0);
});
test("持仓页分开显示已实现、浮动和 Gas，本金卖出先确认并只执行一次", async (t) => {
  const f = fixture(t); await f.callback("positions:bsc:main:0");
  for (const value of ["已实现收益", "本页浮动收益", "Gas", "尚未收回本金"]) assert.ok(f.messages.at(-1)!.text.includes(value));
  await f.callback(`exit:p:bsc:main:${TOKEN}`); assert.equal(f.trades(), 0); assert.match(f.messages.at(-1)!.text, /目标换回/);
  const confirm = f.confirm(); await f.callback(confirm, 456); assert.equal(f.trades(), 0);
  await Promise.all([f.callback(confirm), f.callback(confirm)]); assert.equal(f.trades(), 1);
  assert.ok(f.confirmation()!.minimumOutput >= 1000n);
  assert.equal(f.state.position("bsc", TOKEN)!.cost, 1000n * (100n - f.confirmation()!.amount) / 100n);
});
test("按金额卖出直接回复，非法输入可重试；取消、切换菜单和过期不提交", async (t) => {
  const f = fixture(t); await f.callback(`exit:a:bsc:main:${TOKEN}`); await f.send("-1"); assert.match(f.messages.at(-1)!.text, /请输入/);
  await f.send("0.000000000000001"); const old = f.confirm(); await f.callback("exit:cancel"); await f.callback(old); assert.equal(f.trades(), 0);
  await f.callback(`exit:a:bsc:main:${TOKEN}`); await f.send("0.000000000000001"); const stale = f.confirm(); await f.callback("logos:settings"); await f.callback(stale); assert.equal(f.trades(), 0);
  await f.callback(`exit:p:bsc:main:${TOKEN}`); const expires = f.confirm(); const now = Date.now(); t.mock.method(Date, "now", () => now + 61000); await f.callback(expires); assert.equal(f.trades(), 0);
});
