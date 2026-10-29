// 用四链真实只读数据走 Telegram 卡片→买前确认；拦截所有 Telegram 消息和交易发送。
// NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/ui-smoke.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineKeyboard } from "grammy";
import type { Address } from "viem";
import { createBot } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import { enableKeepAlive } from "../src/http.ts";
import { State } from "../src/state.ts";
import { createClients } from "../src/wallet.ts";

const tokens: Record<string, Address> = {
  bsc: "0x55d398326f99059ff775485246999027b3197955",
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  eth: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  rh: "0xcec185eb182c47d1ba1efc84e6959e18cd620be4",
};
enableKeepAlive(["https://aggregator-api.kyberswap.com", "https://api.honeypot.is"]);
let failures = 0;
for (const key of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(tokens)) {
  const dir = mkdtempSync(join(tmpdir(), "ui-smoke-"));
  const started = performance.now();
  try {
    const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "123:test", ALLOWED_USER_ID: "1", PRIVATE_KEY: "0x" + "1".repeat(64), CHAINS: key });
    const chain = cfg.chains[0];
    const clients = createClients(cfg.privateKey, chain);
    assert.equal(await clients.publicClient.getChainId(), chain.viemChain.id);
    const deps = new Map([[key, { chain, clients }]]);
    let transactionCalls = 0;
    const forbiddenTrade = async (): Promise<never> => { transactionCalls++; throw new Error("只读 UI 测试禁止交易"); };
    const bot = createBot(cfg, deps, new State(join(dir, "state.json")), { buy: forbiddenTrade, sell: forbiddenTrade });
    bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
    const messages: { text: string; kb: InlineKeyboard }[] = [];
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === "answerCallbackQuery") return { ok: true, result: true } as never;
      assert.equal(method, "sendMessage", "不能发出任何真实 Telegram API 请求");
      const p = payload as { text: string; reply_markup: InlineKeyboard };
      assert.ok(p.text.length <= 4096, "Telegram 文本长度");
      for (const row of p.reply_markup?.inline_keyboard ?? []) for (const button of row) if ("callback_data" in button) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
      messages.push({ text: p.text, kb: p.reply_markup });
      return { ok: true, result: { message_id: messages.length, date: 0, chat: { id: 1, type: "private" }, text: p.text } } as never;
    });
    const user = { id: 1, is_bot: false, first_name: "Test" };
    const chat = { id: 1, type: "private" as const, first_name: "Test" };
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, from: user, chat, text: tokens[key] } });
    const card = messages.at(-1)!;
    assert.ok(card.text.includes(`链：${chain.label}`) && card.text.includes(tokens[key]));
    const buy = card.kb.inline_keyboard.flat().find((button) => "callback_data" in button && button.callback_data.startsWith(`b:${key}:`));
    assert.ok(buy && "callback_data" in buy, "应有买入按钮");
    await bot.handleUpdate({ update_id: 2, callback_query: { id: "2", from: user, chat_instance: "test", data: buy.callback_data, message: { message_id: 1, date: 0, chat, text: card.text } } });
    const preview = messages.at(-1)!;
    assert.ok(preview.text.includes("买入前请核对") && preview.text.includes(tokens[key]) && preview.text.includes("买入税") && preview.text.includes("卖出税"));
    assert.ok(preview.text.includes("报价经过") || preview.text.includes("交易池：未知"));
    assert.equal(transactionCalls, 0);
    assert.ok(preview.kb.inline_keyboard.flat().some((button) => "callback_data" in button && button.callback_data.startsWith("confirm:")));
    console.log(JSON.stringify({ chain: key, passed: true, chainId: chain.viemChain.id, realDataCard: true, buyConfirmation: true, unknownRisk: preview.text.includes("貔貅：未知"), tradeCalls: transactionCalls, elapsedMs: Math.round(performance.now() - started) }));
  } catch (error) {
    failures++;
    console.error(JSON.stringify({ chain: key, passed: false, error: error instanceof Error ? error.message.split("\n")[0] : "Unknown error" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
process.exitCode = failures ? 1 : 0;
