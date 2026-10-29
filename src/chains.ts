import { bsc } from "viem/chains";
import type { Chain } from "viem";

export type ChainConfig = {
  key: string;
  label: string;
  viemChain: Chain;
  rpcUrls: string[];
  nativeSymbol: string;
  kyberSlug: string | null;
  honeypotChainId: number | null;
  explorerTx: (hash: string) => string;
};

export const CHAINS: Record<string, ChainConfig> = {
  bsc: {
    key: "bsc",
    label: "BNB Chain",
    viemChain: bsc,
    rpcUrls: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"],
    nativeSymbol: "BNB",
    kyberSlug: "bsc",
    honeypotChainId: 56,
    explorerTx: (h) => `https://bscscan.com/tx/${h}`,
  },
};
