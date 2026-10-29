import { erc20Abi, parseUnits } from "viem";
import type { Address } from "viem";
import { NATIVE } from "./kyber.ts";
import type { TradeDeps } from "./trade.ts";

export type Asset = { code: string; address: Address; symbol: string; decimals: number };
const stable: Record<string, Asset[]> = {
  bsc: [{ code: "usdt", address: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", decimals: 18 }],
  base: [{ code: "usdc", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 }],
  eth: [{ code: "usdt", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 }],
  rh: [{ code: "usdg", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG", decimals: 6 }],
};
export function assets(d: TradeDeps): Asset[] {
  return [{ code: "native", address: NATIVE, symbol: d.chain.nativeSymbol, decimals: 18 }, ...(stable[d.chain.key] ?? [])];
}
export function parseAssetAmount(text: string, decimals: number): bigint | null {
  const value = text.trim();
  if (!/^\d+(?:\.\d+)?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) return null;
  try { const amount = parseUnits(value, decimals); return amount > 0n && amount < 2n ** 256n ? amount : null; } catch { return null; }
}
export async function assetBalance(d: TradeDeps, asset: Asset, blockNumber?: bigint): Promise<bigint> {
  if (asset.address === NATIVE) return d.clients.publicClient.getBalance({ address: d.clients.account.address, blockNumber });
  return d.clients.publicClient.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [d.clients.account.address], blockNumber });
}
export async function verifyAsset(d: TradeDeps, asset: Asset): Promise<void> {
  if (asset.address === NATIVE) return;
  const decimals = await d.clients.publicClient.readContract({ address: asset.address, abi: erc20Abi, functionName: "decimals" });
  if (decimals !== asset.decimals) throw new Error("代币精度与配置不符，已暂停操作");
}
