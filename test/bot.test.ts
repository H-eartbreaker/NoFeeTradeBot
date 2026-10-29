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
import type { RiskReport } from "../src/honeypot.ts";
import { routeIdentity } from "../src/kyber.ts";
import type { Route } from "../src/kyber.ts";
import { presetVersion } from "../src/settings.ts";
import { State } from "../src/state.ts";
import type { TradeDeps } from "../src/trade.ts";

const TOKEN = "0x55d398326f99059ff775485246999027b3197955" as Address;
const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const HASH = `0x${"1".repeat(64)}` as Hex;
const POOL = "0x2222222222222222222222222222222222222222";
const ROUTE: Route = { routerAddress: WALLET, routeSummary: { amountIn: "1000000000000000", amountOut: "1000000", amountOutUsd: "1", gas: "100000", route: [[{ pool: POOL, exchange: "PancakeSwap V3", tokenIn: WALLET, tokenOut: TOKEN }]] } };
type Reply = { method: string; text: string; messageId: number; kb?: InlineKeyboard };

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "bot-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(join(dir, "state.json"));
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "123:test", ALLOWED_USER_ID: "123", PRIVATE_KEY: "0x" + "1".repeat(64), CHAINS: "bsc,base,eth,rh" });
  const deps = new Map(cfg.chains.map((chain) => [chain.key, { chain, clients: { account: { address: WALLET }, publicClient: { getBalance: async () => 10n ** 18n } } } as unknown as TradeDeps]));
  let report: RiskReport | null = { isHoneypot: false, buyTax: 1, sellTax: 2, risk: "low", liquidityUsd: 100000, holders: 1000 };
  let balance = 1000000n;
  const buys: { chain: string; amount: bigint; slip: number; route?: string }[] = [];
  const sells: { chain: string; pct: number; slip: number }[] = [];
  let reads = 0;
  const bot = createBot(cfg, deps, state, {
    readToken: async (_clients, address) => { reads++; return { address, name: "Test <Token>", symbol: "TEST", decimals: 6, balance }; },
    checkToken: async () => report,
    getRoute: async (_slug, _in, _out, amount) => ({ ...ROUTE, routeSummary: { ...ROUTE.routeSummary, amountIn: amount.toString() } }),
    buy: async (d, _token, amount, slip, gate, route) => {
      if (typeof gate === "function") await gate(); else await gate;
      buys.push({ chain: d.chain.key, amount, slip, route: route?.route });
      return { hash: HASH, received: 100n, blockNumber: 7n };
    },
    sell: async (d, _token, pct, slip) => { sells.push({ chain: d.chain.key, pct, slip }); return { hash: HASH, soldAmount: 10n, receivedNative: 10n, approveHash: null, blockNumber: 7n }; },
  });
  bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
  const replies: string[] = [];
  const messages: Reply[] = [];
  const answers: string[] = [];
  let messageId = 100;
  let failEdit = false;
  // 拦截全部 Telegram API，不允许测试发消息、联网或发送真实交易。
  bot.api.config.use(async (_previous, method, payload) => {
    const p = payload as { text?: string; message_id?: number; reply_markup?: InlineKeyboard };
    if (method === "answerCallbackQuery") { answers.push(p.text ?? ""); return { ok: true, result: true } as never; }
    assert.ok(["sendMessage", "editMessageText", "editMessageReplyMarkup"].includes(method), method);
    if (failEdit && method === "editMessageText") throw new Error("Telegram unavailable");
    const id = p.message_id ?? ++messageId;
    messages.push({ method, text: p.text ?? "", messageId: id, kb: p.reply_markup });
    if (p.text) replies.push(p.text);
    return { ok: true, result: { message_id: id, date: 0, chat: { id: 123, type: "private" }, text: p.text ?? "" } } as never;
  });
  let id = 0;
  async function send(text: string, userId = 123) {
    const command = /^\/\w+/.exec(text)?.[0];
    await bot.handleUpdate({ update_id: ++id, message: {
      message_id: id, date: 0, from: { id: userId, is_bot: false, first_name: "User" },
      chat: { id: userId, type: "private", first_name: "User" }, text,
      entities: command ? [{ type: "bot_command", offset: 0, length: command.length }] : undefined,
    } });
  }
  async function callback(data: string, userId = 123, sourceMessageId = 5) {
    await bot.handleUpdate({ update_id: ++id, callback_query: {
      id: String(id), from: { id: userId, is_bot: false, first_name: "User" }, chat_instance: "test", data,
      message: { message_id: sourceMessageId, date: 0, chat: { id: userId, type: "private", first_name: "User" }, text: "card" },
    } });
  }
  function button(prefix: string) {
    for (const m of [...messages].reverse()) {
      for (const row of m.kb?.inline_keyboard ?? []) for (const b of row) if ("callback_data" in b && b.callback_data.startsWith(prefix)) return b.callback_data;
    }
    throw new Error(`Missing button: ${prefix}`);
  }
  const buyButton = (chain = "bsc") => `b:${chain}:${TOKEN}:0:${presetVersion(cfg.chains.find((c) => c.key === chain)!.buyAmounts)}`;
  return { state, replies, messages, answers, send, callback, button, buyButton, buys, sells,
    setRisk: (value: RiskReport | null) => { report = value; }, setBalance: (value: bigint) => { balance = value; },
    failEdits: () => { failEdit = true; }, readCount: () => reads };
}

test("点滑点后直接回复百分比，分链买卖分别保存", async (t) => {
  const f = fixture(t);
  await f.send("/slippage"); await f.send("30");
  assert.equal(f.state.chainSettings("bsc").buySlippageBps, 3000);
  assert.equal(f.state.chainSettings("bsc").sellSlippageBps, 3000);
  assert.equal(f.state.chainSettings("base").buySlippageBps, undefined);
  await f.callback("set:base:sell-slip"); await f.send("12.5%");
  assert.equal(f.state.chainSettings("base").sellSlippageBps, 1250);
  assert.equal(f.state.chainSettings("base").buySlippageBps, undefined);
});

test("滑点错误重试、取消、其他命令和白名单", async (t) => {
  const f = fixture(t);
  await f.send("30"); assert.equal(f.state.chainSettings("bsc").buySlippageBps, undefined);
  await f.send("/slippage"); await f.send("30", 456); await f.send("100");
  assert.equal(f.state.chainSettings("bsc").buySlippageBps, undefined);
  await f.send("30");
  await f.send("/slippage"); await f.send("取消"); await f.send("40");
  assert.equal(f.state.chainSettings("bsc").buySlippageBps, 3000);
  await f.send("/slippage"); await f.send("/tpsl off"); await f.send("50");
  assert.equal(f.state.chainSettings("bsc").buySlippageBps, 3000);
  await f.send("/slippage 20"); assert.equal(f.state.chainSettings("bsc").buySlippageBps, 2000);
});

test("首页和设置有可点击入口，时区验证和显示开关可保存", async (t) => {
  const f = fixture(t);
  await f.send("/start"); assert.equal(f.button("nav:settings"), "nav:settings");
  await f.callback("nav:settings"); assert.match(f.replies.at(-1)!, /交易设置/);
  await f.callback("set:bsc:zone"); await f.send("invalid/zone"); assert.equal(f.state.display.timeZone, "Asia/Shanghai");
  await f.send("UTC"); assert.equal(f.state.display.timeZone, "UTC");
  await f.callback("display:bsc:chart:0"); assert.equal(f.state.display.showChart, false);
  await f.callback("display:bsc:hour12:1"); assert.equal(f.state.display.hour12, true);
  await f.callback("nav:tpsl"); await f.send("100 30"); assert.deepEqual(f.state.defaultRule, { tp: 100, sl: 30 });
});

test("买前确认显示链CA名称池税费，确认后只执行一次并刷新原卡片", async (t) => {
  const f = fixture(t);
  await f.callback(f.buyButton());
  assert.equal(f.buys.length, 0);
  const preview = f.replies.at(-1)!;
  for (const text of ["BNB Chain", TOKEN, "Test &lt;Token&gt;", POOL, "PancakeSwap V3", "买入税：1.00%", "卖出税：2.00%", "貔貅"]) assert.ok(preview.includes(text), text);
  const confirm = f.button("confirm:");
  await f.callback(confirm, 456); assert.equal(f.buys.length, 0);
  await Promise.all([f.callback(confirm), f.callback(confirm)]);
  assert.equal(f.buys.length, 1);
  assert.equal(f.buys[0].route, routeIdentity(ROUTE));
  assert.ok(f.messages.some((m) => m.method === "editMessageText" && m.messageId === 5 && m.text.includes("CA：")));
});

test("取消、过期、设置修改和重启后旧确认都不能下单", async (t) => {
  const f = fixture(t);
  await f.callback(f.buyButton()); const cancel = f.button("cancel:"); const confirm = f.button("confirm:");
  await f.callback(cancel); await f.callback(confirm); assert.equal(f.buys.length, 0);
  await f.callback(f.buyButton()); const expired = f.button("confirm:");
  const now = Date.now(); const clock = t.mock.method(Date, "now", () => now + 61_000);
  await f.callback(expired); assert.equal(f.buys.length, 0); clock.mock.restore();
  await f.callback(f.buyButton()); const stale = f.button("confirm:");
  await f.callback("set:bsc:buy-slip"); await f.send("30"); await f.callback(stale); assert.equal(f.buys.length, 0);
  const restarted = fixture(t); await restarted.callback(confirm); assert.equal(restarted.buys.length, 0);
});

test("关闭确认只影响选中链，貔貅风控仍拦截，未知结果明确提示", async (t) => {
  const f = fixture(t);
  await f.callback("set:bsc:confirm:0"); await f.callback(f.buyButton()); assert.equal(f.buys.length, 1);
  await f.callback(f.buyButton("base")); assert.equal(f.buys.length, 1); assert.ok(f.button("confirm:"));
  f.setRisk({ isHoneypot: true, buyTax: 0, sellTax: 99, risk: "high", liquidityUsd: null, holders: null });
  await f.callback(f.buyButton()); assert.equal(f.buys.length, 1); assert.match(f.replies.at(-1)!, /貔貅/);
  f.setRisk(null); await f.callback("set:bsc:confirm:1"); await f.callback(f.buyButton());
  assert.match(f.replies.at(-1)!, /貔貅：未知/); assert.match(f.replies.at(-1)!, /买入税：未知/);
  await f.callback(f.buyButton("rh")); assert.match(f.replies.at(-1)!, /未知/);
});

test("自定义买入保持原链与输入金额，自定义卖出支持小数比例", async (t) => {
  const f = fixture(t);
  await f.callback(`custom:b:base:${TOKEN}`); await f.send("0.0025");
  assert.match(f.replies.at(-1)!, /买入：0.0025 ETH/); assert.equal(f.buys.length, 0);
  await f.callback(f.button("confirm:")); assert.equal(f.buys[0].chain, "base"); assert.equal(f.buys[0].amount, 2500000000000000n);
  await f.callback(`custom:s:base:${TOKEN}`); await f.send("12.5%");
  assert.deepEqual(f.sells[0], { chain: "base", pct: 12.5, slip: 1000 });
});

test("买卖按钮可编辑，旧档位不误买，恢复默认不修改已有仓位", async (t) => {
  const f = fixture(t);
  f.state.recordBuy("bsc", TOKEN, 100n);
  const position = f.state.position("bsc", TOKEN);
  await f.callback("set:bsc:buy-presets"); await f.send("0.004,0.005");
  assert.deepEqual(f.state.chainSettings("bsc").buyAmounts, ["0.004", "0.005"]);
  await f.callback(f.buyButton()); assert.equal(f.buys.length, 0); assert.match(f.answers.at(-1)!, /档位已改变/);
  await f.callback("set:bsc:sell-presets"); await f.send("12.5 100");
  assert.deepEqual(f.state.chainSettings("bsc").sellPercentages, [12.5, 100]);
  await f.callback("set:bsc:reset"); assert.equal(f.state.chainSettings("bsc").buyAmounts?.length, 2);
  await f.callback("reset:bsc"); assert.deepEqual(f.state.chainSettings("bsc"), {});
  assert.deepEqual(f.state.position("bsc", TOKEN), position);
});

test("输入超时和消息失败不会导致重复交易或误报成交失败", async (t) => {
  const f = fixture(t);
  await f.send("/slippage"); const now = Date.now(); const clock = t.mock.method(Date, "now", () => now + 301_000);
  await f.send("30"); assert.equal(f.state.chainSettings("bsc").buySlippageBps, undefined); clock.mock.restore();
  await f.callback(f.buyButton()); const confirm = f.button("confirm:"); f.failEdits();
  await f.callback(confirm); await f.callback(confirm);
  assert.equal(f.buys.length, 1); assert.ok(f.state.position("bsc", TOKEN));
  assert.ok(!f.replies.some((text) => text.includes("买入未完成")));
});

test("四链卡片能生成，按钮callback_data不超Telegram长度限制", async (t) => {
  const f = fixture(t);
  for (const key of ["bsc", "base", "eth", "rh"]) {
    await f.callback(`c:${key}`); await f.send(TOKEN);
  }
  for (const m of f.messages) for (const row of m.kb?.inline_keyboard ?? []) for (const b of row) {
    if ("callback_data" in b) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  }
  assert.equal(f.buys.length, 0); assert.equal(f.sells.length, 0);
});

test("确认后检测变为貔貅或税费变化，会阻止下单", async (t) => {
  const f = fixture(t);
  await f.callback(f.buyButton()); const confirm = f.button("confirm:");
  f.setRisk({ isHoneypot: false, buyTax: 1, sellTax: 20, risk: "high", liquidityUsd: 10000, holders: 1000 });
  await f.callback(confirm); assert.equal(f.buys.length, 0); assert.match(f.replies.at(-1)!, /税已变化/);
  await f.callback(f.buyButton()); const changed = f.button("confirm:");
  f.setRisk({ isHoneypot: true, buyTax: 1, sellTax: 100, risk: "high", liquidityUsd: 10000, holders: 1000 });
  await f.callback(changed); assert.equal(f.buys.length, 0); assert.match(f.replies.at(-1)!, /貔貅/);
});

test("快速买入默认关闭，开启需确认且不能绕过买前确认", async (t) => {
  const f = fixture(t);
  await f.send(TOKEN); assert.equal(f.buys.length, 0);
  await f.callback("set:bsc:quick:1"); assert.equal(f.state.chainSettings("bsc").quickBuy, undefined);
  await f.callback("quick:bsc:enable"); assert.equal(f.state.chainSettings("bsc").quickBuy, true);
  await f.send(TOKEN); assert.equal(f.buys.length, 0); await f.callback(f.button("confirm:")); assert.equal(f.buys.length, 1);
  await f.callback("set:bsc:confirm:0"); await f.send(TOKEN); assert.equal(f.buys.length, 2);
  await f.callback("set:bsc:quick:0"); await f.send(TOKEN); assert.equal(f.buys.length, 2);
  await f.callback("c:base"); await f.send(TOKEN); assert.equal(f.buys.length, 2);
});
