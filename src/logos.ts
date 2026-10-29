import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import type { MessageEntity } from "grammy/types";
import type { ChainConfig } from "./chains.ts";
import type { ChainLogo, State } from "./state.ts";
import { escapeHtml } from "./util.ts";

const ID = /^[1-9]\d{0,19}$/;
// 图标目录独立于交易链配置：可以先收藏图标，以后接链时按 key 复用。
export const LOGO_CHAINS = [
  { key: "base", label: "Base", aliases: ["Base"] },
  { key: "eth", label: "Ethereum", aliases: ["Ethereum", "ETH"] },
  { key: "bsc", label: "BNB Chain", aliases: ["BNB Chain", "Binance", "BSC"] },
  { key: "abstract", label: "Abstract", aliases: ["Abstract"] },
  { key: "avalanche", label: "Avalanche", aliases: ["Avalanche"] },
  { key: "hyperevm", label: "HyperEVM", aliases: ["HyperEVM"] },
  { key: "arbitrum", label: "Arbitrum", aliases: ["Arbitrum"] },
  { key: "ink", label: "Ink", aliases: ["Ink"] },
  { key: "story", label: "Story", aliases: ["Story"] },
  { key: "xlayer", label: "X Layer", aliases: ["X Layer", "XLayer"] },
  { key: "plasma", label: "Plasma", aliases: ["Plasma"] },
  { key: "unichain", label: "UniChain", aliases: ["UniChain"] },
  { key: "monad", label: "Monad", aliases: ["Monad"] },
  { key: "megaeth", label: "MegaETH", aliases: ["MegaETH"] },
  { key: "tempo", label: "Tempo", aliases: ["Tempo"] },
  { key: "rh", label: "Robinhood Chain", aliases: ["Robinhood Chain", "Robinhood", "罗宾汉链", "罗宾汉"] },
  { key: "arc", label: "Arc", aliases: ["Arc"] },
  { key: "stable", label: "Stable", aliases: ["Stable"] },
  { key: "solana", label: "Solana", aliases: ["Solana"] },
] as const;
const aliasKeys = new Map<string, string>(LOGO_CHAINS.flatMap((c) => c.aliases.map((name) => [name.toLowerCase(), c.key] as [string, string])));
const names = [...aliasKeys.keys()].sort((a, b) => b.length - a.length);
const aliases = new RegExp(names.map((name) => /^[\x00-\x7F]+$/.test(name) ? `\\b${name}\\b` : name).join("|"), "gi");
const HTML = { parse_mode: "HTML" } as const;

// Telegram 的 offset/length 按 UTF-16 计数，与 JS 字符串下标一致，不能改用字符数组。
export function extractLogos(text: string, entities: readonly MessageEntity[], allowedChains: readonly string[] = LOGO_CHAINS.map((c) => c.key)): Record<string, ChainLogo> {
  const result: Record<string, ChainLogo> = {};
  let offset = 0;
  for (const line of text.split("\n")) {
    const names = [...line.matchAll(aliases)].filter((m) => /^\s*[:：]/.test(line.slice(m.index! + m[0].length)));
    if (names.length === 1) {
      const name = names[0]; const key = aliasKeys.get(name[0].toLowerCase())!;
      const start = offset + name.index!; const end = start + name[0].length;
      const all = entities.filter((e): e is MessageEntity.CustomEmojiMessageEntity => e.type === "custom_emoji" && e.offset >= offset && e.offset + e.length <= offset + line.length && e.length > 0 && ID.test(e.custom_emoji_id));
      const before = all.filter((e) => e.offset + e.length <= start);
      const after = all.filter((e) => e.offset >= end && !/[$＄]/.test(text.slice(end, e.offset)));
      if (allowedChains.includes(key) && before.length <= 1 && after.length <= 1) {
        const pair = { ...(before[0] ? { chain: before[0].custom_emoji_id } : {}), ...(after[0] ? { native: after[0].custom_emoji_id } : {}) };
        if (pair.chain || pair.native) {
          if (result[key] && JSON.stringify(result[key]) !== JSON.stringify(pair)) throw new Error("同一条链识别到不同图标，请只转发一份余额列表");
          result[key] = pair;
        }
      }
    }
    offset += line.length + 1;
  }
  return result;
}

export function stripCustomEmoji<T>(payload: T): T {
  if (!payload || typeof payload !== "object") return payload;
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/<tg-emoji emoji-id="\d+">([^<]*)<\/tg-emoji>/g, "$1");
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "icon_custom_emoji_id").map(([key, v]) => [key, clean(v)]));
    return value;
  };
  return clean(payload) as T;
}

export class Logos {
  private state: State;
  private unavailable = false;
  constructor(state: State) { this.state = state; }
  private emoji(id: string | undefined, fallback: string): string {
    return this.state.logos.enabled && !this.unavailable && id && ID.test(id) ? `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>` : "";
  }
  chain(chain: Pick<ChainConfig, "key" | "label">): string {
    const icon = this.emoji(this.state.logos.chains[chain.key]?.chain, "🔗");
    return `${icon ? `${icon} ` : ""}${escapeHtml(chain.label)}`;
  }
  native(chain: ChainConfig): string {
    const icon = this.emoji(this.state.logos.chains[chain.key]?.native, "🪙");
    return `${icon ? `${icon} ` : ""}${chain.nativeSymbol}`;
  }
  savedNative(key: string): string {
    const id = this.state.logos.chains[key]?.native;
    return this.emoji(id, "🪙") || (id ? "已保存" : "未设置");
  }
  button(kb: InlineKeyboard, chain: ChainConfig, text: string, data: string): InlineKeyboard {
    const id = this.state.logos.chains[chain.key]?.chain;
    return kb.text({ text, ...(this.state.logos.enabled && !this.unavailable && id && ID.test(id) ? { icon_custom_emoji_id: id } : {}) }, data);
  }
  installFallback(bot: Bot): void {
    bot.api.config.use(async (previous, method, payload, signal) => {
      if (!["sendMessage", "editMessageText", "editMessageReplyMarkup"].includes(method)) return previous(method, payload, signal);
      const cleaned = stripCustomEmoji(payload);
      const decorated = JSON.stringify(cleaned) !== JSON.stringify(payload);
      const response = await previous(method, this.unavailable ? cleaned : payload, signal);
      // 只有 Telegram 明确拒绝自定义表情才重发纯文字；网络超时绝不重发，避免重复消息。
      if (!this.unavailable && decorated && !response.ok && response.error_code === 400 && /(?:custom[_\s-]?emoji|emoji[_\s-]?(?:id|invalid|not allowed))/i.test(response.description)) {
        this.unavailable = true;
        return previous(method, cleaned, signal);
      }
      return response;
    });
  }
  retry(): void { this.unavailable = false; }
}

export function registerLogos(bot: Bot, state: State, chains: ChainConfig[]): Logos {
  const logos = new Logos(state); logos.installFallback(bot);
  let input: { expires: number } | null = null;
  let pending: { id: string; expires: number; chains: Record<string, ChainLogo> } | null = null;
  const keyboard = () => new InlineKeyboard().text(state.logos.enabled ? "关闭 Logo" : "开启 Logo", "logos:toggle").row()
    .text("识别转发消息中的 Logo", "logos:import").row().text("返回交易设置", "nav:settings");
  const show = (ctx: Context) => {
    const reserved = LOGO_CHAINS.filter((c) => !chains.some((active) => active.key === c.key) && state.logos.chains[c.key]);
    return ctx.reply(["<b>链 Logo</b>", ...chains.map((c) => `${logos.chain(c)} · ${logos.native(c)}${state.logos.chains[c.key]?.chain ? "" : "（未设置链图标）"}`),
      ...(reserved.length ? ["", `<b>已收藏备用：${reserved.length} 条链</b>`, ...reserved.map((c) => `${logos.chain(c)} · 币种图标：${logos.savedNative(c.key)}`)] : []),
      "", "支持收藏图中 19 条链的 Logo，包括暂未启用交易的链；保存后重启仍保留，以后接入可直接复用。", "先点识别，再转发带有链名和图标的原余额消息；截图无法提取图标编号。", "收藏不会开启交易链，也不会触发买卖。"].join("\n"), { ...HTML, reply_markup: keyboard() });
  };
  bot.command("logos", async (ctx) => { input = null; pending = null; await show(ctx); });
  bot.callbackQuery(/^logos:(settings|toggle|import|save|cancel)(?::([0-9a-f]{16}))?$/, async (ctx) => {
    input = null;
    const action = ctx.match[1];
    if (action === "save") {
      const p = pending; pending = null;
      if (!p || p.id !== ctx.match[2] || p.expires <= Date.now()) { await ctx.answerCallbackQuery("识别结果已过期，请重新导入"); return; }
      const chains = state.logos.chains;
      for (const [key, pair] of Object.entries(p.chains)) chains[key] = { ...chains[key], ...pair };
      state.setLogos({ chains }); logos.retry();
      await ctx.answerCallbackQuery("Logo 已保存"); await show(ctx); return;
    }
    pending = null;
    await ctx.answerCallbackQuery();
    if (action === "toggle") { state.setLogos({ enabled: !state.logos.enabled }); logos.retry(); }
    if (action === "import") {
      input = { expires: Date.now() + 5 * 60_000 };
      await ctx.reply("把带有链名与 Logo 的原余额消息转发到这里，图中 19 条链都能收藏，不限当前启用的交易链。\n请转发原消息，不要发截图。5 分钟内有效。", { reply_markup: new InlineKeyboard().text("取消", "logos:cancel") });
    } else await show(ctx);
  });
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery || ctx.message?.text?.startsWith("/")) { input = null; pending = null; }
    if (!input || !ctx.message) { await next(); return; }
    if (input.expires <= Date.now()) { input = null; await ctx.reply("Logo 识别已超时，请重新点识别"); return; }
    if (/^(取消|cancel)$/i.test(ctx.message.text?.trim() ?? "")) { input = null; await ctx.reply("已取消 Logo 识别"); return; }
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    let found: Record<string, ChainLogo>;
    try { found = extractLogos(text, ctx.message.entities ?? ctx.message.caption_entities ?? []); }
    catch { await ctx.reply("识别结果有冲突，请只转发一份余额列表，或发送“取消”退出。"); return; }
    if (!Object.keys(found).length) { await ctx.reply("没找到可识别的自定义 Logo。请转发原余额消息，需保留链名和表情；截图无法识别。发送“取消”退出。"); return; }
    input = null;
    const id = randomBytes(8).toString("hex"); pending = { id, expires: Date.now() + 60_000, chains: found };
    const icon = (value: string | undefined) => value ? `<tg-emoji emoji-id="${value}">🔗</tg-emoji>` : "未识别";
    await ctx.reply(["<b>确认这些 Logo 对应正确</b>", ...LOGO_CHAINS.filter((c) => found[c.key]).map((c) => {
      const active = chains.find((a) => a.key === c.key);
      return `${c.label}：${icon(found[c.key].chain)} · ${active?.nativeSymbol ?? "币种图标"}：${icon(found[c.key].native)}${active ? "" : "（收藏备用）"}`;
    }), "", "只保存图标编号，不保存转发消息中的余额、钱包地址或其他内容。", "60 秒内有效。"].join("\n"), { ...HTML, reply_markup: new InlineKeyboard().text("确认保存", `logos:save:${id}`).text("取消", "logos:cancel") });
  });
  return logos;
}
