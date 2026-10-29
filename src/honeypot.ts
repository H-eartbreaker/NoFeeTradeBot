import type { Address } from "viem";

export type RiskReport = {
  isHoneypot: boolean;
  buyTax: number | null;
  sellTax: number | null;
  risk: string | null;
  liquidityUsd: number | null;
  holders: number | null;
};

type Raw = {
  honeypotResult?: { isHoneypot?: boolean };
  simulationResult?: { buyTax?: number; sellTax?: number };
  summary?: { risk?: string };
  pair?: { liquidity?: number };
  token?: { totalHolders?: number };
};

// 返回 null 表示检测不可用（接口失败、没有交易对等），调用方应提示用户风险自负
export async function checkToken(chainId: number, token: Address): Promise<RiskReport | null> {
  try {
    const res = await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=${chainId}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Raw;
    if (d.honeypotResult?.isHoneypot === undefined) return null;
    return {
      isHoneypot: d.honeypotResult.isHoneypot,
      buyTax: d.simulationResult?.buyTax ?? null,
      sellTax: d.simulationResult?.sellTax ?? null,
      risk: d.summary?.risk ?? null,
      liquidityUsd: d.pair?.liquidity ?? null,
      holders: d.token?.totalHolders ?? null,
    };
  } catch {
    return null;
  }
}
