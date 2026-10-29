import { erc20Abi } from "viem";
import type { Address } from "viem";
import { NATIVE, getRoute } from "./kyber.ts";
import type { Route } from "./kyber.ts";
import type { TradeDeps } from "./trade.ts";

export type MarketOps = { getRoute: typeof getRoute; supply: typeof supplyOf };

// buyAmount 有值：按这笔买入金额测得的单价（含价格影响）；为 null：按 1 个完整代币卖出测得的单价
export async function priceOf(d: TradeDeps, token: Address, decimals: number, buyAmount: bigint | null, ops: Pick<MarketOps, "getRoute">): Promise<bigint> {
  const slug = d.chain.kyberSlug;
  if (!slug) throw new Error(`${d.chain.label} 暂不支持聚合器报价`);
  const one = 10n ** BigInt(decimals);
  const route: Route = buyAmount !== null
    ? await ops.getRoute(slug, NATIVE, token, buyAmount)
    : await ops.getRoute(slug, token, NATIVE, one);
  const out = BigInt(route.routeSummary.amountOut);
  if (out <= 0n) throw new Error("没有可用报价，可能缺少流动性");
  return buyAmount !== null ? (buyAmount * one) / out : out;
}

export function supplyOf(d: TradeDeps, token: Address): Promise<bigint> {
  return d.clients.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" });
}
