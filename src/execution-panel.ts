import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import type { ChainConfig } from "./chains.ts";
import type { Logos } from "./logos.ts";
import type { State } from "./state.ts";
import { PRIVATE_EVM } from "./execution.ts";
import { parseNativeAmount } from "./settings.ts";
import { escapeHtml } from "./util.ts";

type Options = { state: State; chains: ChainConfig[]; logos: Logos; changed: (chain: string) => void };
const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
export function registerExecutionPanel(bot: Bot, o: Options): () => void {
  let input: { chain: string; field: "gas" | "cap"; expires: number } | null = null;
  const clear = () => { input = null; };
  const back = (key: string) => new InlineKeyboard().text("发送与费用", `exec:${key}`).text("返回设置", `settings:${key}`);
  async function show(ctx: Context, key: string) {
    const c = o.chains.find((v) => v.key === key);
    if (!c) { await ctx.reply("本链尚未接入此发送设置。", { reply_markup: new InlineKeyboard().text("返回设置", `settings:${key}`) }); return; }
    const p = o.state.chainSettings(key).execution ?? {}; const provider = PRIVATE_EVM[key];
    const kb = new InlineKeyboard().text(`MEV 保护：${p.mev ? "开启" : provider ? "关闭" : "未支持"}`, `exec:${key}:protect`).row()
      .text(`Gas 单价：${p.gasPriceGwei ? `${p.gasPriceGwei} Gwei` : "自动"}`, `exec:${key}:gas`).row()
      .text(`单笔 Gas 上限：${p.maxTxFee ? `${p.maxTxFee} ${c.nativeSymbol}` : "未设"}`, `exec:${key}:cap`).row()
      .text("返回设置", `settings:${key}`);
    await ctx.reply(["<b>发送与费用</b>", `链：${o.logos.chain(c)}`,
      `私有通道：${provider ? escapeHtml(provider.label) : "尚无已验证通道"}`,
      "开启保护后，通道故障不会转到公开节点发送。保护不能保证绝不被夹，也不保证立即成交。",
      "Gas 上限按每笔链上交易核对，授权交易另计。Base/Robinhood 的额外数据费目前无法完整估算，设置严格上限后会停止发送。",
      "自定义 Gas 过低可能长期无法成交；结果未知时先核对链上记录，不要重复下单。"].join("\n"), { ...HTML, reply_markup: kb });
  }
  bot.callbackQuery(/^exec:([a-z]+)(?::(protect|enable|disable|gas|cap))?$/, async (ctx) => {
    clear(); const key = ctx.match[1]!; const action = ctx.match[2];
    const c = o.chains.find((v) => v.key === key); await ctx.answerCallbackQuery();
    if (!c || !action) { await show(ctx, key); return; }
    const policy = o.state.chainSettings(key).execution ?? {};
    if (action === "protect") {
      if (policy.mev) { o.state.setChainSettings(key, { execution: { ...policy, mev: false } }); o.changed(key); await show(ctx, key); return; }
      const provider = PRIVATE_EVM[key];
      if (!provider) { await ctx.reply("本链没有已验证的私有发送通道，不能开启保护。", { reply_markup: back(key) }); return; }
      await ctx.reply(`使用 ${provider.label} 私有发送？\n不会增加机器人抽成，仍需正常 Gas；通道失败会停止发送。不能保证绝不被夹。`, { reply_markup: new InlineKeyboard().text("确认开启", `exec:${key}:enable`).text("取消", `exec:${key}`) }); return;
    }
    if (action === "enable" || action === "disable") {
      if (action === "enable" && !PRIVATE_EVM[key]) { await show(ctx, key); return; }
      o.state.setChainSettings(key, { execution: { ...policy, mev: action === "enable" } }); o.changed(key); await show(ctx, key); return;
    }
    if (action !== "gas" && action !== "cap") return;
    input = { chain: key, field: action, expires: Date.now() + 300000 };
    await ctx.reply(action === "gas" ? "直接发送 Gas 单价（Gwei），例如 1；最多 9 位小数。发送 off 恢复自动。" : `直接发送每笔链上交易的 Gas 上限，单位 ${c.nativeSymbol}，例如 0.001。授权另计；发 off 关闭上限。`, { reply_markup: new InlineKeyboard().text("取消", `exec:${key}`) });
  });
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (ctx.callbackQuery || text?.startsWith("/")) clear();
    if (!input || !text) { await next(); return; }
    const current = input;
    if (Date.now() >= current.expires) { clear(); await ctx.reply("输入已过期，请重新点选。"); return; }
    if (/^(取消|cancel)$/i.test(text.trim())) { clear(); await show(ctx, current.chain); return; }
    const value = text.trim(); const off = /^(off|关闭|自动)$/i.test(value);
    if (!off && (current.field === "gas" ? !/^\d+(?:\.\d{1,9})?$/.test(value) || Number(value) <= 0 || Number(value) > 100000 : !parseNativeAmount(value))) {
      await ctx.reply("请输入大于 0 的有效数字，或发 off 关闭。"); return;
    }
    const policy = o.state.chainSettings(current.chain).execution ?? {};
    o.state.setChainSettings(current.chain, { execution: { ...policy, ...(current.field === "gas" ? { gasPriceGwei: off ? null : value } : { maxTxFee: off ? null : value }) } });
    o.changed(current.chain); clear(); await show(ctx, current.chain);
  });
  return clear;
}
