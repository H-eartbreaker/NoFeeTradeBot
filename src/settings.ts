import { createHash } from "node:crypto";
import { formatEther, maxUint256, parseEther } from "viem";
import type { ChainConfig } from "./chains.ts";
import type { State } from "./state.ts";
import { NO_FILTER } from "./risk-policy.ts";

export function tradingSettings(state: State, chain: ChainConfig, defaultSlippageBps: number) {
  const s = state.chainSettings(chain.key);
  const fallback = state.slippageBps ?? defaultSlippageBps;
  return {
    buySlippageBps: s.buySlippageBps ?? fallback,
    sellSlippageBps: s.sellSlippageBps ?? fallback,
    buyAmounts: s.buyAmounts?.map((a) => parseEther(a)) ?? chain.buyAmounts,
    sellPercentages: s.sellPercentages ?? [25, 50, 100],
    buyConfirmation: s.buyConfirmation ?? true,
    quickBuy: s.quickBuy ?? false,
    risk: s.risk ?? NO_FILTER,
  };
}

export function presetVersion(amounts: bigint[]): string {
  return createHash("sha256").update(amounts.join(",")).digest("hex").slice(0, 6);
}

export function parseNativeAmount(text: string): bigint | null {
  const value = text.trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(value)) return null;
  try {
    const amount = parseEther(value);
    return amount > 0n && amount <= maxUint256 ? amount : null;
  } catch {
    return null;
  }
}

export function parseSellPercentage(text: string): number | null {
  const value = text.trim().replace(/[%％]$/, "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const pct = Number(value);
  return Number.isFinite(pct) && pct >= 0.01 && pct <= 100 ? pct : null;
}

export function parseBuyPresets(text: string): string[] | null {
  const parts = text.trim().split(/[,，\s]+/);
  const amounts = parts.map(parseNativeAmount);
  if (parts.length < 1 || parts.length > 6 || amounts.some((a) => a === null)) return null;
  return [...new Set((amounts as bigint[]).map((a) => formatEther(a)))];
}

export function parseSellPresets(text: string): number[] | null {
  const parts = text.trim().split(/[,，\s]+/);
  const values = parts.map(parseSellPercentage);
  if (parts.length < 1 || parts.length > 6 || values.some((a) => a === null)) return null;
  return [...new Set(values as number[])];
}
