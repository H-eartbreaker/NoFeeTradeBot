import { createPublicClient, createWalletClient, fallback, http } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainConfig } from "./chains.ts";

export function createClients(privateKey: Hex, chain: ChainConfig) {
  const transport = fallback(chain.rpcUrls.map((u) => http(u, { timeout: 10_000 })));
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: chain.viemChain, transport, pollingInterval: 300 });
  const walletClient = createWalletClient({ account, chain: chain.viemChain, transport });
  return { account, publicClient, walletClient };
}

export type Clients = ReturnType<typeof createClients>;
