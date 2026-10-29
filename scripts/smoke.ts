// 只读冒烟测试：不需要私钥和 Telegram，不会发送任何交易。用法: node scripts/smoke.ts [链key] [代币地址]
import type { Address } from "viem";
import { loadConfig } from "../src/config.ts";
import { checkToken } from "../src/honeypot.ts";
import { NATIVE, buildSwap, getRoute } from "../src/kyber.ts";
import { readToken } from "../src/token.ts";
import { createClients } from "../src/wallet.ts";

const chainKey = process.argv[2] ?? "bsc";
const defaults: Record<string, string> = {
  bsc: "0x55d398326f99059ff775485246999027b3197955",
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  eth: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  rh: "0xcec185eb182c47d1ba1efc84e6959e18cd620be4",
};
const token = (process.argv[3] ?? defaults[chainKey]) as Address;
const cfg = loadConfig({
  TELEGRAM_BOT_TOKEN: "x",
  ALLOWED_USER_ID: "1",
  PRIVATE_KEY: "0x" + "1".repeat(64),
  CHAINS: chainKey,
});
const chain = cfg.chains[0];
const clients = createClients("0x" + "1".repeat(64) as `0x${string}`, chain);

console.log("token:", await readToken(clients, token));
console.log("risk:", chain.honeypotChainId ? await checkToken(chain.honeypotChainId, token) : "(该链无貔貅检测)");
const route = await getRoute(chain.kyberSlug!, NATIVE, token, chain.buyAmounts[0]);
console.log("route out:", route.routeSummary.amountOut, "usd:", route.routeSummary.amountOutUsd, "router:", route.routerAddress);
const swap = await buildSwap(chain.kyberSlug!, route, clients.account.address, 1000);
console.log("build:", { to: swap.routerAddress, value: swap.transactionValue, minOut: swap.amountOut, dataBytes: (swap.data.length - 2) / 2 });
