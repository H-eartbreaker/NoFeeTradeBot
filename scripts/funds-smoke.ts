// 真实只读：不读取 .env、不创建钱包客户端、不发送 Telegram 或链上交易。
import assert from "node:assert/strict";
import { createPublicClient, http, parseEther } from "viem";
import { assets, verifyAsset } from "../src/assets.ts";
import { bridgeQuote } from "../src/bridge.ts";
import { CHAINS } from "../src/chains.ts";
import { enableKeepAlive } from "../src/http.ts";
import { buildSwap, getRoute, NATIVE } from "../src/kyber.ts";
import type { TradeDeps } from "../src/trade.ts";

enableKeepAlive([]);
const owner = "0x1111111111111111111111111111111111111111";
for (const key of process.argv.slice(2).length ? process.argv.slice(2) : ["bsc", "base", "eth", "rh"]) {
  const chain = CHAINS[key]; assert.ok(chain, `不支持 ${key}`);
  const client = createPublicClient({ chain: chain.viemChain, transport: http(chain.rpcUrls[0], { timeout: 15000, retryCount: 0 }) });
  const d = { chain, clients: { account: { address: owner }, publicClient: client } } as unknown as TradeDeps;
  const result: Record<string, unknown> = { chain: key, noSigningClient: true };
  try {
    assert.equal(await client.getChainId(), chain.viemChain.id);
    const [native, stable] = assets(d); await verifyAsset(d, stable);
    const amount = key === "bsc" ? parseEther("0.005") : parseEther("0.003");
    for (const [input, output, quantity] of [[native, stable, amount], [stable, native, 10n ** BigInt(stable.decimals)]] as const) {
      const route = await getRoute(chain.kyberSlug!, input.address, output.address, quantity);
      const built = await buildSwap(chain.kyberSlug!, route, owner, 100);
      assert.equal(built.routerAddress.toLowerCase(), route.routerAddress.toLowerCase());
      assert.equal(built.transactionValue, input.address === NATIVE ? quantity : 0n);
      assert.ok(built.amountOut > 0n);
    }
    result.stableMetadata = stable.symbol; result.swapBothDirections = "quote/build passed";
  } catch { result.swapBothDirections = "read-only check failed"; process.exitCode = 1; }
  try {
    const destination = key === "base" ? CHAINS.bsc : CHAINS.base;
    const q = await bridgeQuote(d, destination, key === "bsc" ? parseEther("0.005") : parseEther("0.003"));
    assert.equal(q.recipient, owner); assert.ok(q.minimumOut > 0n && q.minimumOut <= q.amountOut);
    result.bridgeDestination = destination.key; result.bridgeQuote = "validated";
  } catch { result.bridgeQuote = "route unavailable or validation failed"; }
  console.log(JSON.stringify(result));
}
