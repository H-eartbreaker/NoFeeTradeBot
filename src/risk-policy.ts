import type { RiskReport } from "./honeypot.ts";
import type { Route } from "./kyber.ts";

// 每项为 null 表示不启用；启用后拿不到数据的代币一律不买（未知不等于安全）
export type RiskFilter = { maxBuyTaxPct: number | null; maxSellTaxPct: number | null; minLiquidityUsd: number | null; maxImpactPct: number | null };
export const NO_FILTER: RiskFilter = { maxBuyTaxPct: null, maxSellTaxPct: null, minLiquidityUsd: null, maxImpactPct: null };
export const filterActive = (f: RiskFilter) => Object.values(f).some((v) => v !== null);

export type Blacklist = { isBlacklisted(kind: "token" | "developer", chain: string, address: string): boolean };

// 报价估算的总价差（含手续费），由聚合器给出的美元金额计算；缺数据返回 null
export function impactPct(route: Route | null): number | null {
  if (!route) return null;
  const inUsd = Number(route.routeSummary.amountInUsd);
  const outUsd = Number(route.routeSummary.amountOutUsd);
  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd) || inUsd <= 0) return null;
  return (1 - outUsd / inUsd) * 100;
}

export function filterBlocks(f: RiskFilter, report: RiskReport | null, route: Route | null): string[] {
  const out: string[] = [];
  const tax = (label: string, value: number | null | undefined, max: number | null) => {
    if (max === null) return;
    if (value === null || value === undefined || !Number.isFinite(value)) out.push(`${label}未知，无法确认是否低于 ${max}%`);
    else if (value > max) out.push(`${label} ${value.toFixed(2)}% 超过上限 ${max}%`);
  };
  tax("买入税", report?.buyTax, f.maxBuyTaxPct);
  tax("卖出税", report?.sellTax, f.maxSellTaxPct);
  if (f.minLiquidityUsd !== null) {
    const liquidity = report?.liquidityUsd;
    if (liquidity === null || liquidity === undefined || !Number.isFinite(liquidity)) out.push(`流动性未知，无法确认是否达到 $${f.minLiquidityUsd}`);
    else if (liquidity < f.minLiquidityUsd) out.push(`流动性 $${Math.round(liquidity)} 低于下限 $${f.minLiquidityUsd}`);
  }
  if (f.maxImpactPct !== null) {
    const impact = impactPct(route);
    if (impact === null) out.push(`报价价差未知，无法确认是否低于 ${f.maxImpactPct}%`);
    else if (impact > f.maxImpactPct) out.push(`报价价差 ${impact.toFixed(2)}% 超过上限 ${f.maxImpactPct}%`);
  }
  return out;
}

export type BuyCheck = { chain: string; token: string; owner: string | null; report: RiskReport | null; route: Route | null };

// 只用于买入：卖出不经过这里，避免黑名单或过滤阻止退出持仓
export function blacklistReasons(bl: Blacklist, c: Pick<BuyCheck, "chain" | "token" | "owner">): string[] {
  const reasons: string[] = [];
  if (bl.isBlacklisted("token", c.chain, c.token)) reasons.push("代币在黑名单中");
  if (c.owner && !isZeroAddress(c.owner) && bl.isBlacklisted("developer", c.chain, c.owner)) reasons.push("开发者（owner）在黑名单中");
  return reasons;
}

export function buyBlockReasons(bl: Blacklist, filter: RiskFilter, c: BuyCheck): string[] {
  return [...blacklistReasons(bl, c), ...filterBlocks(filter, c.report, c.route)];
}

export const isZeroAddress = (address: string) => /^0x0*$/.test(address);

// 输入 off 或“关闭”表示不启用；数字最多两位小数，不能超过上限
export function parseRiskLimit(text: string, max: number): { value: number | null } | null {
  const t = text.trim().replace(/[%$]/g, "").toLowerCase();
  if (t === "off" || t === "关闭") return { value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const value = Number(t);
  if (value > max) return null;
  return { value };
}
