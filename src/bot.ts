import { randomBytes } from "node:crypto";
import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { formatEther, formatUnits } from "viem";
import type { Address } from "viem";
import type { Wallets } from "./wallets.ts";
import { registerLogos } from "./logos.ts";
import { registerWalletPanel } from "./wallet-panel.ts";
import { installButtonIcons } from "./button-icons.ts";
import { registerFundsPanel } from "./funds-panel.ts";
import { registerPositions } from "./positions-panel.ts";
import { calculatePnl, floatingPnl } from "./pnl.ts";
import { hasRule, parseRule } from "./auto-rules.ts";
import { NO_FILTER, buyBlockReasons, filterActive, parseRiskLimit } from "./risk-policy.ts";
import type { RiskFilter } from "./risk-policy.ts";
import type { RuleKind, Tier } from "./auto-rules.ts";
import { registerApprovals } from "./approvals-panel.ts";
import { registerOrders } from "./orders-panel.ts";
import { registerExecutionPanel } from "./execution-panel.ts";
import { registerTracked } from "./tracked-panel.ts";
import { registerSolana } from "./sol-panel.ts";
import type { SolanaServices } from "./sol-panel.ts";
import { SOLANA } from "./sol-settings.ts";
import { OrderStore } from "./orders.ts";
import type { Config } from "./config.ts";
import { checkToken } from "./honeypot.ts";
import type { RiskReport } from "./honeypot.ts";
import { NATIVE, getRoute, routeIdentity, routePools } from "./kyber.ts";
import type { Route } from "./kyber.ts";
import { nativeFetch } from "./native-fetch.ts";
import { State } from "./state.ts";
import type { Rule } from "./state.ts";
import { parseBuyPresets, parseNativeAmount, parseSellPercentage, parseSellPresets, presetVersion, tradingSettings } from "./settings.ts";
import { readOwner, readToken } from "./token.ts";
import type { TokenInfo } from "./token.ts";
import { buy, sell, ConfirmedTransactionError, PendingTransactionError } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";
import { errMsg, escapeHtml, extractAddress, fmtUnits, parseSlippageInput } from "./util.ts";

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const ADDR = "(0x[0-9a-f]{40})";
const KEY = "([a-z]+)";
const WALLET = "([a-z0-9]{1,4})";
const defaults = { readToken, readOwner, checkToken, getRoute, buy, sell };
type Services = typeof defaults;
type Input = { wallet: string; chain: string; kind: "buy-slip" | "sell-slip" | "both-slip" | "buy-presets" | "sell-presets" | "zone" | "tpsl" | "buy" | "sell" | "risk-buy-tax" | "risk-sell-tax" | "risk-liq" | "risk-impact"; token?: Address; sourceMessageId?: number; expires: number };
type PendingBuy = { wallet: string; chain: string; token: Address; amount: bigint; slippage: number; route: Route; report: RiskReport | null; info: TokenInfo; sourceMessageId?: number; expires: number };

function usd(value: string | undefined): string {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) ? `$${n.toFixed(n < 1 ? 4 : 2)}` : "未知";
}
function ruleText(r: { tp: number | null; sl: number | null; tiers?: Tier[]; trail?: number | null }, paused: RuleKind[] = []): string {
  const tiers = r.tiers ?? (r.tp !== null ? [{ at: r.tp, pct: 100 }] : []);
  const tag = (kind: RuleKind) => (paused.includes(kind) ? "（已暂停）" : "");
  return [
    ...tiers.map((t) => (t.pct === 100 ? `止盈 +${t.at}%` : `止盈 +${t.at}% 卖 ${t.pct}%`) + tag("tp")),
    r.sl !== null ? `止损 -${r.sl}%${tag("sl")}` : null,
    r.trail != null ? `移动止损 -${r.trail}%${tag("trail")}` : null,
  ].filter(Boolean).join(" / ") || "未设置";
}
const isZeroAddress = (address: string) => /^0x0*$/.test(address);
function riskLines(report: RiskReport | null): string[] {
  const tax = (n: number | null | undefined) => n === null || n === undefined || !Number.isFinite(n) ? "未知" : `${n.toFixed(2)}%`;
  if (!report) return ["⚠️ 貔貅：未知（该链不支持检测或检测服务不可用）", "买入税：未知 · 卖出税：未知"];
  const lines = [report.isHoneypot ? "🚨 貔貅：是，已禁止买入" : "貔貅：本次检测未发现，不代表绝对安全", `买入税：${tax(report.buyTax)} · 卖出税：${tax(report.sellTax)}`];
  if (report.liquidityUsd !== null) lines.push(`检测池流动性：$${Math.round(report.liquidityUsd).toLocaleString("en-US")}`);
  if (report.holders !== null) lines.push(`持有人：${report.holders.toLocaleString("en-US")}`);
  return lines;
}
function poolLines(route: Route, limit = 6): string[] {
  const pools = routePools(route);
  if (!pools.length) return ["交易池：未知（报价服务未提供池详情）"];
  const lines = [`报价经过 ${pools.length} 个池：`, ...pools.slice(0, limit).map((p) => `${escapeHtml(p.exchange.slice(0, 60))}\n<code>${escapeHtml(p.pool.slice(0, 160))}</code>`)];
  if (pools.length > limit) lines.push(`另有 ${pools.length - limit} 个池，可点“全部池详情”查看`);
  return lines;
}
function riskIdentity(report: RiskReport | null): string {
  return JSON.stringify(report ? [report.isHoneypot, report.buyTax, report.sellTax] : null);
}

export function createBot(cfg: Config, deps: Map<string, TradeDeps>, state: State, overrides: Partial<Services> = {}, wallets?: Wallets, orders: OrderStore = new OrderStore("data/orders.json"), solanaOverrides: Partial<SolanaServices> = {}): Bot {
  const services = { ...defaults, ...overrides };
  const bot = new Bot(cfg.botToken, { client: { fetch: nativeFetch } });
  installButtonIcons(bot);
  const activeKey = () => state.activeChain && (state.activeChain === SOLANA.key || deps.has(state.activeChain)) ? state.activeChain : cfg.chains[0].key;
  const walletList = () => wallets?.list() ?? [{ id: "main", label: "主钱包", address: deps.get(cfg.chains[0].key)!.clients.account.address }];
  const activeWallet = () => walletList().some((p) => p.id === state.activeWallet) ? state.activeWallet : "main";
  const getDeps = (chain: string, wallet = activeWallet()) => wallets?.get(wallet, chain) ?? (wallet === "main" ? deps.get(chain) : undefined);
  const walletId = (d: TradeDeps) => d.walletId ?? "main";
  const settings = (key: string) => tradingSettings(state, deps.get(key)!.chain, cfg.defaultSlippageBps);
  let input: Input | null = null;
  const pendingBuys = new Map<string, PendingBuy>();
  let clearFunds: (() => void) | undefined;
  let clearPositions: (() => void) | undefined;
  let clearApprovals: (() => void) | undefined;
  let clearOrders: (() => void) | undefined;
  let clearTracked: (() => void) | undefined;
  let clearExecution: (() => void) | undefined;

  // 所有菜单、输入和交易回调都经过同一白名单校验。
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== cfg.allowedUserId || ctx.chat?.type !== "private") return;
    if (ctx.callbackQuery || ctx.message?.text?.startsWith("/")) { input = null; clearExecution?.(); }
    if ((ctx.callbackQuery && !ctx.callbackQuery.data?.startsWith("funds:")) || ctx.message?.text?.startsWith("/")) clearFunds?.();
    if ((ctx.callbackQuery && !/^(exit|positions|pcard):/.test(ctx.callbackQuery.data ?? "")) || ctx.message?.text?.startsWith("/")) clearPositions?.();
    if ((ctx.callbackQuery && !ctx.callbackQuery.data?.startsWith("auth:")) || ctx.message?.text?.startsWith("/")) clearApprovals?.();
    if (/^(c:|sol:home$)/.test(ctx.callbackQuery?.data ?? "") || /^\/sol(?:@\w+)?(?:\s|$)/.test(ctx.message?.text ?? "")) {
      pendingBuys.clear(); clearOrders?.(); clearTracked?.();
    }
    await next();
  });
  const displayChains = [...cfg.chains, SOLANA];
  const logos = registerLogos(bot, state, displayChains);
  clearExecution = registerExecutionPanel(bot, { state, chains: cfg.chains, logos, changed: invalidate });
  const solana = registerSolana(bot, { state, rpcUrl: cfg.solanaRpcUrl, chains: cfg.chains, logos, mainKeyboard: () => mainKeyboard(), navigate: home, journal: deps.values().next().value?.journal }, solanaOverrides);
  clearApprovals = registerApprovals(bot, { state, chains: cfg.chains, logos, activeChain: activeKey, activeWallet, deps: getDeps }, { readToken: services.readToken, getRoute: services.getRoute });
  clearPositions = registerPositions(bot, { state, chains: cfg.chains, logos, activeChain: activeKey, activeWallet, deps: getDeps,
    slippage: (key) => settings(key).sellSlippageBps, refresh: refreshCard }, { readToken: services.readToken, getRoute: services.getRoute, sell: services.sell });
  clearFunds = registerFundsPanel(bot, { chains: cfg.chains, logos, activeChain: activeKey, activeWallet, deps: getDeps, slippage: (key) => settings(key).buySlippageBps });
  clearOrders = registerOrders(bot, { store: orders, state, chains: cfg.chains, logos, deps: getDeps,
    slippage: (key, side) => (side === "buy" ? settings(key).buySlippageBps : settings(key).sellSlippageBps) });
  clearTracked = registerTracked(bot, { state, logos, activeChain: activeKey, deps: getDeps });
  registerWalletPanel(bot, { state, chains: cfg.chains, logos, directory: wallets, list: walletList, activeWallet, activeChain: activeKey,
    deps: getDeps, readToken: services.readToken, onSwitch: () => { input = null; pendingBuys.clear(); } });
  const mainKeyboard = () => new InlineKeyboard().text("买入 / 查看代币", "nav:buy").text("持仓与盈亏", `positions:${activeKey()}:${activeWallet()}:0`).row()
    .text("钱包管理", "wallet:page:0").text("余额", "nav:balance").text("追踪钱包", "trk:list:0").row()
    .text("交易记录", `history:${activeWallet()}:${activeKey()}:0`).text("授权管理", `auth:list:${activeKey()}:${activeWallet()}:0`).row()
    .text("转账 / 兑换 / 跨链", "funds:menu").text("自动订单", "ord:list:0").row()
    .text("切换交易链", "nav:chain").text("设置", "nav:settings").row().text("止盈止损", "nav:tpsl").text("使用说明", "nav:help");
  const backKeyboard = () => new InlineKeyboard().text("返回首页", "nav:start");
  function invalidate(chain: string) {
    for (const [id, pending] of pendingBuys) if (pending.chain === chain) pendingBuys.delete(id);
  }
  function timestamp(): string {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: state.display.timeZone, hour12: state.display.hour12, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
  }
  async function risk(d: TradeDeps, token: Address): Promise<RiskReport | null> {
    return d.chain.honeypotChainId ? services.checkToken(d.chain.honeypotChainId, token) : null;
  }
  async function quote(d: TradeDeps, tokenIn: Address, tokenOut: Address, amount: bigint): Promise<Route | null> {
    try { return await services.getRoute(d.chain.kyberSlug!, tokenIn, tokenOut, amount); } catch { return null; }
  }
  function dep(ctx: Context, key: string | undefined, wallet = activeWallet()): TradeDeps | null {
    const d = key ? getDeps(key, wallet) : undefined;
    if (!d && ctx.callbackQuery) void ctx.answerCallbackQuery("这条链未启用");
    return d ?? null;
  }
  async function panel(ctx: Context, text: string, kb: InlineKeyboard, edit = false) {
    if (edit && ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, { ...HTML, reply_markup: kb }).catch((e) => {
        if (!/not modified/i.test(errMsg(e))) throw e;
      });
    } else await ctx.reply(text, { ...HTML, reply_markup: kb });
  }
  async function home(ctx: Context) {
    if (activeKey() === SOLANA.key) { await solana.home(ctx); return; }
    const d = getDeps(activeKey())!;
    const s = settings(d.chain.key);
    const wallet = walletList().find((w) => w.id === activeWallet())!;
    await panel(ctx, ["<b>demo bot</b>", `当前链：${logos.chain(d.chain)}`, `当前钱包：${escapeHtml(wallet.label)}`, `钱包：<code>${d.clients.account.address}</code>`,
      `买入滑点 ${s.buySlippageBps / 100}% · 卖出滑点 ${s.sellSlippageBps / 100}%`, `买前确认：${s.buyConfirmation ? "开启" : "关闭"}`,
      "", "选择下面的功能，或直接发送代币合约地址。"].join("\n"), mainKeyboard());
  }
  async function help(ctx: Context) {
    await panel(ctx, ["<b>使用说明</b>", "1. 先选交易链，再发送代币 CA。", "2. 在卡片里选金额，或点“自定义买入”后直接发数字。", "3. 买前确认开启时，核对链、CA、名字、池和税费后再确认。", "4. 有持仓后可选卖出比例，也能自定义比例。", "5. 设置里点要修改的项目，直接回复数字；发送“取消”退出。", "", "自动止盈止损需要机器人持续运行；每 3 秒尝试检查一次，上轮未完成时不重复启动。", "菜单和斜杠命令都可以使用。"].join("\n"), backKeyboard());
  }
  async function showChains(ctx: Context) {
    const kb = new InlineKeyboard();
    for (const c of displayChains) logos.button(kb, c, `${c.key === activeKey() ? "✓ " : ""}${c.label}`, `c:${c.key}`).row();
    kb.text("返回首页", "nav:start");
    await panel(ctx, "选择要交易的链：", kb);
  }
  async function balance(ctx: Context) {
    const kb = new InlineKeyboard();
    const sections = await Promise.all(cfg.chains.map(async (c) => {
      const d = getDeps(c.key)!;
      try {
        const native = await d.clients.publicClient.getBalance({ address: d.clients.account.address });
        const lines = [`<b>${logos.chain(c)}</b> · ${fmtUnits(native, 18, 6)} ${logos.native(c)}`];
        const infos = await Promise.all(state.tokens(c.key, walletId(d)).map((t) => services.readToken(d.clients, t as Address)));
        for (const i of infos.filter((v): v is TokenInfo => !!v && v.balance > 0n)) {
          lines.push(`${escapeHtml(i.symbol.slice(0, 40))}：${fmtUnits(i.balance, i.decimals)}`);
          kb.text(`${i.symbol.slice(0, 20)} · ${c.key}`, `r:${c.key}:${walletId(d)}:${i.address}`).row();
        }
        return lines.join("\n");
      } catch { return `<b>${logos.chain(c)}</b> · 查询失败，请稍后重试`; }
    }));
    sections.push(await solana.balanceSummary());
    kb.text("Solana 持仓", "sol:hold").row().text("返回首页", "nav:start");
    const header = activeKey() === SOLANA.key ? "各链余额（Solana 使用独立地址）" : `当前 EVM 钱包：<code>${getDeps(activeKey())!.clients.account.address}</code>`;
    await panel(ctx, `${header}\n\n${sections.join("\n\n")}`, kb);
  }
  async function showSettings(ctx: Context, key = activeKey(), edit = false) {
    if (key === SOLANA.key) { await solana.settings(ctx); return; }
    const d = getDeps(key)!;
    const s = settings(key);
    const display = state.display;
    const kb = new InlineKeyboard();
    for (const c of displayChains) logos.button(kb, c, `${c.key === key ? "✓ " : ""}${c.label}`, `settings:${c.key}`).row();
    kb.text(`买前确认：${s.buyConfirmation ? "开启" : "关闭"}`, `set:${key}:confirm:${s.buyConfirmation ? 0 : 1}`).row()
      .text(`发 CA 快速买入：${s.quickBuy ? "开启" : "关闭"}`, `set:${key}:quick:${s.quickBuy ? 0 : 1}`).row()
      .text(`买入滑点 ${s.buySlippageBps / 100}%`, `set:${key}:buy-slip`).text(`卖出滑点 ${s.sellSlippageBps / 100}%`, `set:${key}:sell-slip`).row()
      .text("买入按钮金额", `set:${key}:buy-presets`).text("卖出按钮比例", `set:${key}:sell-presets`).row()
      .text(`图表入口：${display.showChart ? "显示" : "隐藏"}`, `display:${key}:chart:${display.showChart ? 0 : 1}`)
      .text(`浏览器入口：${display.showExplorer ? "显示" : "隐藏"}`, `display:${key}:explorer:${display.showExplorer ? 0 : 1}`).row()
      .text(`时区 ${display.timeZone}`, `set:${key}:zone`).text(`${display.hour12 ? 12 : 24} 小时制`, `display:${key}:hour12:${display.hour12 ? 0 : 1}`).row()
      .text("链 Logo", "logos:settings").text("风控过滤", `risk:${key}`).row()
      .text("发送与费用", `exec:${key}`).row()
      .text("自动止盈止损", "nav:tpsl").text("恢复本链默认", `set:${key}:reset`).row().text("返回首页", "nav:start");
    await panel(ctx, ["<b>交易设置</b>", `正在设置：${logos.chain(d.chain)}`, `买入按钮：${s.buyAmounts.map((a) => formatEther(a)).join(" / ")} ${d.chain.nativeSymbol}`,
      `卖出按钮：${s.sellPercentages.map((p) => `${p}%`).join(" / ")}`, `快速买入金额：第一档 ${formatEther(s.buyAmounts[0])} ${d.chain.nativeSymbol}`, "", "交易参数按链保存；显示和时间设置对所有链生效。", "修改参数不会重写已有仓位的止盈止损。"].join("\n"), kb, edit);
  }
  async function showRisk(ctx: Context, key: string, edit = false) {
    const d = getDeps(key)!;
    const f = settings(key).risk;
    const show = (n: number | null, unit: string) => (n === null ? "关闭" : `${n}${unit}`);
    const kb = new InlineKeyboard()
      .text(`买入税上限：${show(f.maxBuyTaxPct, "%")}`, `risk:${key}:bt`).row()
      .text(`卖出税上限：${show(f.maxSellTaxPct, "%")}`, `risk:${key}:st`).row()
      .text(`最低流动性：${f.minLiquidityUsd === null ? "关闭" : `$${f.minLiquidityUsd}`}`, `risk:${key}:liq`).row()
      .text(`报价价差上限：${show(f.maxImpactPct, "%")}`, `risk:${key}:imp`).row()
      .text("全部关闭", `risk:${key}:off`).row()
      .text("返回交易设置", `settings:${key}`);
    await panel(ctx, ["<b>风控过滤</b>", `正在设置：${logos.chain(d.chain)}`, "",
      "只影响买入（包括自动订单），卖出任何时候都不受限制。",
      "开启某一项后，拿不到数据（显示为未知）的代币一律拒绝买入，避免在无法核对时误买。",
      "黑名单在代币卡片里设置。"].join("\n"), kb, edit);
  }
  async function prompt(ctx: Context, kind: Input["kind"], chain = activeKey(), token?: Address, sourceMessageId?: number) {
    const d = getDeps(chain)!;
    input = { wallet: activeWallet(), kind, chain, token, sourceMessageId, expires: Date.now() + 5 * 60_000 };
    const messages: Record<Input["kind"], string> = {
      "buy-slip": "直接发送买入滑点百分比，例如 30 或 30%。支持 0.01～99.99。",
      "sell-slip": "直接发送卖出滑点百分比，例如 15。支持 0.01～99.99。",
      "both-slip": "直接发送要设置的百分比，例如 30 或 30%。将同时设置本链买入和卖出滑点，支持 0.01～99.99。",
      "buy-presets": `发送 1～6 个买入金额，用空格或逗号分隔，单位 ${d.chain.nativeSymbol}。例如：${d.chain.buyAmounts.map((a) => formatEther(a)).join(" ")}`,
      "sell-presets": "发送 1～6 个卖出比例，例如 25 50 100。支持 0.01～100。",
      "zone": "直接发送时区，例如 Asia/Shanghai、Asia/Tokyo 或 UTC。",
      "tpsl": `当前默认：${ruleText(state.defaultRule)}\n全局状态：${state.autoPaused ? "已暂停，不会自动卖出（手动卖出不受影响）" : "运行中"}\n直接发送两个数字，例如 100 30，表示赚 100% 或亏 30% 就全部卖出。\n也可以分档：50/50 表示涨 50% 卖出 50%，100/100 表示涨 100% 卖出剩余；sl30 为固定止损 -30%；trail20 为从最高点回撤 20% 全部卖出。\n例如：50/50 100/100 sl30 trail20。发 off 关闭。此默认值适用于所有链的新买入。`,
      "buy": `直接发送买入金额，单位 ${d.chain.nativeSymbol}，例如 ${formatEther(settings(chain).buyAmounts[0])}。`,
      "sell": "直接发送卖出比例，例如 30 或 30%。支持 0.01～100。",
      "risk-buy-tax": "直接发送买入税上限百分比，例如 10。买入税高于此值或拿不到税率的代币将拒绝买入。发 off 关闭此项。",
      "risk-sell-tax": "直接发送卖出税上限百分比，例如 10。卖出税高于此值或拿不到税率的代币将拒绝买入。发 off 关闭此项。",
      "risk-liq": "直接发送最低流动性（美元），例如 5000。检测池流动性低于此值或拿不到数据的代币将拒绝买入。发 off 关闭此项。",
      "risk-impact": "直接发送报价价差上限百分比，例如 5。价差含手续费，高于此值或拿不到价差的代币将拒绝买入。发 off 关闭此项。",
    };
    const kb = new InlineKeyboard();
    if (kind === "tpsl") kb.text(state.autoPaused ? "恢复自动订单" : "全局暂停自动订单", `auto:pause:${state.autoPaused ? 0 : 1}`).row();
    kb.text("取消", "input:cancel");
    await ctx.reply(`${d.chain.label}\n${messages[kind]}\n发送“取消”退出，5 分钟内有效。`, { reply_markup: kb });
  }

  async function card(d: TradeDeps, token: Address, blockNumber?: bigint) {
    const { chain, clients } = d;
    const s = settings(chain.key);
    const info = await services.readToken(clients, token, blockNumber);
    if (!info) return null;
    const [report, buyQuote, sellQuote, native, owner] = await Promise.all([risk(d, token), quote(d, NATIVE, token, s.buyAmounts[0]), info.balance > 0n ? quote(d, token, NATIVE, info.balance) : null,
      clients.publicClient.getBalance({ address: clients.account.address, blockNumber }).catch(() => null), services.readOwner(clients, token, blockNumber)]);
    const tokenBlocked = state.isBlacklisted("token", chain.key, token);
    const ownerBlocked = !!owner && !isZeroAddress(owner) && state.isBlacklisted("developer", chain.key, owner);
    const ownerLine = owner === null ? "未知（合约没有 owner() 或读取失败）" : isZeroAddress(owner) ? "已放弃权限" : `<code>${owner}</code>${ownerBlocked ? "（已拉黑）" : ""}`;
    const lines = [`<b>${escapeHtml(info.symbol.slice(0, 40))}</b> · ${escapeHtml(info.name.slice(0, 100))}`, `链：${logos.chain(chain)}`, `钱包：<code>${clients.account.address}</code>`, `CA：<code>${token}</code>`, "", ...riskLines(report),
      `开发者：${ownerLine}`, `黑名单：代币${tokenBlocked ? "已拉黑" : "未拉黑"}`];
    if (buyQuote) {
      lines.push(`参考报价：${formatEther(s.buyAmounts[0])} ${chain.nativeSymbol} ≈ ${fmtUnits(BigInt(buyQuote.routeSummary.amountOut), info.decimals)} ${escapeHtml(info.symbol.slice(0, 40))}（${usd(buyQuote.routeSummary.amountOutUsd)}）`, ...poolLines(buyQuote));
      const quantity = Number(formatUnits(BigInt(buyQuote.routeSummary.amountOut), info.decimals));
      const price = Number(buyQuote.routeSummary.amountOutUsd) / quantity;
      if (quantity > 0 && Number.isFinite(price) && price > 0) lines.push(`参考单价：$${price.toPrecision(5)}`);
    } else lines.push("⚠️ 暂无报价，可能没有流动性或当前路由不支持该交易池。");
    const pos = info.balance > 0n ? state.position(chain.key, token, walletId(d)) : null;
    if (info.balance > 0n) {
      const value = sellQuote ? BigInt(sellQuote.routeSummary.amountOut) : null;
      lines.push(`持仓：${fmtUnits(info.balance, info.decimals)} ${escapeHtml(info.symbol.slice(0, 40))}${value !== null ? ` ≈ ${fmtUnits(value, 18, 6)} ${chain.nativeSymbol}` : ""}`);
      if (pos && pos.cost > 0n) {
        const book = calculatePnl(d.journal?.entries(walletId(d), chain.key) ?? []).books.get(token.toLowerCase());
        const profit = floatingPnl(book, info.balance, value);
        lines.push(`本地持仓成本：${fmtUnits(pos.cost, 18, 6)} ${chain.nativeSymbol}`, profit === null ? "浮动收益：账本成本链条或余额不完整，暂不可核对" : `浮动收益：${profit > 0n ? "+" : ""}${fmtUnits(profit, 18, 8)} ${chain.nativeSymbol}（报价估算，未扣 Gas）`, `自动止盈止损：${hasRule(pos) ? ruleText(pos, pos.paused) : "未开启"}`);
      }
    }
    lines.push(`钱包余额：${native === null ? "查询失败" : `${fmtUnits(native, 18, 6)} ${chain.nativeSymbol}`}`, `买入滑点 ${s.buySlippageBps / 100}% · 卖出滑点 ${s.sellSlippageBps / 100}%`, `更新：${timestamp()}（${state.display.timeZone}）`);
    const kb = new InlineKeyboard();
    if (buyQuote && !report?.isHoneypot) {
      const version = presetVersion(s.buyAmounts);
      s.buyAmounts.forEach((a, i) => { kb.text(`买 ${formatEther(a)} ${chain.nativeSymbol}`, `b:${chain.key}:${walletId(d)}:${token}:${i}:${version}`); if ((i + 1) % 3 === 0) kb.row(); });
      kb.row().text("自定义买入", `custom:b:${chain.key}:${walletId(d)}:${token}`).row();
    }
    if (info.balance > 0n) {
      s.sellPercentages.forEach((p, i) => { kb.text(`卖 ${p}%`, `s:${chain.key}:${walletId(d)}:${token}:${p}`); if ((i + 1) % 3 === 0) kb.row(); });
      kb.row().text("自定义卖出比例", `custom:s:${chain.key}:${walletId(d)}:${token}`).row();
      kb.text("卖回本金", `exit:p:${chain.key}:${walletId(d)}:${token}`).text("按金额卖出", `exit:a:${chain.key}:${walletId(d)}:${token}`).row();
    }
    if (pos) kb.text(hasRule(pos) ? "关闭止盈止损" : "开启止盈止损", `t:${chain.key}:${walletId(d)}:${token}`).row();
    if (pos && hasRule(pos)) {
      const rules: [RuleKind, string][] = [];
      if (pos.tiers.length) rules.push(["tp", "止盈"]);
      if (pos.sl !== null) rules.push(["sl", "止损"]);
      if (pos.trail !== null) rules.push(["trail", "移动止损"]);
      for (const [kind, label] of rules) kb.text(pos.paused.includes(kind) ? `▶️ 恢复${label}` : `⏸️ 暂停${label}`, `rule:${kind}:${chain.key}:${walletId(d)}:${token}`);
      kb.row();
    }
    kb.text(tokenBlocked ? "移出代币黑名单" : "加入代币黑名单", `bl:t:${chain.key}:${token.toLowerCase()}`);
    if (owner && !isZeroAddress(owner)) kb.text(ownerBlocked ? "移出开发者黑名单" : "拉黑开发者", `bl:d:${chain.key}:${token.toLowerCase()}`);
    kb.row();
    kb.text("自动订单", `ord:m:${chain.key}:${walletId(d)}:${token.toLowerCase()}`).row();
    kb.text("刷新", `r:${chain.key}:${walletId(d)}:${token}`).text("交易设置", `settings:${chain.key}`).row();
    if (state.display.showExplorer) kb.url("区块浏览器", chain.explorerTx(token).replace("/tx/", "/address/"));
    if (state.display.showChart) kb.url("搜索图表", `https://dexscreener.com/search?q=${token}`);
    kb.row().text("返回首页", "nav:start");
    return { text: lines.join("\n"), kb };
  }
  async function showCard(ctx: Context, d: TradeDeps, token: Address, edit = false, blockNumber?: bigint, messageId?: number) {
    const c = await card(d, token, blockNumber);
    if (!c) { await ctx.reply(`这个地址在 ${d.chain.label} 上不是有效的代币合约，请核对链和 CA。`); return; }
    if (messageId && ctx.chat) {
      await ctx.api.editMessageText(ctx.chat.id, messageId, c.text, { ...HTML, reply_markup: c.kb }).catch((e) => { if (!/not modified/i.test(errMsg(e))) throw e; });
    } else await panel(ctx, c.text, c.kb, edit);
  }
  async function refreshCard(ctx: Context, d: TradeDeps, token: Address, blockNumber: bigint, sourceMessageId?: number) {
    try { await showCard(ctx, d, token, !!ctx.callbackQuery, blockNumber, sourceMessageId); } catch { console.log("交易已完成，卡片刷新失败，请手动刷新"); }
  }
  async function progress(ctx: Context, pending: Promise<{ message_id: number } | null>, text: string, html = false) {
    const message = await pending;
    try {
      if (message) await ctx.api.editMessageText(ctx.chat!.id, message.message_id, text, html ? HTML : {});
      else await ctx.reply(text, html ? HTML : {});
    } catch { console.log("交易状态消息发送失败，请核对链上结果"); }
  }
  async function executeBuy(ctx: Context, d: TradeDeps, token: Address, amount: bigint, slip: number, sourceMessageId?: number, confirmation?: PendingBuy) {
    const pending = ctx.reply(`⏳ 买入中 ${formatEther(amount)} ${d.chain.nativeSymbol}…`).catch(() => null);
    let result;
    let info: TokenInfo | null = null;
    try {
      const gate = async () => {
        const [report, metadata] = await Promise.all([risk(d, token), services.readToken(d.clients, token)]);
        info = metadata;
        if (!metadata) throw new Error("不是有效的代币合约");
        if (report?.isHoneypot) throw new Error("检测到貔貅盘，已拒绝买入");
        const filter = settings(d.chain.key).risk;
        const owner = await services.readOwner(d.clients, token);
        const route = filter.maxImpactPct !== null ? await quote(d, NATIVE, token, amount) : null;
        const reasons = buyBlockReasons(state, filter, { chain: d.chain.key, token, owner, report, route });
        if (reasons.length) throw new Error(`已拒绝买入：${reasons.join("；")}`);
        if (confirmation && (riskIdentity(report) !== riskIdentity(confirmation.report) || metadata.name !== confirmation.info.name || metadata.symbol !== confirmation.info.symbol || metadata.decimals !== confirmation.info.decimals)) {
          throw new Error("代币信息、风险或买卖税已变化，请重新点买入并确认");
        }
      };
      result = await services.buy(d, token, amount, slip, gate, confirmation ? {
        route: routeIdentity(confirmation.route),
        minimumOutput: BigInt(confirmation.route.routeSummary.amountOut) * BigInt(10_000 - slip) / 10_000n,
        expiresAt: confirmation.expires,
      } : undefined);
    } catch (e) {
      if (e instanceof ConfirmedTransactionError) state.recordBuy(d.chain.key, token, amount, walletId(d), e.hash);
      await progress(ctx, pending, `${e instanceof ConfirmedTransactionError || e instanceof PendingTransactionError ? "⚠️" : "❌ 买入未完成："}${errMsg(e)}`); return;
    }
    try { state.recordBuy(d.chain.key, token, amount, walletId(d), result.hash); } catch { await progress(ctx, pending, `买入已成交，但本地记录失败，请勿重复买入。交易：${result.hash}`); return; }
    await progress(ctx, pending, `✅ 买入成功 ${formatEther(amount)} ${d.chain.nativeSymbol} → ${fmtUnits(result.received, info!.decimals)} ${escapeHtml(info!.symbol.slice(0, 40))}\n<a href="${d.chain.explorerTx(result.hash)}">查看交易</a>`, true);
    await refreshCard(ctx, d, token, result.blockNumber, sourceMessageId);
  }
  async function requestBuy(ctx: Context, d: TradeDeps, token: Address, amount: bigint, sourceMessageId?: number) {
    const s = settings(d.chain.key);
    if (!s.buyConfirmation) { await executeBuy(ctx, d, token, amount, s.buySlippageBps, sourceMessageId); return; }
    try {
      const [info, report, route, owner] = await Promise.all([services.readToken(d.clients, token), risk(d, token), quote(d, NATIVE, token, amount), services.readOwner(d.clients, token)]);
      if (!info) { await ctx.reply("代币信息读取失败，请核对 CA 后重试"); return; }
      if (report?.isHoneypot) { await ctx.reply("🚨 检测到貔貅盘，已拒绝买入"); return; }
      if (!route) { await ctx.reply("无法取得本次买入报价，未提交交易，请稍后重试"); return; }
      const reasons = buyBlockReasons(state, s.risk, { chain: d.chain.key, token, owner, report, route });
      if (reasons.length) { await ctx.reply(`已拒绝买入：\n${reasons.map((r) => `• ${r}`).join("\n")}`); return; }
      if (BigInt(route.routeSummary.amountIn) !== amount || BigInt(route.routeSummary.amountOut) <= 0n) throw new Error("报价金额不正确");
      for (const [id, p] of pendingBuys) if (p.expires <= Date.now() || (p.chain === d.chain.key && p.token === token && p.sourceMessageId === sourceMessageId)) pendingBuys.delete(id);
      if (pendingBuys.size >= 100) pendingBuys.delete(pendingBuys.keys().next().value!);
      const id = randomBytes(8).toString("hex");
      pendingBuys.set(id, { wallet: walletId(d), chain: d.chain.key, token, amount, slippage: s.buySlippageBps, route, report: report ? { ...report } : null, info: { ...info }, sourceMessageId, expires: Date.now() + 60_000 });
      const kb = new InlineKeyboard().text("确认买入", `confirm:${id}`).text("取消", `cancel:${id}`);
      if (routePools(route).length > 6) kb.row().text("全部池详情", `pools:${id}`);
      const text = ["<b>买入前请核对</b>", `链：${logos.chain(d.chain)}`, `钱包：<code>${d.clients.account.address}</code>`, `名字：${escapeHtml(info.name.slice(0, 100))}（${escapeHtml(info.symbol.slice(0, 40))}）`, `CA：<code>${token}</code>`,
        `买入：${formatEther(amount)} ${d.chain.nativeSymbol}`, `预计收到：${fmtUnits(BigInt(route.routeSummary.amountOut), info.decimals)} ${escapeHtml(info.symbol.slice(0, 40))}`, `本次滑点：${s.buySlippageBps / 100}%`,
        `按本次报价最低接受：${fmtUnits(BigInt(route.routeSummary.amountOut) * BigInt(10_000 - s.buySlippageBps) / 10_000n, info.decimals)} ${escapeHtml(info.symbol.slice(0, 40))}`,
        "", ...riskLines(report), ...(filterActive(s.risk) ? ["风控过滤：已启用项目全部通过"] : []), "", ...poolLines(route), "", "报价会变化，确认时会再次核对风险和交易池。", "60 秒内有效；此时尚未发送交易。"].join("\n");
      try { await panel(ctx, text, kb); } catch (e) { pendingBuys.delete(id); throw e; }
    } catch { await ctx.reply("确认信息读取失败，未提交交易，请稍后重试"); }
  }
  async function executeSell(ctx: Context, d: TradeDeps, token: Address, pct: number, sourceMessageId?: number) {
    const pending = ctx.reply(`⏳ 卖出 ${pct}% 中…`).catch(() => null);
    let result;
    let info;
    try {
      info = await services.readToken(d.clients, token);
      if (!info) throw new Error("代币信息读取失败");
      result = await services.sell(d, token, pct, settings(d.chain.key).sellSlippageBps);
    } catch (e) {
      if (e instanceof ConfirmedTransactionError) state.recordSell(d.chain.key, token, pct, walletId(d), e.hash);
      await progress(ctx, pending, `${e instanceof ConfirmedTransactionError || e instanceof PendingTransactionError ? "⚠️" : "❌ 卖出未完成："}${errMsg(e)}`); return;
    }
    try { state.recordSell(d.chain.key, token, pct, walletId(d), result.hash, result.balanceBefore ? { sold: result.soldAmount, balance: result.balanceBefore } : undefined); } catch { await progress(ctx, pending, `卖出已成交，但本地记录失败。交易：${result.hash}`); return; }
    await progress(ctx, pending, `✅ 卖出成功 ${fmtUnits(result.soldAmount, info.decimals)} ${escapeHtml(info.symbol.slice(0, 40))} → 约 ${fmtUnits(result.receivedNative, 18, 6)} ${d.chain.nativeSymbol}${result.approveHash ? "（含一次授权）" : ""}\n<a href="${d.chain.explorerTx(result.hash)}">查看交易</a>`, true);
    await refreshCard(ctx, d, token, result.blockNumber, sourceMessageId);
  }
  async function applyRule(ctx: Context, text: string): Promise<boolean> {
    const rule = parseRule(text);
    if (rule === null) return false;
    if (rule === "off") {
      state.setDefaultRule({ tp: null, sl: null, tiers: [], trail: null });
      await ctx.reply("已关闭新买入的默认止盈止损，已有仓位规则保持不变"); return true;
    }
    state.setDefaultRule(rule);
    await ctx.reply(`新买入默认：${ruleText(state.defaultRule)}\n每 3 秒尝试检查，触发后按规则卖出；已有仓位请在代币卡片里单独开启。`);
    return true;
  }
  async function consumeInput(ctx: Context, text: string) {
    const current = input;
    if (!current) return;
    if (current.expires <= Date.now()) { input = null; await ctx.reply("输入已超时，请重新点选要设置的项目"); return; }
    if (/^(取消|cancel)$/i.test(text.trim())) { input = null; await ctx.reply("已取消，设置保持不变", { reply_markup: backKeyboard() }); return; }
    const d = getDeps(current.chain, current.wallet)!;
    const retry = async (message: string) => { await ctx.reply(`${message}\n请重新输入，或发送“取消”。`); };
    if (current.kind.endsWith("slip")) {
      const bps = parseSlippageInput(text);
      if (bps === null) { await retry("请输入 0.01～99.99 的百分比，最多两位小数"); return; }
      state.setChainSettings(current.chain, current.kind === "buy-slip" ? { buySlippageBps: bps } : current.kind === "sell-slip" ? { sellSlippageBps: bps } : { buySlippageBps: bps, sellSlippageBps: bps });
      invalidate(current.chain);
      await ctx.reply(`${d.chain.label} ${current.kind === "both-slip" ? "买卖滑点" : current.kind === "buy-slip" ? "买入滑点" : "卖出滑点"}已设为 ${bps / 100}%`);
    } else if (current.kind === "buy-presets") {
      const amounts = parseBuyPresets(text);
      if (!amounts) { await retry("请输入 1～6 个大于 0 的金额，最多 18 位小数"); return; }
      state.setChainSettings(current.chain, { buyAmounts: amounts }); invalidate(current.chain);
      await ctx.reply(`${d.chain.label} 买入按钮已保存：${amounts.join(" / ")} ${d.chain.nativeSymbol}`);
    } else if (current.kind === "sell-presets") {
      const values = parseSellPresets(text);
      if (!values) { await retry("请输入 1～6 个 0.01～100 的卖出比例"); return; }
      state.setChainSettings(current.chain, { sellPercentages: values });
      await ctx.reply(`${d.chain.label} 卖出按钮已保存：${values.join("% / ")}%`);
    } else if (current.kind === "zone") {
      try { new Intl.DateTimeFormat("zh-CN", { timeZone: text.trim() }).format(); } catch { await retry("无法识别这个时区，例如 Asia/Shanghai 或 UTC"); return; }
      state.setDisplay({ timeZone: text.trim() }); await ctx.reply(`时区已设为 ${text.trim()}`);
    } else if (current.kind === "tpsl") {
      if (!await applyRule(ctx, text)) { await retry("请输入两个数字，例如 100 30（止盈 0～10000，止损 0～99.99，不能同时为 0），或发 off 关闭"); return; }
    } else if (current.kind.startsWith("risk-")) {
      const fields: Record<string, keyof RiskFilter> = { "risk-buy-tax": "maxBuyTaxPct", "risk-sell-tax": "maxSellTaxPct", "risk-liq": "minLiquidityUsd", "risk-impact": "maxImpactPct" };
      const field = fields[current.kind];
      const isLiquidity = current.kind === "risk-liq";
      const parsed = parseRiskLimit(text, isLiquidity ? 1_000_000_000 : 100);
      if (!parsed) { await retry(isLiquidity ? "请输入美元金额，例如 5000，或发 off 关闭" : "请输入 0～100 的百分比，最多两位小数，或发 off 关闭"); return; }
      state.setChainSettings(current.chain, { risk: { ...settings(current.chain).risk, [field]: parsed.value } });
      await ctx.reply(`${d.chain.label} ${isLiquidity ? "最低流动性" : current.kind === "risk-buy-tax" ? "买入税上限" : current.kind === "risk-sell-tax" ? "卖出税上限" : "报价价差上限"}已设为 ${parsed.value === null ? "关闭" : isLiquidity ? `$${parsed.value}` : `${parsed.value}%`}`);
    } else if (current.kind === "buy") {
      const amount = parseNativeAmount(text);
      if (amount === null) { await retry("请输入大于 0 的买入金额，最多 18 位小数"); return; }
      input = null; await requestBuy(ctx, d, current.token!, amount, current.sourceMessageId); return;
    } else if (current.kind === "sell") {
      const pct = parseSellPercentage(text);
      if (pct === null) { await retry("请输入 0.01～100 的卖出百分比"); return; }
      input = null; await executeSell(ctx, d, current.token!, pct, current.sourceMessageId); return;
    }
    input = null;
  }

  bot.command("start", home);
  bot.command("help", help);
  bot.command("chain", showChains);
  bot.command(["balance", "manage"], balance);
  bot.command("settings", (ctx) => showSettings(ctx));
  bot.command("slippage", async (ctx) => {
    await prompt(ctx, "both-slip");
    if (ctx.match.trim()) await consumeInput(ctx, ctx.match.trim());
  });
  bot.command("tpsl", async (ctx) => {
    await prompt(ctx, "tpsl");
    if (ctx.match.trim()) await consumeInput(ctx, ctx.match.trim());
  });
  bot.command("cancel", async (ctx) => { input = null; await ctx.reply("已取消当前输入", { reply_markup: backKeyboard() }); });
  bot.callbackQuery(/^nav:(start|buy|balance|chain|settings|tpsl|help)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const name = ctx.match[1];
    if (name === "start") await home(ctx);
    else if (name === "buy") await ctx.reply(`当前链：${deps.get(activeKey())!.chain.label}\n直接发送要交易的代币合约地址。`, { reply_markup: backKeyboard() });
    else if (name === "balance") await balance(ctx);
    else if (name === "chain") await showChains(ctx);
    else if (name === "settings") await showSettings(ctx);
    else if (name === "tpsl") await prompt(ctx, "tpsl");
    else await help(ctx);
  });
  bot.callbackQuery(new RegExp(`^c:${KEY}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]); if (!d) return;
    pendingBuys.clear(); state.setActiveChain(d.chain.key); await ctx.answerCallbackQuery(`已切换到 ${d.chain.label}`); await home(ctx);
  });
  bot.callbackQuery(new RegExp(`^settings:${KEY}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]); if (!d) return;
    await ctx.answerCallbackQuery(); await showSettings(ctx, d.chain.key);
  });
  bot.callbackQuery(new RegExp(`^set:${KEY}:(buy-slip|sell-slip|buy-presets|sell-presets|zone|reset|confirm|quick)(?::([01]))?$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]); if (!d) return;
    const kind = ctx.match[2]; await ctx.answerCallbackQuery();
    if (kind === "confirm") {
      if (ctx.match[3] === undefined) return;
      state.setChainSettings(d.chain.key, { buyConfirmation: ctx.match[3] === "1" }); invalidate(d.chain.key);
      await showSettings(ctx, d.chain.key, true);
    } else if (kind === "quick") {
      if (ctx.match[3] === "0") { state.setChainSettings(d.chain.key, { quickBuy: false }); invalidate(d.chain.key); await showSettings(ctx, d.chain.key, true); }
      else if (ctx.match[3] === "1") await panel(ctx, `开启 ${d.chain.label} 快速买入？\n之后发送包含 CA 的消息，将使用第一档 ${formatEther(settings(d.chain.key).buyAmounts[0])} ${d.chain.nativeSymbol} 准备买入。\n买前确认开启时仍需确认；若关闭买前确认，就会直接提交交易。`, new InlineKeyboard().text("确认开启", `quick:${d.chain.key}:enable`).text("取消", `settings:${d.chain.key}`));
    } else if (kind === "reset") {
      await panel(ctx, `恢复 ${d.chain.label} 的买卖滑点、按钮、快速买入和买前确认默认值？\n已有仓位、止盈止损、风控过滤和黑名单不变。`, new InlineKeyboard().text("确认恢复", `reset:${d.chain.key}`).text("取消", `settings:${d.chain.key}`));
    } else await prompt(ctx, kind as Input["kind"], d.chain.key);
  });
  bot.callbackQuery(new RegExp(`^reset:${KEY}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]); if (!d) return;
    state.resetChainSettings(d.chain.key); invalidate(d.chain.key); await ctx.answerCallbackQuery("已恢复本链默认设置"); await showSettings(ctx, d.chain.key, true);
  });
  bot.callbackQuery(new RegExp(`^quick:${KEY}:enable$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]); if (!d) return;
    state.setChainSettings(d.chain.key, { quickBuy: true }); invalidate(d.chain.key);
    await ctx.answerCallbackQuery("已开启快速买入"); await showSettings(ctx, d.chain.key, true);
  });
  bot.callbackQuery(new RegExp(`^display:${KEY}:(chart|explorer|hour12):([01])$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]); if (!d) return;
    const value = ctx.match[3] === "1";
    state.setDisplay(ctx.match[2] === "chart" ? { showChart: value } : ctx.match[2] === "explorer" ? { showExplorer: value } : { hour12: value });
    await ctx.answerCallbackQuery("已保存显示设置"); await showSettings(ctx, d.chain.key, true);
  });
  bot.callbackQuery(/^auto:pause:([01])$/, async (ctx) => {
    state.setAutoPaused(ctx.match[1] === "1");
    await ctx.answerCallbackQuery(state.autoPaused ? "已全局暂停" : "已恢复");
    await ctx.reply(state.autoPaused ? "自动止盈止损已全局暂停：不会再自动卖出，手动卖出不受影响。" : "自动止盈止损已恢复运行。", { reply_markup: backKeyboard() });
  });
  bot.callbackQuery("input:cancel", async (ctx) => { input = null; await ctx.answerCallbackQuery("已取消"); await ctx.editMessageText("已取消，设置保持不变", { reply_markup: backKeyboard() }); });
  bot.on("message:text", async (ctx) => {
    if (input) {
      // CA 不是金额或滑点；退出当前输入后按当前链展示代币。
      const fullAddress = /^0x[0-9a-f]{40}$/i.test(ctx.message.text.trim()) ? extractAddress(ctx.message.text) : null;
      if (!fullAddress) { await consumeInput(ctx, ctx.message.text); return; }
      input = null;
    }
    const token = extractAddress(ctx.message.text);
    if (token) {
      const d = getDeps(activeKey());
      if (!d) { await ctx.reply("请核对当前链和代币地址。"); return; }
      if (settings(d.chain.key).quickBuy) await requestBuy(ctx, d, token, settings(d.chain.key).buyAmounts[0]);
      else await showCard(ctx, d, token);
    }
  });
  bot.callbackQuery(new RegExp(`^r:${KEY}:${WALLET}:${ADDR}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1], ctx.match[2]); if (!d) return;
    await ctx.answerCallbackQuery(); await showCard(ctx, d, ctx.match[3] as Address, true);
  });
  bot.callbackQuery(new RegExp(`^t:${KEY}:${WALLET}:${ADDR}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1], ctx.match[2]); if (!d) return;
    const token = ctx.match[3] as Address;
    const pos = state.position(d.chain.key, token, walletId(d));
    if (!pos) { await ctx.answerCallbackQuery("没有这个仓位的买入记录"); return; }
    if (hasRule(pos)) { state.setRule(d.chain.key, token, { tp: null, sl: null }, walletId(d)); await ctx.answerCallbackQuery("已关闭止盈止损"); }
    else if (!hasRule({ sl: state.defaultRule.sl, trail: state.defaultRule.trail ?? null, tiers: state.defaultRule.tiers ?? (state.defaultRule.tp !== null ? [{ at: state.defaultRule.tp, pct: 100 }] : []) })) { await ctx.answerCallbackQuery("先在首页设置默认止盈止损"); return; }
    else { state.setRule(d.chain.key, token, state.defaultRule, walletId(d)); await ctx.answerCallbackQuery("已开启止盈止损"); }
    await showCard(ctx, d, token, true);
  });
  bot.callbackQuery(new RegExp(`^rule:(sl|trail|tp):${KEY}:${WALLET}:${ADDR}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[2], ctx.match[3]); if (!d) return;
    const kind = ctx.match[1] as RuleKind;
    const token = ctx.match[4] as Address;
    const pos = state.position(d.chain.key, token, walletId(d));
    if (!pos) { await ctx.answerCallbackQuery("没有这个仓位的买入记录"); return; }
    const exists = kind === "sl" ? pos.sl !== null : kind === "trail" ? pos.trail !== null : pos.tiers.length > 0;
    if (!exists) { await ctx.answerCallbackQuery("这条规则未设置"); return; }
    const paused = !pos.paused.includes(kind);
    const label = kind === "sl" ? "止损" : kind === "trail" ? "移动止损" : "止盈";
    state.setRulePaused(d.chain.key, token, walletId(d), kind, paused);
    await ctx.answerCallbackQuery(paused ? `已暂停${label}` : `已恢复${label}`);
    await showCard(ctx, d, token, true);
  });
  bot.callbackQuery(new RegExp(`^risk:${KEY}(?::(off|bt|st|liq|imp))?$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1]); if (!d) return;
    const action = ctx.match[2];
    if (!action) { await ctx.answerCallbackQuery(); await showRisk(ctx, d.chain.key, true); return; }
    if (action === "off") {
      state.setChainSettings(d.chain.key, { risk: NO_FILTER });
      await ctx.answerCallbackQuery("已关闭全部风控过滤"); await showRisk(ctx, d.chain.key, true); return;
    }
    const kind = { bt: "risk-buy-tax", st: "risk-sell-tax", liq: "risk-liq", imp: "risk-impact" } as const;
    await ctx.answerCallbackQuery();
    await prompt(ctx, kind[action as keyof typeof kind], d.chain.key);
  });
  bot.callbackQuery(new RegExp(`^bl:(t|d):${KEY}:${ADDR}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[2]); if (!d) return;
    const token = ctx.match[3] as Address;
    if (ctx.match[1] === "t") {
      const on = !state.isBlacklisted("token", d.chain.key, token);
      state.setBlacklisted("token", d.chain.key, token, on);
      await ctx.answerCallbackQuery(on ? "已加入代币黑名单，之后不再买入" : "已移出代币黑名单");
    } else {
      const owner = await services.readOwner(d.clients, token);
      if (!owner || isZeroAddress(owner)) { await ctx.answerCallbackQuery("这个代币没有可拉黑的 owner"); return; }
      const on = !state.isBlacklisted("developer", d.chain.key, owner);
      state.setBlacklisted("developer", d.chain.key, owner, on);
      await ctx.answerCallbackQuery(on ? "已拉黑开发者，之后不再买入其代币" : "已移出开发者黑名单");
    }
    await showCard(ctx, d, token, true);
  });
  bot.callbackQuery(new RegExp(`^custom:([bs]):${KEY}:${WALLET}:${ADDR}$`), async (ctx) => {
    const d = dep(ctx, ctx.match[2], ctx.match[3]); if (!d) return;
    await ctx.answerCallbackQuery(); await prompt(ctx, ctx.match[1] === "b" ? "buy" : "sell", d.chain.key, ctx.match[4] as Address, ctx.callbackQuery.message?.message_id);
    if (input) input.wallet = walletId(d);
  });
  bot.callbackQuery(new RegExp(`^b:${KEY}:${WALLET}:${ADDR}:(\\d+):([0-9a-f]{6})$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1], ctx.match[2]); if (!d) return;
    const amounts = settings(d.chain.key).buyAmounts;
    const amount = amounts[Number(ctx.match[4])];
    if (amount === undefined || ctx.match[5] !== presetVersion(amounts)) { await ctx.answerCallbackQuery("买入档位已改变，请刷新卡片"); return; }
    await ctx.answerCallbackQuery("正在准备买入信息…"); await requestBuy(ctx, d, ctx.match[3] as Address, amount, ctx.callbackQuery.message?.message_id);
  });
  bot.callbackQuery(/^confirm:([0-9a-f]{16})$/, async (ctx) => {
    const id = ctx.match[1]; const p = pendingBuys.get(id);
    // 任何 await 之前取走确认，阻止并发双击发送两次交易。
    pendingBuys.delete(id);
    if (!p || p.expires <= Date.now()) { await ctx.answerCallbackQuery("确认已过期或已处理，请重新点买入"); return; }
    const d = dep(ctx, p.chain, p.wallet); if (!d) return;
    if (settings(p.chain).buySlippageBps !== p.slippage) { await ctx.answerCallbackQuery("滑点已改变，请重新确认"); return; }
    await ctx.answerCallbackQuery("已确认，正在提交买入…");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    await executeBuy(ctx, d, p.token, p.amount, p.slippage, p.sourceMessageId, p);
  });
  bot.callbackQuery(/^cancel:([0-9a-f]{16})$/, async (ctx) => {
    const id = ctx.match[1];
    if (!pendingBuys.delete(id)) { await ctx.answerCallbackQuery("确认已失效或已处理"); return; }
    await ctx.answerCallbackQuery("已取消，未提交交易"); await ctx.editMessageText("已取消买入，未提交交易", { reply_markup: backKeyboard() });
  });
  bot.callbackQuery(/^pools:([0-9a-f]{16})$/, async (ctx) => {
    const p = pendingBuys.get(ctx.match[1]);
    if (!p || p.expires <= Date.now()) { await ctx.answerCallbackQuery("确认已失效，请重新点买入"); return; }
    await ctx.answerCallbackQuery();
    const pools = routePools(p.route);
    for (let i = 0; i < pools.length; i += 10) await ctx.reply(poolLines({ ...p.route, routeSummary: { ...p.route.routeSummary, route: [pools.slice(i, i + 10)] } }, 10).join("\n"), HTML);
  });
  bot.callbackQuery(new RegExp(`^s:${KEY}:${WALLET}:${ADDR}:(\\d+(?:\\.\\d{1,2})?)$`), async (ctx) => {
    const d = dep(ctx, ctx.match[1], ctx.match[2]); if (!d) return;
    const pct = parseSellPercentage(ctx.match[4]);
    if (pct === null) { await ctx.answerCallbackQuery("无效的卖出比例"); return; }
    await ctx.answerCallbackQuery("卖出提交中…"); await executeSell(ctx, d, ctx.match[3] as Address, pct, ctx.callbackQuery.message?.message_id);
  });
  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery("按钮已过期，请刷新卡片或返回首页"));
  bot.catch((err) => console.error("机器人处理失败：", errMsg(err.error)));
  return bot;
}
