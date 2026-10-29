export type Tier = { at: number; pct: number };
export type RuleState = { cost: bigint; value: bigint; sl: number | null; trail: number | null; tiers: Tier[]; done: number; peak: bigint };
export type Action = { kind: "sl" | "trail" | "tp"; pct: number };
export type Evaluation = { action: Action | null; peak: bigint };

const BPS = 10_000n;
const bps = (pct: number) => BigInt(Math.round(pct * 100));

// 优先级：固定止损 > 移动止损 > 分档止盈；分档按顺序逐档触发，每轮最多一档
export function evaluate(r: RuleState): Evaluation {
  const peak = r.value > r.peak ? r.value : r.peak;
  if (r.cost <= 0n) return { action: null, peak };
  if (r.sl !== null && r.value * BPS <= r.cost * (BPS - bps(r.sl))) return { action: { kind: "sl", pct: 100 }, peak };
  if (r.trail !== null && peak > r.cost && r.value * BPS <= peak * (BPS - bps(r.trail))) return { action: { kind: "trail", pct: 100 }, peak };
  const tier = r.tiers[r.done];
  if (tier && r.value * BPS >= r.cost * (BPS + bps(tier.at))) return { action: { kind: "tp", pct: tier.pct }, peak };
  return { action: null, peak };
}

export function hasRule(r: { sl: number | null; trail: number | null; tiers: Tier[] }): boolean {
  return r.sl !== null || r.trail !== null || r.tiers.length > 0;
}

export type ParsedRule = { tp: number | null; sl: number | null; tiers: Tier[]; trail: number | null };

// "100 30" 表示涨 100% 全部卖、跌 30% 全部卖；"50/50 100/100 sl30 trail20" 表示分档止盈、固定止损和移动止损
export function parseRule(text: string): ParsedRule | "off" | null {
  const t = text.trim().toLowerCase();
  if (t === "off") return "off";
  const parts = t.split(/\s+/);
  const plain = /^\d+(?:\.\d{1,2})?$/;
  if (parts.length === 2 && parts.every((p) => plain.test(p))) {
    const [tp, sl] = parts.map(Number);
    if (tp > 10_000 || sl >= 100 || (tp === 0 && sl === 0)) return null;
    return { tp: tp > 0 ? tp : null, sl: sl > 0 ? sl : null, tiers: tp > 0 ? [{ at: tp, pct: 100 }] : [], trail: null };
  }
  const tiers: Tier[] = []; let sl: number | null = null; let trail: number | null = null;
  for (const part of parts) {
    const tier = /^(\d+(?:\.\d{1,2})?)\/(\d{1,3})$/.exec(part);
    const stop = /^sl(\d+(?:\.\d{1,2})?)$/.exec(part);
    const trailing = /^trail(\d+(?:\.\d{1,2})?)$/.exec(part);
    if (tier) {
      const at = Number(tier[1]); const pct = Number(tier[2]);
      if (at <= 0 || at > 10_000 || pct < 1 || pct > 100) return null;
      tiers.push({ at, pct });
    } else if (stop && sl === null) {
      sl = Number(stop[1]); if (sl <= 0 || sl >= 100) return null;
    } else if (trailing && trail === null) {
      trail = Number(trailing[1]); if (trail <= 0 || trail >= 100) return null;
    } else return null;
  }
  if (!tiers.length && sl === null && trail === null) return null;
  if (tiers.length > 5 || tiers.some((tier, i) => i > 0 && tier.at <= tiers[i - 1].at)) return null;
  if (tiers.some((tier, i) => tier.pct === 100 && i < tiers.length - 1)) return null;
  return { tp: null, sl, tiers, trail };
}
