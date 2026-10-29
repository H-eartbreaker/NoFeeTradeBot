import type { Address, Hex } from "viem";

const BASE = "https://aggregator-api.kyberswap.com";
const CLIENT_ID = "bsc-trade-bot";
export const NATIVE: Address = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export type RouteSummary = {
  amountIn: string;
  amountOut: string;
  amountOutUsd: string;
  gas: string;
  [k: string]: unknown;
};
export type Route = { routeSummary: RouteSummary; routerAddress: Address };
export type BuiltSwap = { data: Hex; routerAddress: Address; amountOut: bigint; transactionValue: bigint };

type Envelope<T> = { code: number; message: string; data?: T };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "x-client-id": CLIENT_ID, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as Envelope<T>;
  if (body.code !== 0 || !body.data) throw new Error(`Kyber: ${body.message} (${body.code})`);
  return body.data;
}

export function getRoute(slug: string, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Route> {
  const q = new URLSearchParams({ tokenIn, tokenOut, amountIn: amountIn.toString() });
  return call<Route>(`${BASE}/${slug}/api/v1/routes?${q}`);
}

export async function buildSwap(
  slug: string,
  route: Route,
  sender: Address,
  slippageBps: number,
): Promise<BuiltSwap> {
  const d = await call<{ data: Hex; routerAddress: Address; amountOut: string; transactionValue: string }>(
    `${BASE}/${slug}/api/v1/route/build`,
    {
      method: "POST",
      body: JSON.stringify({
        routeSummary: route.routeSummary,
        sender,
        recipient: sender,
        slippageTolerance: slippageBps,
        deadline: Math.floor(Date.now() / 1000) + 120,
        source: CLIENT_ID,
      }),
    },
  );
  return {
    data: d.data,
    routerAddress: d.routerAddress,
    amountOut: BigInt(d.amountOut),
    transactionValue: BigInt(d.transactionValue),
  };
}
