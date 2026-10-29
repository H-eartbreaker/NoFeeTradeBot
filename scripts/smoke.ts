// 只读冒烟测试：不需要私钥和 Telegram，不会发送任何交易。用法: node scripts/smoke.ts [链key] [代币地址]
import { formatEther, isAddress } from "viem";
import type { Address } from "viem";
import { loadConfig } from "../src/config.ts";
import { checkToken } from "../src/honeypot.ts";
import { NATIVE, buildSwap, getRoute } from "../src/kyber.ts";
import { readToken } from "../src/token.ts";
import { createClients } from "../src/wallet.ts";
import { enableKeepAlive } from "../src/http.ts";

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
if (!isAddress(token)) throw new Error("代币地址无效");
enableKeepAlive(["https://aggregator-api.kyberswap.com", "https://api.honeypot.is", chain.rpcUrls[0]]);

async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const value = await fn();
  console.log(`${chain.key} ${name}: ${Math.round(performance.now() - start)} ms`);
  return value;
}

// 显式核对节点网络，防止把其他链的节点误当成当前链。
const chainId = await stage("chainId", () => clients.publicClient.getChainId());
if (chainId !== chain.viemChain.id) throw new Error(`节点网络错误，预期 ${chain.viemChain.id}，实际 ${chainId}`);
const info = await stage("token", () => readToken(clients, token));
if (!info) throw new Error("测试代币读取失败");
console.log("token:", { symbol: info.symbol, decimals: info.decimals, chainId });

// 可指定公开地址查余额；不读取 .env，也不需要该钱包的私钥。
const wallet = process.env.SMOKE_WALLET as Address | undefined;
if (wallet) {
  if (!isAddress(wallet)) throw new Error("SMOKE_WALLET 地址无效");
  const native = await stage("nativeBalance", () => clients.publicClient.getBalance({ address: wallet }));
  console.log("native balance:", formatEther(native), chain.nativeSymbol);
}
const risk = chain.honeypotChainId ? await stage("risk", () => checkToken(chain.honeypotChainId!, token)) : null;
console.log("risk:", risk ?? "检测不可用，不代表安全");

let sellAmount = 0n;
for (const side of ["buy", "sell"] as const) {
  const tokenIn = side === "buy" ? NATIVE : token;
  const tokenOut = side === "buy" ? token : NATIVE;
  // 卖出采用真实买入报价对应的代币数量，不需要实际持仓。
  const amountIn = side === "buy" ? chain.buyAmounts[0] : sellAmount;
  const route = await stage(`${side}Quote`, () => getRoute(chain.kyberSlug!, tokenIn, tokenOut, amountIn));
  const swap = await stage(`${side}Build`, () => buildSwap(chain.kyberSlug!, route, wallet ?? clients.account.address, 1000));
  if (swap.routerAddress.toLowerCase() !== route.routerAddress.toLowerCase()) throw new Error("报价和构建的路由地址不一致");
  if (swap.transactionValue !== (side === "buy" ? amountIn : 0n)) throw new Error("交易原生币金额不正确");
  if (swap.amountOut <= 0n || !/^0x[0-9a-f]+$/i.test(swap.data) || swap.data.length < 10) throw new Error("交易数据无效");
  console.log(`${side}:`, { out: swap.amountOut.toString(), dataBytes: (swap.data.length - 2) / 2 });
  if (side === "buy") sellAmount = BigInt(route.routeSummary.amountOut);
}
console.log(`${chain.key}: PASS（只读，未签名、未授权、未广播交易）`);
