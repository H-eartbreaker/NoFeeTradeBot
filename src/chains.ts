import { parseEther } from "viem";
import { base, bsc, mainnet, robinhood } from "viem/chains";
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
  buyAmounts: bigint[];
  gasReserve: bigint;
};

const amounts = (...s: string[]) => s.map((x) => parseEther(x));

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
    buyAmounts: amounts("0.001", "0.002", "0.003"),
    gasReserve: parseEther("0.0003"),
  },
  base: {
    key: "base",
    label: "Base",
    viemChain: base,
    rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    nativeSymbol: "ETH",
    kyberSlug: "base",
    honeypotChainId: 8453,
    explorerTx: (h) => `https://basescan.org/tx/${h}`,
    buyAmounts: amounts("0.0003", "0.0005", "0.001"),
    gasReserve: parseEther("0.0001"),
  },
  eth: {
    key: "eth",
    label: "Ethereum",
    viemChain: mainnet,
    rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://1rpc.io/eth", "https://eth.drpc.org"],
    nativeSymbol: "ETH",
    kyberSlug: "ethereum",
    honeypotChainId: 1,
    explorerTx: (h) => `https://etherscan.io/tx/${h}`,
    buyAmounts: amounts("0.0005", "0.001", "0.002"),
    gasReserve: parseEther("0.002"),
  },
  rh: {
    key: "rh",
    label: "Robinhood Chain",
    viemChain: robinhood,
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    nativeSymbol: "ETH",
    kyberSlug: "robinhood",
    honeypotChainId: null,
    explorerTx: (h) => `https://robinhoodchain.blockscout.com/tx/${h}`,
    buyAmounts: amounts("0.0003", "0.0005", "0.001"),
    gasReserve: parseEther("0.0001"),
  },
};
