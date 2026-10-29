import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Bot, InlineKeyboard } from "grammy";
import type { MessageEntity } from "grammy/types";
import { CHAINS } from "../src/chains.ts";
import { extractLogos, LOGO_CHAINS, Logos, registerLogos, stripCustomEmoji } from "../src/logos.ts";
import { State } from "../src/state.ts";

const TEXT = "🟦 Base: 0.001 💎 ($2)\n💠 Ethereum: 0 💎 ($0)\n🟨 Binance: 1 🟡 ($700)\n🪶 Robinhood: 0 💎 ($0)\n🟪 Solana: 0 🟣 ($0)";
function entities(text: string): MessageEntity[] {
  const emojis = [...text.matchAll(/[🟦💎💠🟨🟡🪶🟪🟣]/gu)];
  return emojis.map((m, i) => ({ type: "custom_emoji", offset: m.index!, length: m[0].length, custom_emoji_id: String(1000 + i) }));
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "logos-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json"); const state = new State(file);
  const calls: { method: string; text?: string; reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] } }[] = [];
  let rejectEmoji = false; let networkError = false; let escaped = 0;
  const bot = new Bot("123:test", { client: { fetch: async (url: string | URL, init?: { body?: unknown }) => {
    if (networkError) throw new Error("timeout");
    const p = JSON.parse(init!.body as string);
    const method = String(url).split("/").at(-1)!; calls.push({ ...p, method });
    if (rejectEmoji && JSON.stringify(p).includes("tg-emoji")) return Response.json({ ok: false, error_code: 400, description: "Bad Request: CUSTOM_EMOJI_NOT_ALLOWED" }) as never;
    return Response.json({ ok: true, result: method === "answerCallbackQuery" ? true : { message_id: calls.length, date: 0, chat: { id: 123, type: "private" }, text: p.text } }) as never;
  } } });
  bot.botInfo = { id: 999, username: "test_bot", first_name: "Test", is_bot: true } as never;
  bot.use(async (ctx, next) => { if (ctx.from?.id === 123 && ctx.chat?.type === "private") await next(); });
  const logos = registerLogos(bot, state, Object.values(CHAINS));
  bot.on("message:text", async () => { escaped++; });
  let id = 0;
  const from = (user = 123) => ({ id: user, is_bot: false, first_name: "Test" });
  async function send(text: string, e: MessageEntity[] = [], user = 123) {
    await bot.handleUpdate({ update_id: ++id, message: { message_id: id, date: 0, from: from(user), chat: { id: user, type: "private", first_name: "Test" }, text, entities: e } });
  }
  async function callback(data: string, user = 123) {
    await bot.handleUpdate({ update_id: ++id, callback_query: { id: String(id), from: from(user), chat_instance: "test", data,
      message: { message_id: 1, date: 0, chat: { id: user, type: "private", first_name: "Test" }, text: "settings" } } });
  }
  const button = (prefix: string) => calls.flatMap((p) => p.reply_markup?.inline_keyboard.flat() ?? []).filter((b) => b.callback_data?.startsWith(prefix)).at(-1)!.callback_data!;
  return { state, file, logos, bot, calls, send, callback, button, escaped: () => escaped,
    reject: () => { rejectEmoji = true; }, networkError: () => { networkError = true; } };
}
test("从 UTF-16 表情位置识别四条链和原生币 Logo，忽略未支持链", () => {
  assert.deepEqual(extractLogos(TEXT, entities(TEXT), Object.keys(CHAINS)), {
    base: { chain: "1000", native: "1001" }, eth: { chain: "1002", native: "1003" },
    bsc: { chain: "1004", native: "1005" }, rh: { chain: "1006", native: "1007" },
  });
  assert.deepEqual(extractLogos(TEXT, [], Object.keys(CHAINS)), {});
  assert.deepEqual(extractLogos(TEXT, entities(TEXT), ["base"]), { base: { chain: "1000", native: "1001" } });
  const invalid = entities(TEXT).map((e) => ({ ...e, custom_emoji_id: '\" onclick="bad' }));
  assert.deepEqual(extractLogos(TEXT, invalid, Object.keys(CHAINS)), {});
});
test("导入先预览，白名单限制，确认只保存图标不保存转发余额与地址", async (t) => {
  const f = fixture(t);
  await f.callback("logos:import"); await f.send(TEXT, entities(TEXT), 456);
  assert.deepEqual(f.state.logos.chains, {});
  const ca = "0x1111111111111111111111111111111111111111";
  await f.send(`${TEXT}\n${ca}`, entities(TEXT));
  assert.deepEqual(f.state.logos.chains, {}); assert.equal(f.escaped(), 0);
  const confirm = f.button("logos:save:");
  await f.callback(confirm, 456); assert.deepEqual(f.state.logos.chains, {});
  await f.callback(confirm); assert.equal(f.state.logos.chains.base.chain, "1000");
  const saved = readFileSync(f.file, "utf8");
  assert.ok(!saved.includes(ca)); assert.ok(!saved.includes("$700"));
  await f.callback(confirm); assert.match(f.calls.at(-1)!.text!, /过期/);
  const reload = new State(f.file); assert.deepEqual(reload.logos, f.state.logos);
});
test("截图中 19 条链都能收藏，名字别名归一，未知链不会错误归到罗宾汉", () => {
  const text = LOGO_CHAINS.map((c) => `🟦 ${c.aliases[0]}: 0 💎 ($0)`).join("\n");
  const found = extractLogos(text, entities(text));
  assert.equal(Object.keys(found).length, 19);
  for (const c of LOGO_CHAINS) assert.ok(found[c.key]?.chain && found[c.key]?.native, c.label);
  const other = "🟦 UnknownChain: 0 💎 ($0)";
  assert.deepEqual(extractLogos(other, entities(other)), {});
  const alias = "🟦 xlayer: 0 💎 ($0)\n🟦 罗宾汉链: 0 💎 ($0)";
  assert.deepEqual(Object.keys(extractLogos(alias, entities(alias))).sort(), ["rh", "xlayer"]);
});
test("一次导入收藏未启用链，重启后能复用，二次导入保留已有图标", async (t) => {
  const f = fixture(t); f.state.setLogos({ chains: { base: { chain: "9999", native: "9998" } } });
  const text = LOGO_CHAINS.filter((c) => !["base", "bsc", "eth", "rh"].includes(c.key)).map((c) => `🟦 ${c.label}: 0 💎 ($0)`).join("\n");
  await f.callback("logos:import"); await f.send(text, entities(text));
  assert.match(f.calls.at(-1)!.text!, /Solana.*收藏备用/);
  assert.ok(!f.state.logos.chains.solana);
  await f.callback(f.button("logos:save:"));
  assert.equal(Object.keys(f.state.logos.chains).length, 16);
  assert.equal(f.state.logos.chains.base.chain, "9999");
  assert.match(f.calls.at(-1)!.text!, /已收藏备用：15 条链/);
  assert.ok(f.calls.at(-1)!.text!.length < 4096);
  const restarted = new Logos(new State(f.file));
  assert.match(restarted.chain({ key: "solana", label: "Solana" }), /tg-emoji/);
  assert.equal(f.escaped(), 0);
  await f.callback("logos:toggle");
  assert.equal(Object.keys(f.state.logos.chains).length, 16);
  assert.equal(f.logos.savedNative("solana"), "已保存");
});
test("取消、超时和其他命令不会误保存，截图或无表情消息继续提示", async (t) => {
  const f = fixture(t);
  await f.callback("logos:import"); await f.send("只是文字");
  assert.match(f.calls.at(-1)!.text!, /没找到/); assert.equal(f.escaped(), 0);
  await f.send(TEXT, entities(TEXT)); const confirm = f.button("logos:save:");
  const now = Date.now(); const mocked = t.mock.method(Date, "now", () => now + 61_000);
  await f.callback(confirm); assert.deepEqual(f.state.logos.chains, {}); mocked.mock.restore();
  await f.callback("logos:import"); await f.send("取消"); await f.send(TEXT, entities(TEXT));
  assert.equal(f.escaped(), 1);
  await f.callback("logos:import"); await f.send("/start"); await f.send(TEXT, entities(TEXT));
  assert.equal(f.escaped(), 3); assert.deepEqual(f.state.logos.chains, {});
});
test("四链文字和按钮都可用自定义 Logo；关闭后只显示名字且保留配置", (t) => {
  const f = fixture(t); f.state.setLogos({ chains: { base: { chain: "1000", native: "1001" } } });
  assert.match(f.logos.chain(CHAINS.base), /<tg-emoji emoji-id="1000">/);
  assert.match(f.logos.native(CHAINS.base), /1001/);
  const kb = f.logos.button(new InlineKeyboard(), CHAINS.base, "Base", "c:base");
  assert.equal(kb.inline_keyboard[0][0].icon_custom_emoji_id, "1000");
  f.state.setLogos({ enabled: false });
  assert.equal(f.logos.chain(CHAINS.base), "Base"); assert.equal(f.logos.native(CHAINS.base), "ETH");
  assert.equal(f.logos.button(new InlineKeyboard(), CHAINS.base, "Base", "c:base").inline_keyboard[0][0].icon_custom_emoji_id, undefined);
  assert.equal(f.state.logos.chains.base.chain, "1000");
});
test("Telegram 明确拒绝表情时回退文字，网络错误不重发", async (t) => {
  const f = fixture(t); f.state.setLogos({ chains: { base: { chain: "1000" } } }); f.reject();
  await f.bot.api.sendMessage(123, f.logos.chain(CHAINS.base), { parse_mode: "HTML", reply_markup: f.logos.button(new InlineKeyboard(), CHAINS.base, "Base", "c:base") });
  assert.equal(f.calls.length, 2); assert.ok(!JSON.stringify(f.calls[1]).includes("tg-emoji"));
  assert.ok(!JSON.stringify(f.calls[1]).includes("icon_custom_emoji_id"));
  assert.equal(f.logos.chain(CHAINS.base), "Base");
  const broken = fixture(t); broken.networkError();
  await assert.rejects(broken.bot.api.sendMessage(123, '<tg-emoji emoji-id="1000">🔗</tg-emoji>', { parse_mode: "HTML" }));
  assert.equal(broken.calls.length, 0);
  assert.deepEqual(stripCustomEmoji({ text: '<tg-emoji emoji-id="1000">🔗</tg-emoji> Base', value: "0xabc" }), { text: "🔗 Base", value: "0xabc" });
});
