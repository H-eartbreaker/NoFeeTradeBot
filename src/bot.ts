import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { formatEther } from "viem";
import type { Address } from "viem";
import type { Config } from "./config.ts";
import { checkToken } from "./honeypot.ts";
import type { RiskReport } from "./honeypot.ts";
import { NATIVE, getRoute } from "./kyber.ts";
import type { Route } from "./kyber.ts";
import { nativeFetch } from "./native-fetch.ts";
import { State } from "./state.ts";
import type { Rule } from "./state.ts";
import { readToken } from "./token.ts";
import type { TokenInfo } from "./token.ts";
import { buy, sell } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";
import { errMsg, escapeHtml, extractAddress, fmtUnits, pctToBps } from "./util.ts";

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const ADDR = "(0x[0-9a-f]{40})";
const KEY = "([a-z]+)";

function usd(s: string | undefined): string {
  const n = Number(s);
  return Number.isFinite(n) ? `$${n.toFixed(n < 1 ? 4 : 2)}` : "?";
}

function ruleText(r: Rule): string {
  const parts = [r.tp !== null ? `止盈 +${r.tp}%` : null, r.sl !== null ? `止损 -${r.sl}%` : null].filter(Boolean);
  return parts.length ? parts.join(" / ") : "未设置";
}

export function createBot(cfg: Config, deps: Map<string, TradeDeps>, state: State): Bot {
  const bot = new Bot(cfg.botToken, { client: { fetch: nativeFetch } });
  const slippage = () => state.slippageBps ?? cfg.defaultSlippageBps;
  const activeKey = () => (state.activeChain && deps.has(state.activeChain) ? state.activeChain : cfg.chains[0].key);

  // 只服务白名单用户的私聊；其他人一律静默
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== cfg.allowedUserId || ctx.chat?.type !== "private") {
      console.log(`已忽略非白名单消息: 用户ID ${ctx.from?.id}（.env 里的 ALLOWED_USER_ID 是 ${cfg.allowedUserId}）`);
      return;
    }
    await next();
  });

  async function risk(d: TradeDeps, token: Address): Promise<RiskReport | null> {
    return d.chain.honeypotChainId ? checkToken(d.chain.honeypotChainId, token) : null;
  }

  async function quote(d: TradeDeps, tokenIn: Address, tokenOut: Address, amount: bigint): Promise<Route | null> {
    try {
      return await getRoute(d.chain.kyberSlug!, tokenIn, tokenOut, amount);
    } catch {
      return null;
    }
  }

  async function card(d: TradeDeps, token: Address): Promise<{ text: string; kb: InlineKeyboard } | null> {
    const { chain, clients } = d;
    const sym = chain.nativeSymbol;
    const info = await readToken(clients, token);
    if (!info) return null;
    const [report, buyQuote, sellQuote] = await Promise.all([
      risk(d, token),
      quote(d, NATIVE, token, chain.buyAmounts[0]),
      info.balance > 0n ? quote(d, token, NATIVE, info.balance) : Promise.resolve(null),
    ]);

    const lines = [
      `<b>${escapeHtml(info.symbol)}</b>  ${escapeHtml(info.name)}  · ${chain.label}`,
      `<code>${token}</code>`,
      "",
    ];
    if (!report) {
      lines.push("⚠️ 无法检测貔貅风险（没有交易对或检测服务不可用），请自行判断");
    } else if (report.isHoneypot) {
      lines.push("🚨 <b>貔貅盘：买得进卖不出，已禁用买入</b>");
    } else {
      const tax = (n: number | null) => (n === null ? "?" : `${n.toFixed(1)}%`);
      lines.push(`风险: ${report.risk ?? "?"} | 买税 ${tax(report.buyTax)} | 卖税 ${tax(report.sellTax)}`);
      if ((report.sellTax ?? 0) > 10) lines.push("⚠️ 卖税偏高");
      const extra = [
        report.liquidityUsd !== null ? `流动性 $${Math.round(report.liquidityUsd).toLocaleString("en-US")}` : null,
        report.holders !== null ? `持有人 ${report.holders.toLocaleString("en-US")}` : null,
      ].filter(Boolean);
      if (extra.length) lines.push(extra.join(" | "));
    }

    if (buyQuote) {
      const out = BigInt(buyQuote.routeSummary.amountOut);
      lines.push(
        `报价: ${formatEther(chain.buyAmounts[0])} ${sym} ≈ ${fmtUnits(out, info.decimals)} ${escapeHtml(info.symbol)} (${usd(buyQuote.routeSummary.amountOutUsd)})`,
      );
    } else {
      lines.push("⚠️ 暂无报价（没有流动性，或还在 bonding curve 阶段，v1 不支持）");
    }

    const pos = info.balance > 0n ? state.position(chain.key, token) : null;
    if (info.balance > 0n) {
      const value = sellQuote ? BigInt(sellQuote.routeSummary.amountOut) : null;
      const worth = value !== null && sellQuote ? ` ≈ ${fmtUnits(value, 18, 5)} ${sym} (${usd(sellQuote.routeSummary.amountOutUsd)})` : "";
      lines.push(`持仓: ${fmtUnits(info.balance, info.decimals)} ${escapeHtml(info.symbol)}${worth}`);
      if (pos && pos.cost > 0n) {
        const pnl = value !== null ? `，盈亏 ${(Number(((value - pos.cost) * 10_000n) / pos.cost) / 100).toFixed(1)}%` : "";
        lines.push(`成本: ${fmtUnits(pos.cost, 18, 5)} ${sym}${pnl}`);
        lines.push(`自动止盈止损: ${ruleText(pos)}`);
      }
    }
    lines.push(`滑点 ${slippage() / 100}%`);

    const kb = new InlineKeyboard();
    if (buyQuote && !report?.isHoneypot) {
      chain.buyAmounts.forEach((a, i) => kb.text(`买 ${formatEther(a)} ${sym}`, `b:${chain.key}:${token}:${i}`));
      kb.row();
    }
    if (info.balance > 0n) {
      for (const p of [25, 50, 100]) kb.text(`卖 ${p}%`, `s:${chain.key}:${token}:${p}`);
      kb.row();
    }
    if (pos) {
      kb.text(pos.tp !== null || pos.sl !== null ? "🎯 关闭止盈止损" : "🎯 开启止盈止损", `t:${chain.key}:${token}`).row();
    }
    kb.text("🔄 刷新", `r:${chain.key}:${token}`);
    return { text: lines.join("\n"), kb };
  }

  async function showCard(ctx: Context, d: TradeDeps, token: Address, edit: boolean): Promise<void> {
    const c = await card(d, token);
    if (!c) {
      await ctx.reply(`这个地址在 ${d.chain.label} 上不是有效的代币合约（用 /chain 可以切换链）`);
      return;
    }
    if (edit) {
      await ctx.editMessageText(c.text, { ...HTML, reply_markup: c.kb }).catch(() => undefined);
    } else {
      await ctx.reply(c.text, { ...HTML, reply_markup: c.kb });
    }
  }

  // 交易结束后原地刷新卡片，避免按钮和持仓显示过期
  async function refreshCard(ctx: Context, d: TradeDeps, token: Address): Promise<void> {
    try {
      await showCard(ctx, d, token, true);
    } catch (e) {
      console.log("刷新卡片失败:", errMsg(e));
    }
  }

  function dep(ctx: Context, key: string | undefined): TradeDeps | null {
    const d = key ? deps.get(key) : undefined;
    if (!d) void ctx.answerCallbackQuery("这条链未启用");
    return d ?? null;
  }

  async function help(ctx: Context): Promise<void> {
    const d = deps.get(activeKey())!;
    await ctx.reply(
      [
        `<b>交易终端</b>  当前链: ${d.chain.label}`,
        `钱包: <code>${d.clients.account.address}</code>`,
        "",
        "• 直接发送代币合约地址 → 查看信息并买卖",
        "• /chain → 切换链",
        "• /balance → 各链余额和持仓",
        "• /slippage 10 → 设置滑点百分比（最大 20）",
        "• /tpsl 100 30 → 新买入自动设置 +100% 止盈、-30% 止损（/tpsl off 关闭）",
        `   当前: ${ruleText(state.defaultRule)}`,
      ].join("\n"),
      HTML,
    );
  }

  bot.command(["start", "help"], help);

  bot.command("chain", async (ctx) => {
    const kb = new InlineKeyboard();
    for (const c of cfg.chains) kb.text(`${c.key === activeKey() ? "✅ " : ""}${c.label}`, `c:${c.key}`).row();
    await ctx.reply("选择要交易的链:", { reply_markup: kb });
  });

  bot.callbackQuery(new RegExp(`^c:${KEY}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]);
    if (!d) return;
    state.setActiveChain(d.chain.key);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`已切换到 ${d.chain.label}，现在发送代币合约地址即可`).catch(() => undefined);
  });

  bot.command("balance", async (ctx) => {
    const kb = new InlineKeyboard();
    const sections = await Promise.all(
      cfg.chains.map(async (c) => {
        const d = deps.get(c.key)!;
        try {
          const native = await d.clients.publicClient.getBalance({ address: d.clients.account.address });
          const lines = [`<b>${c.label}</b>  ${c.nativeSymbol}: ${fmtUnits(native, 18, 5)}`];
          const infos = await Promise.all(state.tokens(c.key).map((t) => readToken(d.clients, t as Address)));
          for (const i of infos.filter((x): x is TokenInfo => !!x && x.balance > 0n)) {
            lines.push(`  ${escapeHtml(i.symbol)}: ${fmtUnits(i.balance, i.decimals)}`);
            kb.text(`${i.symbol} · ${c.key}`, `r:${c.key}:${i.address}`).row();
          }
          return lines.join("\n");
        } catch (e) {
          return `<b>${c.label}</b>  查询失败: ${escapeHtml(errMsg(e))}`;
        }
      }),
    );
    await ctx.reply(`钱包: <code>${deps.get(activeKey())!.clients.account.address}</code>\n\n${sections.join("\n\n")}`, {
      ...HTML,
      reply_markup: kb,
    });
  });

  bot.command("slippage", async (ctx) => {
    const bps = pctToBps(Number(ctx.match.trim()));
    if (bps === null) {
      await ctx.reply(`用法: /slippage 10（0 到 20 之间）。当前 ${slippage() / 100}%`);
      return;
    }
    state.setSlippage(bps);
    await ctx.reply(`滑点已设为 ${bps / 100}%`);
  });

  bot.command("tpsl", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    if (!arg) {
      await ctx.reply(`当前默认: ${ruleText(state.defaultRule)}\n用法: /tpsl 100 30（止盈 +100%，止损 -30%，填 0 表示不设）；/tpsl off 关闭`);
      return;
    }
    if (arg === "off") {
      state.setDefaultRule({ tp: null, sl: null });
      await ctx.reply("已关闭默认止盈止损（已有仓位不受影响，可在代币卡片里单独关闭）");
      return;
    }
    const [a, b] = arg.split(/\s+/).map(Number);
    const ok = Number.isFinite(a) && Number.isFinite(b) && a >= 0 && a <= 10_000 && b >= 0 && b < 100 && (a > 0 || b > 0);
    if (!ok) {
      await ctx.reply("格式不对。例: /tpsl 100 30（止盈 0~10000，止损 0~99，填 0 表示不设）");
      return;
    }
    const rule = { tp: a > 0 ? a : null, sl: b > 0 ? b : null };
    state.setDefaultRule(rule);
    await ctx.reply(
      `默认已设为: ${ruleText(rule)}\n之后每次新买入会自动套用，机器人每 20 秒检查一次，触发后全部卖出。\n已持有的仓位请在代币卡片里点「开启止盈止损」。`,
    );
  });

  bot.on("message:text", async (ctx) => {
    const token = extractAddress(ctx.message.text);
    if (!token) return;
    await showCard(ctx, deps.get(activeKey())!, token, false);
  });

  bot.callbackQuery(new RegExp(`^r:${KEY}:${ADDR}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]);
    if (!d) return;
    await ctx.answerCallbackQuery();
    await showCard(ctx, d, ctx.match[2] as Address, true);
  });

  bot.callbackQuery(new RegExp(`^t:${KEY}:${ADDR}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]);
    if (!d) return;
    const token = ctx.match[2] as Address;
    const pos = state.position(d.chain.key, token);
    if (!pos) return void (await ctx.answerCallbackQuery("没有这个仓位的买入记录"));
    if (pos.tp !== null || pos.sl !== null) {
      state.setRule(d.chain.key, token, { tp: null, sl: null });
      await ctx.answerCallbackQuery("已关闭止盈止损");
    } else if (state.defaultRule.tp === null && state.defaultRule.sl === null) {
      return void (await ctx.answerCallbackQuery({ text: "先用 /tpsl 100 30 设置默认值", show_alert: true }));
    } else {
      state.setRule(d.chain.key, token, state.defaultRule);
      await ctx.answerCallbackQuery(`已开启: ${ruleText(state.defaultRule)}`);
    }
    await refreshCard(ctx, d, token);
  });

  bot.callbackQuery(new RegExp(`^b:${KEY}:${ADDR}:(\\d+)$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]);
    if (!d) return;
    const token = ctx.match[2] as Address;
    const amount = d.chain.buyAmounts[Number(ctx.match[3])];
    if (amount === undefined) return void (await ctx.answerCallbackQuery("无效的买入档位"));
    const sym = d.chain.nativeSymbol;
    await ctx.answerCallbackQuery("买入提交中…");
    const pending = await ctx.reply(`⏳ 买入中 ${formatEther(amount)} ${sym}…`);
    try {
      const report = await risk(d, token);
      if (report?.isHoneypot) throw new Error("检测到貔貅盘，已拒绝买入");
      const info = await readToken(d.clients, token);
      if (!info) throw new Error("不是有效的代币合约");
      const r = await buy(d, token, amount, slippage());
      state.recordBuy(d.chain.key, token, amount);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        pending.message_id,
        `✅ 买入成功 ${formatEther(amount)} ${sym} → ${fmtUnits(r.received, info.decimals)} ${escapeHtml(info.symbol)}\n<a href="${d.chain.explorerTx(r.hash)}">查看交易</a>`,
        HTML,
      );
      await refreshCard(ctx, d, token);
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat!.id, pending.message_id, `❌ 买入失败: ${errMsg(e)}`);
    }
  });

  bot.callbackQuery(new RegExp(`^s:${KEY}:${ADDR}:(25|50|100)$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]);
    if (!d) return;
    const token = ctx.match[2] as Address;
    const pct = Number(ctx.match[3]);
    const sym = d.chain.nativeSymbol;
    await ctx.answerCallbackQuery("卖出提交中…");
    const pending = await ctx.reply(`⏳ 卖出 ${pct}% 中…`);
    try {
      const info = await readToken(d.clients, token);
      if (!info) throw new Error("不是有效的代币合约");
      const r = await sell(d, token, pct, slippage());
      state.recordSell(d.chain.key, token, pct);
      const approveNote = r.approveHash ? `\n（含一次授权: <a href="${d.chain.explorerTx(r.approveHash)}">交易</a>）` : "";
      await ctx.api.editMessageText(
        ctx.chat!.id,
        pending.message_id,
        `✅ 卖出成功 ${fmtUnits(r.soldAmount, info.decimals)} ${escapeHtml(info.symbol)} → 约 ${fmtUnits(r.receivedNative, 18, 6)} ${sym}\n<a href="${d.chain.explorerTx(r.hash)}">查看交易</a>${approveNote}`,
        HTML,
      );
      await refreshCard(ctx, d, token);
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat!.id, pending.message_id, `❌ 卖出失败: ${errMsg(e)}`);
    }
  });

  // 旧版本发出的、没有链标识的按钮
  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery("按钮已过期，请重新发送代币地址"));

  bot.catch((err) => {
    console.error("bot error:", errMsg(err.error));
  });

  return bot;
}
