// 只读冒烟测试：不需要私钥和 Telegram，不会发送任何交易。用法: node scripts/smoke.ts [代币地址]
import { parseEther } from "viem";
import type { Address } from "viem";
import { CHAINS } from "../src/chains.ts";
import { loadConfig } from "../src/config.ts";
import { checkToken } from "../src/honeypot.ts";
import { NATIVE, buildSwap, getRoute } from "../src/kyber.ts";
import { readToken } from "../src/token.ts";
import { createClients } from "../src/wallet.ts";

const token = (process.argv[2] ?? "0x55d398326f99059ff775485246999027b3197955") as Address;
const cfg = loadConfig({
  TELEGRAM_BOT_TOKEN: "x",
  ALLOWED_USER_ID: "1",
  PRIVATE_KEY: "0x" + "1".repeat(64),
  CHAIN: "bsc",
});
const clients = createClients(cfg);
const chain = CHAINS[cfg.chain.key];

console.log("token:", await readToken(clients, token));
console.log("risk:", await checkToken(chain.honeypotChainId!, token));
const route = await getRoute(chain.kyberSlug!, NATIVE, token, parseEther("0.001"));
console.log("route out:", route.routeSummary.amountOut, "usd:", route.routeSummary.amountOutUsd, "router:", route.routerAddress);
const swap = await buildSwap(chain.kyberSlug!, route, clients.account.address, 1000);
console.log("build:", { to: swap.routerAddress, value: swap.transactionValue, minOut: swap.amountOut, dataBytes: (swap.data.length - 2) / 2 });
