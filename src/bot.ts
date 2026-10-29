import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { formatEther } from "viem";
import type { Address } from "viem";
import type { Config } from "./config.ts";
import { checkToken } from "./honeypot.ts";
import type { RiskReport } from "./honeypot.ts";
import { NATIVE, getRoute } from "./kyber.ts";
import { nativeFetch } from "./native-fetch.ts";
import type { Route } from "./kyber.ts";
import { State } from "./state.ts";
import { readToken } from "./token.ts";
import type { TokenInfo } from "./token.ts";
import { buy, sell } from "./trade.ts";
import { errMsg, escapeHtml, extractAddress, fmtUnits, pctToBps } from "./util.ts";
import type { Clients } from "./wallet.ts";

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

function usd(s: string | undefined): string {
  const n = Number(s);
  return Number.isFinite(n) ? `$${n.toFixed(n < 1 ? 4 : 2)}` : "?";
}

export function createBot(cfg: Config, clients: Clients, state: State): Bot {
  const bot = new Bot(cfg.botToken, { client: { fetch: nativeFetch } });
  const deps = { clients, chain: cfg.chain };
  const sym = cfg.chain.nativeSymbol;
  const slippage = () => state.slippageBps ?? cfg.defaultSlippageBps;

  // 只服务白名单用户的私聊；其他人一律静默
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== cfg.allowedUserId || ctx.chat?.type !== "private") {
      console.log(`已忽略非白名单消息: 用户ID ${ctx.from?.id}（.env 里的 ALLOWED_USER_ID 是 ${cfg.allowedUserId}）`);
      return;
    }
    await next();
  });

  async function risk(token: Address): Promise<RiskReport | null> {
    return cfg.chain.honeypotChainId ? checkToken(cfg.chain.honeypotChainId, token) : null;
  }

  async function quote(tokenIn: Address, tokenOut: Address, amount: bigint): Promise<Route | null> {
    try {
      return await getRoute(cfg.chain.kyberSlug!, tokenIn, tokenOut, amount);
    } catch {
      return null;
    }
  }

  async function card(token: Address): Promise<{ text: string; kb: InlineKeyboard } | null> {
    const info = await readToken(clients, token);
    if (!info) return null;
    const [report, buyQuote, sellQuote] = await Promise.all([
      risk(token),
      quote(NATIVE, token, cfg.buyAmounts[0]),
      info.balance > 0n ? quote(token, NATIVE, info.balance) : Promise.resolve(null),
    ]);

    const lines = [
      `<b>${escapeHtml(info.symbol)}</b>  ${escapeHtml(info.name)}`,
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
        `报价: ${formatEther(cfg.buyAmounts[0])} ${sym} ≈ ${fmtUnits(out, info.decimals)} ${escapeHtml(info.symbol)} (${usd(buyQuote.routeSummary.amountOutUsd)})`,
      );
    } else {
      lines.push("⚠️ 暂无报价（没有流动性，或还在 bonding curve 阶段，v1 不支持）");
    }
    if (info.balance > 0n) {
      const worth = sellQuote ? ` ≈ ${fmtUnits(BigInt(sellQuote.routeSummary.amountOut), 18, 5)} ${sym} (${usd(sellQuote.routeSummary.amountOutUsd)})` : "";
      lines.push(`持仓: ${fmtUnits(info.balance, info.decimals)} ${escapeHtml(info.symbol)}${worth}`);
    }
    lines.push(`滑点 ${slippage() / 100}%`);

    const kb = new InlineKeyboard();
    if (buyQuote && !report?.isHoneypot) {
      cfg.buyAmounts.forEach((a, i) => kb.text(`买 ${formatEther(a)} ${sym}`, `b:${token}:${i}`));
      kb.row();
    }
    if (info.balance > 0n) {
      for (const p of [25, 50, 100]) kb.text(`卖 ${p}%`, `s:${token}:${p}`);
      kb.row();
    }
    kb.text("🔄 刷新", `r:${token}`);
    return { text: lines.join("\n"), kb };
  }

  async function showCard(ctx: Context, token: Address, edit: boolean): Promise<void> {
    const c = await card(token);
    if (!c) {
      await ctx.reply("这个地址不是有效的代币合约（或不在当前链上）");
      return;
    }
    if (edit) {
      await ctx.editMessageText(c.text, { ...HTML, reply_markup: c.kb }).catch(() => undefined);
    } else {
      await ctx.reply(c.text, { ...HTML, reply_markup: c.kb });
    }
  }

  async function help(ctx: Context): Promise<void> {
    await ctx.reply(
      [
        `<b>${cfg.chain.label} 交易终端</b>`,
        `钱包: <code>${clients.account.address}</code>`,
        "",
        "• 直接发送代币合约地址 → 查看信息并买卖",
        "• /balance → 余额和持仓",
        "• /slippage 10 → 设置滑点百分比（最大 20）",
      ].join("\n"),
      HTML,
    );
  }

  bot.command(["start", "help"], help);

  bot.command("balance", async (ctx) => {
    const native = await clients.publicClient.getBalance({ address: clients.account.address });
    const lines = [`${sym}: ${fmtUnits(native, 18, 5)}`];
    const kb = new InlineKeyboard();
    const infos = await Promise.all(state.tokens.map((t) => readToken(clients, t as Address)));
    for (const i of infos.filter((x): x is TokenInfo => !!x && x.balance > 0n)) {
      lines.push(`${escapeHtml(i.symbol)}: ${fmtUnits(i.balance, i.decimals)}`);
      kb.text(i.symbol, `r:${i.address}`).row();
    }
    await ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
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

  bot.on("message:text", async (ctx) => {
    const token = extractAddress(ctx.message.text);
    if (!token) return;
    await showCard(ctx, token, false);
  });

  bot.callbackQuery(/^r:(0x[0-9a-f]{40})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showCard(ctx, ctx.match[1] as Address, true);
  });

  bot.callbackQuery(/^b:(0x[0-9a-f]{40}):(\d+)$/, async (ctx) => {
    const token = ctx.match[1] as Address;
    const amount = cfg.buyAmounts[Number(ctx.match[2])];
    if (amount === undefined) return void (await ctx.answerCallbackQuery("无效的买入档位"));
    await ctx.answerCallbackQuery("买入提交中…");
    const pending = await ctx.reply(`⏳ 买入中 ${formatEther(amount)} ${sym}…`);
    try {
      const report = await risk(token);
      if (report?.isHoneypot) throw new Error("检测到貔貅盘，已拒绝买入");
      const info = await readToken(clients, token);
      if (!info) throw new Error("不是有效的代币合约");
      const r = await buy(deps, token, amount, slippage());
      state.addToken(token);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        pending.message_id,
        `✅ 买入成功 ${formatEther(amount)} ${sym} → ${fmtUnits(r.received, info.decimals)} ${escapeHtml(info.symbol)}\n<a href="${cfg.chain.explorerTx(r.hash)}">查看交易</a>`,
        HTML,
      );
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat!.id, pending.message_id, `❌ 买入失败: ${errMsg(e)}`);
    }
  });

  bot.callbackQuery(/^s:(0x[0-9a-f]{40}):(25|50|100)$/, async (ctx) => {
    const token = ctx.match[1] as Address;
    const pct = Number(ctx.match[2]);
    await ctx.answerCallbackQuery("卖出提交中…");
    const pending = await ctx.reply(`⏳ 卖出 ${pct}% 中…`);
    try {
      const info = await readToken(clients, token);
      if (!info) throw new Error("不是有效的代币合约");
      const r = await sell(deps, token, pct, slippage());
      const approveNote = r.approveHash ? `\n（含一次授权: <a href="${cfg.chain.explorerTx(r.approveHash)}">交易</a>）` : "";
      await ctx.api.editMessageText(
        ctx.chat!.id,
        pending.message_id,
        `✅ 卖出成功 ${fmtUnits(r.soldAmount, info.decimals)} ${escapeHtml(info.symbol)} → 约 ${fmtUnits(r.receivedNative, 18, 6)} ${sym}\n<a href="${cfg.chain.explorerTx(r.hash)}">查看交易</a>${approveNote}`,
        HTML,
      );
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat!.id, pending.message_id, `❌ 卖出失败: ${errMsg(e)}`);
    }
  });

  bot.catch((err) => {
    console.error("bot error:", errMsg(err.error));
  });

  return bot;
}
