import { formatUnits, parseUnits } from "viem";
import type { State } from "./state.ts";

// 界面共用链描述；不把 Solana 伪装成 EVM 链交给 viem。
export const SOLANA = { key: "sol", label: "Solana", nativeSymbol: "SOL" } as const;
export const SOL_BUY_DEFAULTS = [10_000_000n, 50_000_000n, 100_000_000n];
export const MAX_SOL_BUY = 100_000_000_000n;

export function parseSolAmount(text: string): bigint | null {
  if (!/^\d+(?:\.\d{1,9})?$/.test(text.trim())) return null;
  const value = parseUnits(text.trim(), 9);
  return value > 0n && value <= MAX_SOL_BUY ? value : null;
}

export function solSettings(state: State) {
  const s = state.chainSettings(SOLANA.key);
  return {
    buySlippageBps: s.buySlippageBps ?? state.solanaSlippageBps,
    sellSlippageBps: s.sellSlippageBps ?? state.solanaSlippageBps,
    buyAmounts: s.buyAmounts?.map((a) => parseUnits(a, 9)) ?? SOL_BUY_DEFAULTS,
    sellPercentages: s.sellPercentages ?? [25, 50, 100],
    buyConfirmation: s.buyConfirmation ?? true,
    quickBuy: s.quickBuy ?? false,
  };
}

export function parseSolPresets(text: string): string[] | null {
  const parts = text.trim().split(/[,，\s]+/);
  if (parts.length < 1 || parts.length > 6) return null;
  const amounts = parts.map(parseSolAmount);
  if (amounts.some((a) => a === null)) return null;
  return [...new Set((amounts as bigint[]).map((a) => formatUnits(a, 9)))];
}
