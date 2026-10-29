import type { Bot } from "grammy";

// 图标由功能决定；未实现的功能没有映射，也不会凭空加到菜单里。
export function buttonIcon(text: string, data?: string): string | null {
  if (text === "上一页") return "⬅️";
  if (text === "下一页") return "➡️";
  if (/^刷新/.test(text)) return "🔄";
  if (/^返回/.test(text)) return "↩️";
  if (text === "取消") return "✖️";
  if (!data) return text === "区块浏览器" ? "🔎" : text === "搜索图表" ? "📈" : null;
  const navigation: Record<string, string> = { "nav:start": "🏠", "nav:buy": "🛒", "nav:balance": "📊", "nav:chain": "🔗", "nav:settings": "⚙️", "nav:tpsl": "🎯", "nav:help": "📖" };
  if (navigation[data]) return navigation[data];
  if (/^wallet:(page|view):/.test(data)) return "👛";
  if (/^wallet:deposit:/.test(data)) return "📥";
  if (data === "wallet:create") return "➕";
  if (data === "wallet:import") return "📂";
  if (/^wallet:(select|new):/.test(data)) return "✅";
  if (/^history:/.test(data)) return "📜";
  if (/^positions:/.test(data)) return "📊";
  if (/^pcard:/.test(data)) return "🖼️";
  if (data === "auto:pause:1") return "⏸️";
  if (data === "auto:pause:0") return "▶️";
  if (/^exit:p:/.test(data)) return "💵";
  if (/^exit:a:/.test(data)) return "💸";
  if (/^exit:confirm:/.test(data)) return "✅";
  if (data === "exit:cancel") return "✖️";
  if (/^auth:confirm:/.test(data)) return "✅";
  if (data === "auth:cancel") return "✖️";
  if (/^auth:prepare:/.test(data)) return "🔓";
  if (/^auth:/.test(data)) return "🛡️";
  if (/^(b:|funds:transfer)/.test(data)) return data.startsWith("b:") ? "🛒" : "📤";
  if (/^s:/.test(data)) return "💸";
  if (/^custom:/.test(data)) return "✏️";
  if (/^(confirm:|funds:confirm:|logos:save:|reset:|quick:)/.test(data)) return "✅";
  if (/^(cancel:|input:cancel|wallet:cancel|logos:cancel|funds:cancel)/.test(data)) return "✖️";
  if (/^ord:list:/.test(data)) return "📋";
  if (/^ord:m:/.test(data)) return "🤖";
  if (/^ord:k:/.test(data)) return "📝";
  if (/^ord:ok:/.test(data)) return "✅";
  if (/^ord:(no:|cancel$|x:)/.test(data)) return "✖️";
  if (/^ord:t:/.test(data)) return "⏯️";
  if (/^t:/.test(data)) return "🎯";
  if (/^r:/.test(data)) return "🔄";
  if (/^pools:/.test(data)) return "💧";
  if (/^set:[a-z]+:(buy-slip|sell-slip)/.test(data)) return "📐";
  if (/^set:[a-z]+:(buy-presets|sell-presets)/.test(data)) return "🧮";
  if (/^set:[a-z]+:confirm/.test(data)) return "🛡️";
  if (/^set:[a-z]+:quick/.test(data)) return "⚡";
  if (/^set:[a-z]+:zone|^display:[a-z]+:hour12/.test(data)) return "🕒";
  if (/^set:[a-z]+:reset/.test(data)) return "♻️";
  if (/^display:[a-z]+:chart/.test(data)) return "📈";
  if (/^display:[a-z]+:explorer/.test(data)) return "🔎";
  if (/^logos:/.test(data)) return "🖼️";
  if (/^funds:bridge/.test(data)) return "🌉";
  if (/^funds:swap/.test(data)) return "🔄";
  if (data === "funds:menu") return "💰";
  return null;
}

export function decorateButtons<T>(payload: T): T {
  const p = payload as { reply_markup?: { inline_keyboard?: { text: string; callback_data?: string; icon_custom_emoji_id?: string }[][] } } | undefined;
  if (!p?.reply_markup?.inline_keyboard) return payload;
  return { ...payload, reply_markup: { ...p.reply_markup, inline_keyboard: p.reply_markup.inline_keyboard.map((row) => row.map((b) => {
    // 链的自定义 Logo 优先；已有图标的按钮不叠加图标。
    if (b.icon_custom_emoji_id || /^\p{Extended_Pictographic}/u.test(b.text)) return b;
    const icon = buttonIcon(b.text, b.callback_data);
    return icon ? { ...b, text: `${icon} ${b.text}` } : b;
  })) } } as T;
}

export function installButtonIcons(bot: Bot): void {
  bot.api.config.use((previous, method, payload, signal) => previous(method, decorateButtons(payload), signal));
}
