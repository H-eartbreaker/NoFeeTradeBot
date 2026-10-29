import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createBot } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import { State } from "../src/state.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "bot-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(join(dir, "state.json"));
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "123:test", ALLOWED_USER_ID: "123", PRIVATE_KEY: "0x" + "1".repeat(64) });
  const bot = createBot(cfg, new Map(), state);
  bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
  const replies: string[] = [];
  // 真实处理 Telegram update，但拦截所有 API：测试不能联网或发交易。
  bot.api.config.use(async (_previous, method, payload) => {
    assert.equal(method, "sendMessage");
    const text = (payload as { text: string }).text;
    replies.push(text);
    return { ok: true, result: { message_id: replies.length, date: 0, chat: { id: 123, type: "private" }, text } } as never;
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
  return { state, replies, send };
}

test("点滑点菜单后直接回复 30 或百分比即可保存", async (t) => {
  const { state, replies, send } = fixture(t);
  await send("/slippage");
  assert.match(replies.at(-1)!, /直接发送/);
  await send("30");
  assert.equal(state.slippageBps, 3000);
  assert.match(replies.at(-1)!, /30%/);
  await send("/slippage");
  await send("12.5%");
  assert.equal(state.slippageBps, 1250);
});

test("滑点错误可重试，取消和其他命令退出输入，白名单仍生效", async (t) => {
  const { state, send } = fixture(t);
  await send("30");
  assert.equal(state.slippageBps, null);
  await send("/slippage");
  await send("30", 456);
  assert.equal(state.slippageBps, null);
  await send("100");
  assert.equal(state.slippageBps, null);
  await send("30");
  assert.equal(state.slippageBps, 3000);
  await send("/slippage");
  await send("取消");
  await send("40");
  assert.equal(state.slippageBps, 3000);
  await send("/slippage");
  await send("/tpsl off");
  await send("50");
  assert.equal(state.slippageBps, 3000);
  await send("/slippage 20");
  assert.equal(state.slippageBps, 2000);
});
