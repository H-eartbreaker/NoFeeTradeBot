import { address, createSolanaRpc, isAddress } from "@solana/kit";
import type { Address } from "@solana/kit";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const SOL_DECIMALS = 9;
export const TOKEN_PROGRAMS = {
  spl: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
} as const;

const JUPITER = "https://lite-api.jup.ag";
const QUOTE_MS = 12_000;
const META_MS = 8_000;

export type SolRpc = ReturnType<typeof createSolanaRpc>;
export type Quote = { inAmount: string; outAmount: string; otherAmountThreshold: string; [key: string]: unknown };
export type Holding = { mint: string; amount: bigint; decimals: number };
export type MintInfo = { decimals: number; mintAuthority: string | null; freezeAuthority: string | null };
export type TokenMeta = { symbol: string; name: string };

export function openRpc(url: string): SolRpc {
  return createSolanaRpc(url);
}

export function isSolanaAddress(text: string): boolean {
  return isAddress(text);
}

function parsedOf(data: unknown): { type: string; info: Record<string, unknown> } | null {
  if (!data || typeof data !== "object" || !("parsed" in data)) return null;
  const parsed = (data as { parsed: unknown }).parsed;
  if (!parsed || typeof parsed !== "object") return null;
  const { type, info } = parsed as { type?: unknown; info?: unknown };
  if (typeof type !== "string" || !info || typeof info !== "object") return null;
  return { type, info: info as Record<string, unknown> };
}

export async function solBalance(rpc: SolRpc, owner: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(owner).send();
  return value;
}

export async function holdings(rpc: SolRpc, owner: Address): Promise<Holding[]> {
  const byMint = new Map<string, Holding>();
  for (const programId of Object.values(TOKEN_PROGRAMS)) {
    const { value } = await rpc.getTokenAccountsByOwner(owner, { programId: address(programId) }, { encoding: "jsonParsed" }).send();
    for (const item of value) {
      const parsed = parsedOf(item.account.data);
      if (!parsed || parsed.type !== "account") continue;
      const mint = String(parsed.info.mint ?? "");
      const amount = parsed.info.tokenAmount as { amount?: unknown; decimals?: unknown } | undefined;
      if (!mint || typeof amount?.amount !== "string" || typeof amount.decimals !== "number") continue;
      const raw = BigInt(amount.amount);
      if (raw === 0n) continue;
      const current = byMint.get(mint);
      byMint.set(mint, { mint, decimals: amount.decimals, amount: (current?.amount ?? 0n) + raw });
    }
  }
  return [...byMint.values()];
}

export async function mintInfo(rpc: SolRpc, mint: string): Promise<MintInfo> {
  const { value } = await rpc.getAccountInfo(address(mint), { encoding: "jsonParsed" }).send();
  if (!value) throw new Error("链上找不到这个地址");
  const owner = String(value.owner);
  if (owner !== TOKEN_PROGRAMS.spl && owner !== TOKEN_PROGRAMS.token2022) throw new Error("这不是代币地址（不是 SPL 代币的 Mint）");
  const parsed = parsedOf(value.data);
  if (!parsed || parsed.type !== "mint") throw new Error("这不是代币地址（不是 SPL 代币的 Mint）");
  const { decimals, mintAuthority, freezeAuthority } = parsed.info;
  if (typeof decimals !== "number") throw new Error("代币精度读取失败");
  return {
    decimals,
    mintAuthority: typeof mintAuthority === "string" ? mintAuthority : null,
    freezeAuthority: typeof freezeAuthority === "string" ? freezeAuthority : null,
  };
}

export async function tokenMeta(mint: string): Promise<TokenMeta | null> {
  try {
    const res = await fetch(`${JUPITER}/tokens/v2/search?query=${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(META_MS) });
    if (!res.ok) return null;
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list)) return null;
    const hit = list.find((t): t is { id: string; symbol: string; name: string } => typeof t === "object" && t !== null && (t as { id?: unknown }).id === mint);
    return hit ? { symbol: hit.symbol, name: hit.name } : null;
  } catch {
    return null;
  }
}

export async function quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote> {
  const params = new URLSearchParams({
    inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), restrictIntermediateTokens: "true",
  });
  const res = await fetch(`${JUPITER}/swap/v1/quote?${params}`, { signal: AbortSignal.timeout(QUOTE_MS) });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || typeof body.outAmount !== "string" || typeof body.inAmount !== "string") {
    const reason = body && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(`Jupiter 报价失败：${reason}`);
  }
  return body as Quote;
}

export async function swapTransaction(quoteResponse: Quote, userPublicKey: string): Promise<{ transaction: string; lastValidBlockHeight: bigint }> {
  const res = await fetch(`${JUPITER}/swap/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
    signal: AbortSignal.timeout(QUOTE_MS),
  });
  const body = (await res.json().catch(() => null)) as { swapTransaction?: unknown; lastValidBlockHeight?: unknown; error?: unknown } | null;
  if (!res.ok || typeof body?.swapTransaction !== "string" || typeof body.lastValidBlockHeight !== "number") {
    const reason = body && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(`Jupiter 生成交易失败：${reason}`);
  }
  return { transaction: body.swapTransaction, lastValidBlockHeight: BigInt(body.lastValidBlockHeight) };
}
