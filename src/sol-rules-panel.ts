import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { parseRule } from "./auto-rules.ts";
import type { RuleKind } from "./auto-rules.ts";
import type { State, Rule } from "./state.ts";
import { escapeHtml } from "./util.ts";
const HTML = { parse_mode: "HTML" } as const;
const back = () => new InlineKeyboard().text("止盈止损", "sauto:home").text("返回首页", "nav:start");
export function registerSolRules(bot: Bot, state: State) {
  let input: { mint: string | null; expires: number } | null = null;
  const pending = new Map<string, { mint: string | null; rule: Rule; expires: number }>();
  const textOf = (r: Rule) => `${r.tiers?.length ? r.tiers.map((v) => `涨 ${v.at}% 卖 ${v.pct}%`).join("；") : r.tp ? `涨 ${r.tp}% 全卖` : "止盈关闭"} · ${r.sl ? `跌 ${r.sl}% 全卖` : "止损关闭"} · ${r.trail ? `最高点回撤 ${r.trail}% 全卖` : "移动止损关闭"}`;
  async function show(ctx: Context, mint: string | null = null) {
    const position = mint ? state.position("sol", mint) : null;
    const r = mint ? position : state.chainSettings("sol").autoRule ?? { tp: null, sl: null };
    if (!r) { await ctx.reply("这个币没有已记录的买入成本，暂不能开启自动止盈止损。", { reply_markup: back() }); return; }
    const kb = new InlineKeyboard().text("修改规则", mint ? `sauto:edit:${mint}` : "sauto:edit").row();
    if (position) for (const kind of ["tp", "sl", "trail"] as RuleKind[]) kb.text(`${{ tp: "止盈", sl: "止损", trail: "移动止损" }[kind]}：${position.paused.includes(kind) ? "已暂停" : "未暂停"}`, `sr:${kind}:${mint}:${position.paused.includes(kind) ? 0 : 1}`).row();
    kb.text(`全局自动交易：${state.autoPaused ? "已暂停" : "未暂停"}`, "sauto:pause").row().text("返回首页", "nav:start");
    await ctx.reply(["<b>止盈止损 · Solana</b>", mint ? `代币：<code>${mint}</code>` : "以下默认规则只用于之后新买入的 Solana 仓位。", escapeHtml(textOf(r)),
      "约每 3 秒尝试检查；机器人必须运行。暴跌、撤池或限流时不保证及时卖出。费用不计入触发成本。", "初始关闭，输入并确认后才启用。"].join("\n"), { ...HTML, reply_markup: kb });
  }
  bot.callbackQuery(/^(sauto:(home|pause|edit(?::[1-9A-HJ-NP-Za-km-z]{32,44})?|rule:[1-9A-HJ-NP-Za-km-z]{32,44}|ok:[a-f0-9]{16}|cancel)|sr:(tp|sl|trail):([1-9A-HJ-NP-Za-km-z]{32,44}):([01]))$/, async (ctx) => {
    input = null; await ctx.answerCallbackQuery();
    if (state.activeChain !== "sol") { pending.clear(); await ctx.reply("请先切换到 Solana。"); return; }
    const parts = ctx.callbackQuery.data.split(":");
    if (parts[0] === "sr") { state.setRulePaused("sol", parts[2]!, "main", parts[1] as RuleKind, parts[3] === "1"); await show(ctx, parts[2]); return; }
    if (parts[1] === "pause") { state.setAutoPaused(!state.autoPaused); await show(ctx); return; }
    if (parts[1] === "ok") {
      const p = pending.get(parts[2]!); pending.clear();
      if (!p || p.expires <= Date.now()) { await ctx.reply("确认已过期，请重新设置。"); return; }
      if (p.mint) state.setRule("sol", p.mint, p.rule); else state.setChainSettings("sol", { autoRule: p.rule });
      await show(ctx, p.mint); return;
    }
    if (parts[1] === "cancel") { pending.clear(); await show(ctx); return; }
    if (parts[1] === "edit") {
      if (parts[2] && !state.position("sol", parts[2])) { await show(ctx, parts[2]); return; }
      input = { mint: parts[2] ?? null, expires: Date.now() + 300000 };
      await ctx.reply("直接发 100 30：涨 100% 全卖，跌 30% 全卖。\n分档示例：50/50 100/100 sl30 trail20\n表示涨 50% 卖一半、涨 100% 卖剩下，跌 30% 止损，最高点回撤 20% 移动止损。\n发 off 关闭，确认后生效。", { reply_markup: new InlineKeyboard().text("取消", "sauto:cancel") }); return;
    }
    await show(ctx, parts[1] === "rule" ? parts[2] : null);
  });
  bot.use(async (ctx, next) => {
    const value = ctx.message?.text?.trim();
    if (ctx.callbackQuery || value?.startsWith("/") || state.activeChain !== "sol") input = null;
    if (!input || !value) { await next(); return; }
    if (input.expires <= Date.now()) { input = null; await ctx.reply("输入已过期。"); return; }
    const parsed = parseRule(value);
    if (!parsed) { await ctx.reply("格式不正确，请按提示重发，或发 off 关闭。"); return; }
    const id = randomBytes(8).toString("hex"); const rule = parsed === "off" ? { tp: null, sl: null } : parsed;
    pending.clear(); pending.set(id, { mint: input.mint, rule, expires: Date.now() + 60000 }); input = null;
    await ctx.reply(`确认规则：${textOf(rule)}\n确认后机器人会在满足条件时自动卖出。`, { reply_markup: new InlineKeyboard().text("确认保存", `sauto:ok:${id}`).text("取消", "sauto:cancel") });
  });
  return show;
}
