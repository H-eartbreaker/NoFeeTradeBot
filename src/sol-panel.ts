import { formatUnits } from "viem";
import { SOLANA, parseSolAmount, parseSolPresets, solSettings } from "./sol-settings.ts";
import { parseSellPercentage, parseSellPresets, presetVersion } from "./settings.ts";
import type { ChainConfig } from "./chains.ts";
import type { Logos } from "./logos.ts";
import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { SolanaWallet } from "./sol-wallet.ts";
import { holdings, isSolanaAddress, mintInfo, openRpc, solBalance, SOL_DECIMALS, SOL_MINT, quote, tokenMeta } from "./sol-chain.ts";
import type { MintInfo, SolRpc, TokenMeta, Quote } from "./sol-chain.ts";
import { buySol, serial, SolPendingError, sellToken, SolTradeError } from "./sol-trade.ts";
import type { State } from "./state.ts";
import { registerSolRules } from "./sol-rules-panel.ts";
import { registerSolFinance } from "./sol-finance-panel.ts";
import type { Journal } from "./journal.ts";
import { errMsg, escapeHtml, fmtUnits, parseSlippageInput } from "./util.ts";

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const BASE58_MINT = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const BASE58_LIKE = new RegExp(`^${BASE58_MINT}$`);
const INPUT_MS = 5 * 60_000;
const CONFIRM_MS = 60_000;
const MAX_PENDING = 50;
const MAX_HOLDINGS_SHOWN = 10;

type Pending = { owner: string; quote: Quote; settingsVersion: string; revision: number } & (
  | { kind: "buy"; mint: string; symbol: string; decimals: number; lamports: bigint; slippageBps: number; expires: number }
  | { kind: "sell"; mint: string; symbol: string; decimals: number; pct: number; slippageBps: number; expires: number });

type Input =
  | { kind: "buy-slip" | "sell-slip" | "both-slip" | "buy-presets" | "sell-presets" | "zone"; expires: number }
  | { kind: "custom" | "sell"; mint: string; expires: number };

type Options = {
  state: State; rpcUrl: string; chains: ChainConfig[]; logos: Logos;
  mainKeyboard: () => InlineKeyboard; navigate: (ctx: Context) => Promise<void>;
  journal?: Journal;
};
const defaultServices = {
  holdings, mintInfo, solBalance, tokenMeta, quote, buySol, sellToken,
  wallet: (): Pick<SolanaWallet, "address" | "signer" | "generate"> => new SolanaWallet(),
  openRpc,
};
export type SolanaServices = typeof defaultServices;
type DistributiveOmit<T> = T extends unknown ? Omit<T, "expires"> : never;

const shortMint = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;
const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;

function mintLines(info: MintInfo): string[] {
  return [`增发权限：${info.mintAuthority ? "未放弃" : "已放弃"}`, `冻结权限：${info.freezeAuthority ? "存在" : "无"}`,
    "貔貅检测：未知（暂不支持 Solana）", "买入税 / 卖出税：未知（未检查 Token-2022 扩展）"];
}
function quoteLines(q: Quote): string[] {
  const plans = Array.isArray(q.routePlan) ? q.routePlan : [];
  const pools = plans.flatMap((p: unknown) => {
    if (!p || typeof p !== "object") return [];
    const info = (p as { swapInfo?: { label?: unknown; ammKey?: unknown } }).swapInfo;
    return info && typeof info.ammKey === "string" ? [`${escapeHtml(String(info.label ?? "未知交易所"))}：<code>${escapeHtml(info.ammKey)}</code>`] : [];
  });
  return ["交易池：", ...new Set(pools.length ? pools : ["未知（报价未返回池信息）"])];
}

// 第一版只做买卖和持仓：不做止盈止损、订单和追踪，也不做蜜罐检测
export function registerSolana(bot: Bot, o: Options, overrides: Partial<SolanaServices> = {}) {
  const { holdings, mintInfo, solBalance, tokenMeta, quote, buySol, sellToken, ...services } = { ...defaultServices, ...overrides };
  const wallet = services.wallet();
  const rpc: SolRpc = services.openRpc(o.rpcUrl);
  const pending = new Map<string, Pending>();
  const metaCache = new Map<string, TokenMeta>();
  let input: Input | null = null;
  let revision = 0;
  const clear = () => { input = null; };
  const invalidate = () => { clear(); pending.clear(); revision++; };
  const selected = () => o.state.activeChain === SOLANA.key;
  const settingsVersion = () => JSON.stringify(o.state.chainSettings(SOLANA.key));
  const reply = (ctx: Context, text: string, kb?: InlineKeyboard) => ctx.reply(text, { ...HTML, reply_markup: kb });
  const homeKb = () => o.mainKeyboard();

  async function symbolOf(mint: string): Promise<{ symbol: string; name: string }> {
    const cached = metaCache.get(mint);
    if (cached) return cached;
    const meta = await tokenMeta(mint);
    if (meta) metaCache.set(mint, meta);
    return meta ?? { symbol: shortMint(mint), name: "未知名称" };
  }

  function createPending(item: DistributiveOmit<Pending>): string {
    const now = Date.now();
    for (const [id, p] of pending) if (p.expires <= now) pending.delete(id);
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
    const id = randomBytes(8).toString("hex");
    pending.set(id, { ...item, expires: now + CONFIRM_MS } as Pending);
    return id;
  }

  async function home(ctx: Context) {
    const addr = wallet.address(); const s = solSettings(o.state);
    await reply(ctx, ["<b>demo bot</b>", `当前链：${o.logos.chain(SOLANA)}`,
      "当前钱包：Solana 主钱包", addr ? `钱包：<code>${addr}</code>` : "钱包：尚未生成，请点钱包管理",
      `买入滑点 ${s.buySlippageBps / 100}% · 卖出滑点 ${s.sellSlippageBps / 100}%`,
      `买前确认：${s.buyConfirmation ? "开启" : "关闭"}`, "", "选择下面的功能，或直接发送代币合约地址。"].join("\n"), homeKb());
  }

  async function balanceSummary(): Promise<string> {
    const addr = wallet.address();
    if (!addr) return `<b>${o.logos.chain(SOLANA)}</b> · 尚未生成钱包`;
    try { return `<b>${o.logos.chain(SOLANA)}</b> · ${fmtUnits(await solBalance(rpc, addr), 9, 6)} ${o.logos.native(SOLANA)}\n钱包：<code>${addr}</code>`; }
    catch { return `<b>${o.logos.chain(SOLANA)}</b> · 查询失败，请稍后重试`; }
  }

  async function walletPage(ctx: Context) {
    const addr = wallet.address();
    const kb = new InlineKeyboard();
    if (!addr) kb.text("生成钱包", "sol:gen").row();
    else kb.text("充值地址", "sol:deposit").text("持仓", "sol:hold").row();
    kb.text("刷新", "sol:wallet").text("返回首页", "nav:start");
    await reply(ctx, ["<b>钱包管理</b>", `当前链：${o.logos.chain(SOLANA)}`, "当前钱包：Solana 主钱包",
      addr ? `地址：<code>${addr}</code>` : "尚未生成钱包，点击下方按钮在本机生成。",
      addr ? await balanceSummary() : "私钥只保存在本地，不会发送到聊天。",
      "Solana 地址与其他链的钱包地址不同，请按当前链充值。"].join("\n"), kb);
  }

  async function settings(ctx: Context) {
    const s = solSettings(o.state); const display = o.state.display; const kb = new InlineKeyboard();
    for (const c of [...o.chains, SOLANA]) o.logos.button(kb, c, `${c.key === "sol" ? "✓ " : ""}${c.label}`, `settings:${c.key}`).row();
    kb.text(`买前确认：${s.buyConfirmation ? "开启" : "关闭"}`, `set:sol:confirm:${s.buyConfirmation ? 0 : 1}`).row()
      .text(`发 CA 快速买入：${s.quickBuy ? "开启" : "关闭"}`, `set:sol:quick:${s.quickBuy ? 0 : 1}`).row()
      .text(`买入滑点 ${s.buySlippageBps / 100}%`, "set:sol:buy-slip").text(`卖出滑点 ${s.sellSlippageBps / 100}%`, "set:sol:sell-slip").row()
      .text("买入按钮金额", "set:sol:buy-presets").text("卖出按钮比例", "set:sol:sell-presets").row()
      .text(`图表入口：${display.showChart ? "显示" : "隐藏"}`, `display:sol:chart:${display.showChart ? 0 : 1}`)
      .text(`浏览器入口：${display.showExplorer ? "显示" : "隐藏"}`, `display:sol:explorer:${display.showExplorer ? 0 : 1}`).row()
      .text(`时区 ${display.timeZone}`, "set:sol:zone").text(`${display.hour12 ? 12 : 24} 小时制`, `display:sol:hour12:${display.hour12 ? 0 : 1}`).row()
      .text("发送与费用", "exec:sol").row().text("链 Logo", "logos:settings").text("恢复本链默认", "set:sol:reset").row().text("返回首页", "nav:start");
    await reply(ctx, ["<b>交易设置</b>", `正在设置：${o.logos.chain(SOLANA)}`,
      `买入按钮：${s.buyAmounts.map((a) => formatUnits(a, 9)).join(" / ")} SOL`,
      `卖出按钮：${s.sellPercentages.join("% / ")}%`, "", "交易参数按链保存；显示和时间设置对所有链生效。",
      "Solana 自动规则需单独确认开启；貔貅和税费检测仍未知。"].join("\n"), kb);
  }

  async function hold(ctx: Context) {
    const addr = wallet.address();
    if (!addr) { await reply(ctx, "还没有 Solana 钱包，请先生成。", homeKb()); return; }
    const list = (await holdings(rpc, addr)).filter((h) => h.amount > 0n);
    if (!list.length) { await reply(ctx, "当前没有 Solana 代币持仓。", homeKb()); return; }
    const shown = list.slice(0, MAX_HOLDINGS_SHOWN);
    const metas = await Promise.all(shown.map((h) => symbolOf(h.mint)));
    const lines = ["<b>Solana 持仓</b>", ""];
    const kb = new InlineKeyboard();
    shown.forEach((h, i) => {
      const symbol = metas[i]?.symbol ?? shortMint(h.mint);
      lines.push(`${i + 1}. ${escapeHtml(symbol)} ${fmtUnits(h.amount, h.decimals, 4)}`);
      kb.text(`查看：${symbol}`, `sol:card:${h.mint}`).row();
    });
    if (list.length > shown.length) lines.push("", `仅显示前 ${shown.length} 个，共 ${list.length} 个。`);
    kb.text("返回首页", "nav:start");
    await reply(ctx, lines.join("\n"), kb);
  }

  async function card(ctx: Context, mint: string) {
    const addr = wallet.address();
    if (!addr) { await walletPage(ctx); return; }
    const requestRevision = revision;
    let info: MintInfo;
    try { info = await mintInfo(rpc, mint); }
    catch (e) { await reply(ctx, escapeHtml(errMsg(e)), homeKb()); return; }
    const [meta, held] = await Promise.all([
      symbolOf(mint),
      holdings(rpc, addr).then((list) => list.find((h) => h.mint === mint)),
    ]);
    if (!selected() || requestRevision !== revision) return;
    const heldText = held && held.amount > 0n ? `${fmtUnits(held.amount, info.decimals, 6)} ${escapeHtml(meta.symbol)}` : "无";
    const lines = [
      "<b>Solana 代币</b>",
      `代币：${escapeHtml(meta.name)}（${escapeHtml(meta.symbol)}）`,
      `地址：<code>${mint}</code>`,
      `精度：${info.decimals}`,
      ...mintLines(info),
      `你的持仓：${heldText}`,
    ];
    const kb = new InlineKeyboard(); const s = solSettings(o.state);
    const version = presetVersion(s.buyAmounts);
    for (const [i, amount] of s.buyAmounts.entries()) kb.text(`买入 ${formatUnits(amount, 9)} SOL`, `sol:b:${mint}:${i}:${version}`);
    kb.row().text("自定义买入", `sol:cb:${mint}`).row();
    if (held && held.amount > 0n) {
      for (const pct of s.sellPercentages) kb.text(`卖出 ${pct}%`, `sol:s:${mint}:${pct}`);
      kb.row().text("自定义卖出", `sol:cs:${mint}`).row();
    }
    kb.text("自动订单", `ord:m:sol:main:${mint}`).text("止盈止损", `sauto:rule:${mint}`).row();
    kb.text("刷新", `sol:card:${mint}`).text("持仓", "sol:hold").row().text("返回首页", "nav:start");
    if (o.state.display.showExplorer) kb.url("区块浏览器", `https://solscan.io/token/${mint}`).row();
    if (o.state.display.showChart) kb.url("搜索图表", `https://dexscreener.com/solana/${mint}`).row();
    await reply(ctx, lines.join("\n"), kb);
  }

  async function askBuy(ctx: Context, mint: string, lamports: bigint) {
    const addr = wallet.address();
    if (!addr) { await walletPage(ctx); return; }
    const requestRevision = revision;
    let info: MintInfo;
    try { info = await mintInfo(rpc, mint); }
    catch (e) { await reply(ctx, escapeHtml(errMsg(e)), homeKb()); return; }
    const meta = await symbolOf(mint);
    const s = solSettings(o.state); const slippageBps = s.buySlippageBps;
    let swapQuote: Quote;
    try { swapQuote = await quote(SOL_MINT, mint, lamports, slippageBps); }
    catch { await reply(ctx, "报价暂时不可用，请稍后重试。", homeKb()); return; }
    if (!selected() || requestRevision !== revision) return;
    const item: DistributiveOmit<Pending> = { kind: "buy", mint, symbol: meta.symbol, decimals: info.decimals, lamports, slippageBps, owner: addr, quote: swapQuote, settingsVersion: settingsVersion(), revision };
    if (!s.buyConfirmation) { await execute(ctx, { ...item, expires: Date.now() + CONFIRM_MS }); return; }
    const id = createPending(item);
    const lines = [
      "<b>确认买入（Solana）</b>",
      "链：Solana",
      `代币：${escapeHtml(meta.name)}（${escapeHtml(meta.symbol)}）`,
      `地址：<code>${mint}</code>`,
      `金额：${fmtUnits(lamports, SOL_DECIMALS, 9)} SOL`,
      `滑点：${slippageBps / 100}%`,
      `预计得到：${fmtUnits(BigInt(swapQuote.outAmount), info.decimals, 6)} ${escapeHtml(meta.symbol)}`,
      ...quoteLines(swapQuote), ...mintLines(info),
      "使用本页报价，超过滑点将失败；发出后不能撤回。60 秒内有效。",
    ];
    await reply(ctx, lines.join("\n"), new InlineKeyboard().text("确认买入", `sol:ok:${id}`).text("取消", `sol:no:${id}`));
  }

  async function askSell(ctx: Context, mint: string, pct: number) {
    const addr = wallet.address();
    if (!addr) { await walletPage(ctx); return; }
    const requestRevision = revision;
    let info: MintInfo;
    try { info = await mintInfo(rpc, mint); }
    catch (e) { await reply(ctx, escapeHtml(errMsg(e)), homeKb()); return; }
    const held = (await holdings(rpc, addr)).find((h) => h.mint === mint);
    if (!held || held.amount <= 0n) { await reply(ctx, "当前钱包没有这个代币的余额。", homeKb()); return; }
    const meta = await symbolOf(mint);
    const amount = held.amount * BigInt(Math.round(pct * 100)) / 10_000n;
    if (amount <= 0n) { await reply(ctx, "卖出数量为 0，请提高比例。", homeKb()); return; }
    const slippageBps = solSettings(o.state).sellSlippageBps;
    let swapQuote: Quote;
    try { swapQuote = await quote(mint, SOL_MINT, amount, slippageBps); }
    catch { await reply(ctx, "报价暂时不可用，请稍后重试。", homeKb()); return; }
    if (!selected() || requestRevision !== revision) return;
    const id = createPending({ kind: "sell", mint, symbol: meta.symbol, decimals: info.decimals, pct, slippageBps, owner: addr, quote: swapQuote, settingsVersion: settingsVersion(), revision });
    const lines = [
      "<b>确认卖出（Solana）</b>",
      "链：Solana",
      `代币：${escapeHtml(meta.name)}（${escapeHtml(meta.symbol)}）`,
      `地址：<code>${mint}</code>`,
      `数量：${pct}% 持仓，约 ${fmtUnits(amount, info.decimals, 6)} ${escapeHtml(meta.symbol)}`,
      `滑点：${slippageBps / 100}%`,
      "",
      `预计得到：${fmtUnits(BigInt(swapQuote.outAmount), 9, 6)} SOL`, ...quoteLines(swapQuote),
      "使用本页报价；余额变化需要重新确认，发出后不能撤回。60 秒内有效。",
    ];
    await reply(ctx, lines.join("\n"), new InlineKeyboard().text("确认卖出", `sol:ok:${id}`).text("取消", `sol:no:${id}`));
  }

  async function execute(ctx: Context, p: Pending) {
    const addr = wallet.address();
    if (!addr) { await reply(ctx, "还没有 Solana 钱包，请先生成。", homeKb()); return; }
    const valid = () => selected() && revision === p.revision && addr === p.owner && settingsVersion() === p.settingsVersion && p.expires > Date.now();
    if (!valid()) { await reply(ctx, "链、设置或确认状态已变化，请重新操作。", homeKb()); return; }
    const signer = await wallet.signer();
    await reply(ctx, p.kind === "buy" ? "正在准备买入并等待链上确认（最长约 2 分钟）…" : "正在准备卖出并等待链上确认（最长约 2 分钟）…");
    try {
      const result = await serial(addr, () => {
        const ensureCurrent = () => { if (!valid()) throw new SolTradeError("确认已过期或链、设置已变化，请重新操作"); };
        ensureCurrent();
        return p.kind === "buy"
          ? buySol(rpc, signer, p.mint, p.lamports, p.slippageBps, p.quote, ensureCurrent, o.journal ? { journal: o.journal, policy: () => o.state.chainSettings("sol").execution ?? {} } : undefined)
          : sellToken(rpc, signer, p.mint, p.pct, p.slippageBps, p.quote, ensureCurrent, o.journal ? { journal: o.journal, policy: () => o.state.chainSettings("sol").execution ?? {} } : undefined);
      });
      const out = BigInt(result.entry?.amountOut ?? result.quote.outAmount);
      const label = result.entry?.amountOut !== undefined ? "实际得到" : "报价预计（实际到账待核对）";
      const got = p.kind === "buy" ? `${label} ${fmtUnits(out, p.decimals, 6)} ${escapeHtml(p.symbol)}` : `${label} ${fmtUnits(out, SOL_DECIMALS, 6)} SOL`;
      await reply(ctx, `✅ ${p.kind === "buy" ? "买入" : "卖出"}成功（Solana）\n${got}\n交易：<a href="${solscan(result.signature)}">查看 Solscan</a>`, homeKb());
    } catch (e) {
      if (e instanceof SolPendingError) {
        await reply(ctx, `⏳ 交易已发出，但等待时间内没有查到确认结果。\n签名：<code>${e.signature}</code>\n<a href="${solscan(e.signature)}">在 Solscan 查看</a>\n机器人不会自动重发，请以 Solscan 结果为准。`, homeKb());
        return;
      }
      const message = e instanceof SolTradeError ? e.message : errMsg(e);
      await reply(ctx, `❌ ${escapeHtml(message)}`, homeKb());
    }
  }

  const solRules = o.journal ? registerSolRules(bot, o.state) : undefined;
  const finance = o.journal ? registerSolFinance(bot, { state: o.state, rpc, wallet, journal: o.journal }) : undefined;

  // 先处理统一导航，再让 EVM 面板处理各自的链。Solana 不进入 viem 路径。
  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data ?? "";
    const text = ctx.message?.text?.trim();
    if (/^c:/.test(data)) invalidate();
    else if (data || text?.startsWith("/")) clear();
    if (data.startsWith("sol:") && !selected() && data !== "sol:home") {
      await ctx.answerCallbackQuery("请先切换到 Solana，旧卡片不会跨链下单"); return;
    }
    if (selected()) {
      const command = /^\/(\w+)(?:@\w+)?(?:\s|$)/.exec(text ?? "")?.[1];
      const route = data === "nav:buy" ? "buy" : data === "sol:wallet" || data.startsWith("wallet:") ? "wallets"
        : data.startsWith("positions:") ? "positions" : command;
      if (["buy", "wallets", "deposit", "positions"].includes(route ?? "")) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery();
        if (route === "buy") await reply(ctx, "当前链：Solana\n直接发送要交易的代币合约地址。", homeKb());
        else if (route === "positions") { if (finance) await finance.positions(ctx); else await hold(ctx); }
        else await walletPage(ctx);
        return;
      }
      if (solRules && (data === "nav:tpsl" || command === "tpsl")) { if (ctx.callbackQuery) await ctx.answerCallbackQuery(); await solRules(ctx); return; }
      if (finance && (data.startsWith("funds:") || command === "funds" || data.startsWith("history:") || command === "history" || data.startsWith("pcard:"))) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery();
        if (data.startsWith("history:") || command === "history") await finance.history(ctx);
        else if (data.startsWith("pcard:")) await finance.positions(ctx, true);
        else await finance.funds(ctx);
        return;
      }
      if (data === "nav:tpsl" || /^(funds:|auth:|history:|trk:|pcard:|exit:|risk:sol)/.test(data)
          || ["tpsl", "funds", "approvals", "history", "track"].includes(command ?? "")) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery();
        await reply(ctx, "Solana 目前支持买卖、余额和持仓，这项功能尚未接入。请切换交易链后使用其他链的功能。", homeKb()); return;
      }
      if (/^(r:|b:|s:|t:|rule:|custom:|confirm:|cancel:|bl:)/.test(data)) {
        await ctx.answerCallbackQuery("这是其他链的旧卡片，请切回对应链后重新操作"); return;
      }
    }
    await next();
  });

  bot.command("sol", async (ctx) => { invalidate(); o.state.setActiveChain("sol"); await o.navigate(ctx); });
  bot.callbackQuery("c:sol", async (ctx) => {
    invalidate(); o.state.setActiveChain("sol"); await ctx.answerCallbackQuery("已切换到 Solana"); await o.navigate(ctx);
  });
  bot.callbackQuery("sol:home", async (ctx) => {
    invalidate(); o.state.setActiveChain("sol"); await ctx.answerCallbackQuery(); await o.navigate(ctx);
  });
  bot.callbackQuery("sol:hold", async (ctx) => { await ctx.answerCallbackQuery(); await hold(ctx); });
  bot.callbackQuery("sol:deposit", async (ctx) => { await ctx.answerCallbackQuery(); await walletPage(ctx); });
  bot.callbackQuery("settings:sol", async (ctx) => { await ctx.answerCallbackQuery(); await settings(ctx); });

  const settingPrompt = async (ctx: Context, kind: "buy-slip" | "sell-slip" | "both-slip" | "buy-presets" | "sell-presets" | "zone") => {
    input = { kind, expires: Date.now() + INPUT_MS };
    const message = kind.endsWith("slip") ? "直接发送滑点百分比，例如 1 或 1%。支持 0.01～99.99。"
      : kind === "buy-presets" ? "发送 1～6 个买入金额，单位 SOL，例如 0.01 0.05 0.1。最多 9 位小数，每档不超过 100 SOL。"
      : kind === "sell-presets" ? "发送 1～6 个卖出比例，例如 25 50 100。支持 0.01～100。"
      : "直接发送时区，例如 Asia/Shanghai、Asia/Tokyo 或 UTC。";
    await reply(ctx, `Solana\n${message}\n发送“取消”退出，5 分钟内有效。`, new InlineKeyboard().text("取消", "input:cancel"));
  };
  bot.callbackQuery(/^set:sol:(buy-slip|sell-slip|buy-presets|sell-presets|zone|confirm|quick|reset)(?::([01]))?$/, async (ctx) => {
    await ctx.answerCallbackQuery(); const kind = ctx.match[1]!; const enabled = ctx.match[2] === "1";
    if (kind === "confirm" || kind === "quick") {
      invalidate();
      if (kind === "quick" && enabled) {
        await reply(ctx, "开启后，发 Solana CA 会自动按第一档金额准备买入；如果买前确认关闭，会直接发送交易。确认开启？", new InlineKeyboard().text("确认开启", "quick:sol:enable").text("取消", "settings:sol")); return;
      }
      o.state.setChainSettings("sol", kind === "confirm" ? { buyConfirmation: enabled } : { quickBuy: false }); await settings(ctx);
    } else if (kind === "reset") {
      await reply(ctx, "恢复 Solana 的滑点、买卖按钮、快速买入和买前确认默认值？", new InlineKeyboard().text("确认恢复", "reset:sol").text("取消", "settings:sol"));
    } else await settingPrompt(ctx, kind as "buy-slip" | "sell-slip" | "buy-presets" | "sell-presets" | "zone");
  });
  bot.callbackQuery("quick:sol:enable", async (ctx) => { invalidate(); o.state.setChainSettings("sol", { quickBuy: true }); await ctx.answerCallbackQuery("已开启"); await settings(ctx); });
  bot.callbackQuery("reset:sol", async (ctx) => {
    invalidate(); o.state.resetChainSettings("sol"); o.state.setSolanaSlippageBps(100); await ctx.answerCallbackQuery("已恢复本链默认设置"); await settings(ctx);
  });
  bot.callbackQuery(/^display:sol:(chart|explorer|hour12):([01])$/, async (ctx) => {
    const value = ctx.match[2] === "1";
    o.state.setDisplay(ctx.match[1] === "chart" ? { showChart: value } : ctx.match[1] === "explorer" ? { showExplorer: value } : { hour12: value });
    await ctx.answerCallbackQuery("已保存"); await settings(ctx);
  });
  bot.callbackQuery("sol:slip", async (ctx) => { await ctx.answerCallbackQuery(); await settingPrompt(ctx, "both-slip"); });
  bot.use(async (ctx, next) => {
    if (selected() && /^\/slippage(?:@\w+)?(?:\s|$)/.test(ctx.message?.text ?? "")) { await settingPrompt(ctx, "both-slip"); return; }
    await next();
  });
  bot.callbackQuery("sol:gen", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (wallet.address()) { await walletPage(ctx); return; }
    await reply(ctx, "将在本机生成 Solana 钱包。私钥只保存在本地，不会发到 Telegram。确认生成？", new InlineKeyboard().text("确认生成", "sol:genok").text("取消", "sol:wallet"));
  });
  bot.callbackQuery("sol:genok", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const addr = wallet.generate();
      await reply(ctx, `已生成 Solana 钱包：<code>${addr}</code>\n私钥只保存在本地 .env（权限 600）。请先备份，再向这个地址转入 SOL。`, homeKb());
    } catch (e) { await reply(ctx, escapeHtml(errMsg(e)), homeKb()); }
  });
  bot.callbackQuery(new RegExp(`^sol:card:(${BASE58_MINT})$`), async (ctx) => {
    await ctx.answerCallbackQuery(); await card(ctx, ctx.match[1]!);
  });
  bot.callbackQuery(new RegExp(`^sol:b:(${BASE58_MINT}):([0-5]):([0-9a-f]{6})$`), async (ctx) => {
    await ctx.answerCallbackQuery(); const s = solSettings(o.state);
    if (ctx.match[3] !== presetVersion(s.buyAmounts)) { await reply(ctx, "买入金额已改，请刷新代币卡片。", homeKb()); return; }
    const amount = s.buyAmounts[Number(ctx.match[2])]; if (amount) await askBuy(ctx, ctx.match[1]!, amount);
  });
  bot.callbackQuery(new RegExp(`^sol:c([bs]):(${BASE58_MINT})$`), async (ctx) => {
    input = { kind: ctx.match[1] === "b" ? "custom" : "sell", mint: ctx.match[2]!, expires: Date.now() + INPUT_MS };
    await ctx.answerCallbackQuery(); await reply(ctx, ctx.match[1] === "b" ? "直接发送要买入的 SOL 数量，例如 0.2。发送“取消”退出。" : "直接发送卖出比例，例如 30 或 30%。发送“取消”退出。");
  });
  bot.callbackQuery(new RegExp(`^sol:s:(${BASE58_MINT}):(\\d{1,3}(?:\\.\\d{1,2})?)$`), async (ctx) => {
    await ctx.answerCallbackQuery(); const pct = parseSellPercentage(ctx.match[2]!); if (pct !== null) await askSell(ctx, ctx.match[1]!, pct);
  });
  bot.callbackQuery(/^sol:ok:([0-9a-f]{16})$/, async (ctx) => {
    const id = ctx.match[1]!; const p = pending.get(id); pending.delete(id);
    if (!p || p.expires <= Date.now()) { await ctx.answerCallbackQuery("确认已超时或失效，请重新操作"); return; }
    await ctx.answerCallbackQuery("已提交");
    void execute(ctx, p).catch(() => console.log("Solana 交易处理失败，请核对链上记录"));
  });
  bot.callbackQuery(/^sol:no:([0-9a-f]{16})$/, async (ctx) => {
    pending.delete(ctx.match[1]!); await ctx.answerCallbackQuery("已取消"); await reply(ctx, "已取消，没有发送任何交易。", homeKb());
  });

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim();
    if (!text || text.startsWith("/")) { await next(); return; }
    if (input && input.expires <= Date.now()) clear();
    if (input && (isSolanaAddress(text) || /^0x[0-9a-f]{40}$/i.test(text))) clear();
    if (input) {
      if (/^(取消|cancel)$/i.test(text)) { clear(); await reply(ctx, "已取消。", homeKb()); return; }
      const current = input;
      if (current.kind === "custom" || current.kind === "sell") {
        if (!selected()) { clear(); await reply(ctx, "交易链已变化，请重新操作。", homeKb()); return; }
        if (current.kind === "custom") {
          const amount = parseSolAmount(text); if (amount === null) { await reply(ctx, "金额不对：最多 100 SOL，最多 9 位小数。请重新输入。"); return; }
          clear(); await askBuy(ctx, current.mint, amount);
        } else {
          const pct = parseSellPercentage(text); if (pct === null) { await reply(ctx, "请输入 0.01～100 的卖出比例。"); return; }
          clear(); await askSell(ctx, current.mint, pct);
        }
        return;
      }
      if (current.kind.endsWith("slip")) {
        const bps = parseSlippageInput(text); if (bps === null) { await reply(ctx, "请输入 0.01～99.99 的滑点百分比。"); return; }
        invalidate(); o.state.setChainSettings("sol", current.kind === "buy-slip" ? { buySlippageBps: bps } : current.kind === "sell-slip" ? { sellSlippageBps: bps } : { buySlippageBps: bps, sellSlippageBps: bps });
      } else if (current.kind === "buy-presets") {
        const amounts = parseSolPresets(text); if (!amounts) { await reply(ctx, "请输入 1～6 个 SOL 金额，最多 9 位小数，每档最多 100 SOL。"); return; }
        invalidate(); o.state.setChainSettings("sol", { buyAmounts: amounts });
      } else if (current.kind === "sell-presets") {
        const values = parseSellPresets(text); if (!values) { await reply(ctx, "请输入 1～6 个 0.01～100 的比例。"); return; }
        invalidate(); o.state.setChainSettings("sol", { sellPercentages: values });
      } else if (current.kind === "zone") {
        try { new Intl.DateTimeFormat("zh-CN", { timeZone: text }).format(); }
        catch { await reply(ctx, "无法识别时区，例如 Asia/Shanghai。"); return; }
        o.state.setDisplay({ timeZone: text });
      }
      clear(); await settings(ctx); return;
    }
    if (isSolanaAddress(text)) {
      if (!selected()) { await reply(ctx, "这是 Solana 地址，请先在「切换交易链」里选择 Solana。", new InlineKeyboard().text("切换到 Solana", "c:sol")); return; }
      const s = solSettings(o.state);
      if (s.quickBuy) await askBuy(ctx, text, s.buyAmounts[0]); else await card(ctx, text);
      return;
    }
    if (selected() && (BASE58_LIKE.test(text) || /^0x[0-9a-f]{40}$/i.test(text))) {
      await reply(ctx, "这个地址不是有效的 Solana 代币地址，请核对当前链和 CA。", homeKb()); return;
    }
    await next();
  });

  return { clear: invalidate, home, settings, balanceSummary, market: { rpc, wallet } };
}
