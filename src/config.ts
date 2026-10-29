import { parseEther } from "viem";
import type { Hex } from "viem";
import { CHAINS } from "./chains.ts";
import type { ChainConfig } from "./chains.ts";
import { pctToBps } from "./util.ts";

export type Config = {
  botToken: string;
  allowedUserId: number;
  privateKey: Hex;
  chains: ChainConfig[];
  defaultSlippageBps: number;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`缺少环境变量 ${name}，请检查 .env`);
  return v;
}

function resolveChain(env: NodeJS.ProcessEnv, key: string, isFirst: boolean): ChainConfig {
  const base = CHAINS[key];
  if (!base) throw new Error(`不支持的链 ${key}，目前支持: ${Object.keys(CHAINS).join(", ")}`);
  const upper = key.toUpperCase();

  const rpc = (env[`RPC_URL_${upper}`] || (isFirst ? env.RPC_URL : "") || "").trim();
  const rpcUrls = rpc ? [rpc, ...base.rpcUrls] : base.rpcUrls;

  const rawAmounts = env[`BUY_AMOUNTS_${upper}`]?.trim();
  const buyAmounts = rawAmounts ? rawAmounts.split(",").map((s) => parseEther(s.trim())) : base.buyAmounts;
  if (buyAmounts.length === 0 || buyAmounts.some((a) => a <= 0n)) {
    throw new Error(`BUY_AMOUNTS_${upper} 必须是大于 0 的数字，用逗号分隔`);
  }
  return { ...base, rpcUrls, buyAmounts };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const botToken = required(env, "TELEGRAM_BOT_TOKEN");

  const allowedUserId = Number(required(env, "ALLOWED_USER_ID"));
  if (!Number.isInteger(allowedUserId) || allowedUserId <= 0) {
    throw new Error("ALLOWED_USER_ID 必须是正整数的 Telegram 用户 ID");
  }

  const privateKey = required(env, "PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("PRIVATE_KEY 格式不对：需要 0x 开头加 64 位十六进制");
  }

  const keys = [...new Set((env.CHAINS?.trim() || env.CHAIN?.trim() || "bsc").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean))];
  if (keys.length === 0) throw new Error("CHAINS 不能为空");
  const chains = keys.map((k, i) => resolveChain(env, k, i === 0));

  const defaultSlippageBps = pctToBps(Number(env.DEFAULT_SLIPPAGE_PCT?.trim() || "10"));
  if (defaultSlippageBps === null) throw new Error("DEFAULT_SLIPPAGE_PCT 必须在 0 到 20 之间");

  return { botToken, allowedUserId, privateKey: privateKey as Hex, chains, defaultSlippageBps };
}
