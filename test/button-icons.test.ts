import assert from "node:assert/strict";
import { test } from "node:test";
import { buttonIcon, decorateButtons } from "../src/button-icons.ts";

test("菜单图标对应功能，链 Logo 不覆盖，不增加按钮或改变回调", () => {
  for (const [text, data, icon] of [["钱包管理", "wallet:page:0", "👛"], ["充值地址", "wallet:deposit:main", "📥"], ["持仓与余额", "nav:balance", "📊"], ["转账", "funds:transfer", "📤"], ["跨链", "funds:bridge", "🌉"], ["兑换", "funds:swap", "🔄"], ["交易记录", "history:main:bsc:0", "📜"], ["设置", "nav:settings", "⚙️"], ["刷新", "history:main:bsc:0", "🔄"]]) assert.equal(buttonIcon(text, data), icon);
  const payload = { chat_id: 123, text: "原消息", reply_markup: { inline_keyboard: [[{ text: "钱包管理", callback_data: "wallet:page:0" }, { text: "BNB", callback_data: "c:bsc", icon_custom_emoji_id: "1000" }], [{ text: "未知功能", callback_data: "future" }]] } };
  const decorated = decorateButtons(payload);
  assert.equal(decorated.reply_markup.inline_keyboard[0][0].text, "👛 钱包管理");
  assert.deepEqual(decorated.reply_markup.inline_keyboard[0][1], payload.reply_markup.inline_keyboard[0][1]);
  assert.deepEqual(decorated.reply_markup.inline_keyboard[1], payload.reply_markup.inline_keyboard[1]);
  assert.equal(decorated.reply_markup.inline_keyboard[0][0].callback_data, "wallet:page:0");
  assert.equal(payload.reply_markup.inline_keyboard[0][0].text, "钱包管理");
  assert.deepEqual(decorateButtons(decorated), decorated);
  assert.deepEqual(decorateButtons({ text: "消息" }), { text: "消息" });
});
