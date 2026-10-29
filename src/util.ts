import { formatUnits } from "viem";
import type { Address } from "viem";

const ADDRESS_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

export function extractAddress(text: string): Address | null {
  const m = ADDRESS_RE.exec(text);
  return m ? (m[0].toLowerCase() as Address) : null;
}

export function fmtUnits(raw: bigint, decimals: number, maxDp = 6): string {
  const s = formatUnits(raw, decimals);
  const [int, frac = ""] = s.split(".");
  const trimmed = frac.slice(0, maxDp).replace(/0+$/, "");
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${intFmt}.${trimmed}` : intFmt;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function pctToBps(pct: number, maxPct = 20): number | null {
  if (!Number.isFinite(pct) || pct <= 0 || pct > maxPct) return null;
  return Math.round(pct * 100);
}

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0].slice(0, 300);
}
