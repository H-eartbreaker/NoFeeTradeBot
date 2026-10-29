import { address } from "@solana/kit";
import { holdings, mintInfo, quote, solBalance, SOL_MINT, tokenMeta } from "./sol-chain.ts";
import type { SolRpc } from "./sol-chain.ts";
import type { SolanaWallet } from "./sol-wallet.ts";
export type SolMarket = { rpc: SolRpc; wallet: Pick<SolanaWallet, "address"> };
export const SOL_ORDER_SCALE = 1_000_000_000n;
export async function solOrderMarket(sol: SolMarket, mint: string, buyAmount: bigint | null) {
  const owner = sol.wallet.address(); if (!owner) throw new Error("请先生成 Solana 钱包");
  const [info, meta, list, native] = await Promise.all([mintInfo(sol.rpc, mint), tokenMeta(mint), holdings(sol.rpc, owner), solBalance(sol.rpc, owner)]);
  const balance = list.find((h) => h.mint === mint)?.amount ?? 0n;
  return {
    info: { ...info, symbol: meta?.symbol ?? mint.slice(0, 6), name: meta?.name ?? "未知名称", balance },
    owner, native: native * SOL_ORDER_SCALE, reserve: 10_000_000n * SOL_ORDER_SCALE, symbol: "SOL",
    price: async () => {
      if (buyAmount !== null) {
        const lamports = buyAmount / SOL_ORDER_SCALE;
        if (lamports <= 0n || buyAmount % SOL_ORDER_SCALE !== 0n) throw new Error("买入金额最多 9 位小数");
        const q = await quote(SOL_MINT, mint, lamports, 100);
        const out = BigInt(q.outAmount); if (out <= 0n) throw new Error("报价数量为零");
        return (buyAmount * 10n ** BigInt(info.decimals) + out - 1n) / out;
      }
      const amount = balance > 0n ? balance : 10n ** BigInt(info.decimals);
      const q = await quote(mint, SOL_MINT, amount, 100);
      return BigInt(q.outAmount) * SOL_ORDER_SCALE * 10n ** BigInt(info.decimals) / amount;
    },
    supply: async () => BigInt((await sol.rpc.getTokenSupply(address(mint)).send()).value.amount),
  };
}
