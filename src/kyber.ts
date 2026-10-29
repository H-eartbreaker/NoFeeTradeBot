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
export type RoutePool = { pool: string; exchange: string; tokenIn: string; tokenOut: string };

export function routePools(route: Route): RoutePool[] {
  const raw = route.routeSummary.route;
  if (!Array.isArray(raw)) return [];
  const pools = new Map<string, RoutePool>();
  for (const path of raw) {
    if (!Array.isArray(path)) continue;
    for (const hop of path) {
      if (!hop || typeof hop.pool !== "string") continue;
      const entry = {
        pool: hop.pool.toLowerCase(),
        exchange: typeof hop.exchange === "string" ? hop.exchange : "未知交易所",
        tokenIn: typeof hop.tokenIn === "string" ? hop.tokenIn.toLowerCase() : "",
        tokenOut: typeof hop.tokenOut === "string" ? hop.tokenOut.toLowerCase() : "",
      };
      pools.set(JSON.stringify(entry), entry);
    }
  }
  return [...pools.values()];
}

export function routeIdentity(route: Route): string {
  return JSON.stringify([route.routerAddress.toLowerCase(), routePools(route).map((p) => JSON.stringify(p)).sort()]);
}

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
