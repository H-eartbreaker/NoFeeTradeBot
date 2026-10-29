import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";

export function createClients(cfg: Config) {
  const transport = fallback(cfg.chain.rpcUrls.map((u) => http(u, { timeout: 10_000 })));
  const account = privateKeyToAccount(cfg.privateKey);
  const publicClient = createPublicClient({ chain: cfg.chain.viemChain, transport });
  const walletClient = createWalletClient({ account, chain: cfg.chain.viemChain, transport });
  return { account, publicClient, walletClient };
}

export type Clients = ReturnType<typeof createClients>;
