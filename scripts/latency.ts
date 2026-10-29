// BSC 只读测速：不读 .env、不创建签名钱包、不广播交易。
// HTTPS_PROXY=http://127.0.0.1:7897 node scripts/latency.ts [baseline|keep]
import { createPublicClient, erc20Abi, http, parseEther } from "viem";
import { bsc } from "viem/chains";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { enableKeepAlive } from "../src/http.ts";
import { checkToken } from "../src/honeypot.ts";
import { NATIVE, buildSwap, getRoute } from "../src/kyber.ts";

const mode = process.argv[2] ?? "keep";
if (mode !== "baseline" && mode !== "keep") throw new Error("模式只能是 baseline 或 keep");
const rpc = "https://bsc-rpc.publicnode.com";
const urls = ["https://api.telegram.org", "https://aggregator-api.kyberswap.com", "https://api.honeypot.is", rpc];
if (mode === "keep") enableKeepAlive(urls);
else setGlobalDispatcher(new EnvHttpProxyAgent());

const client = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 10_000, retryCount: 0 }) });
// 已在对话中提供的公开钱包地址，仅用于查询和 eth_estimateGas。
const owner = "0xC4f9344C08591Ef402EA6e8b7bc978Cf56A89Bf5" as const;
const token = "0x55d398326f99059ff775485246999027b3197955" as const;
const amount = parseEther("0.001");
const samples: Record<string, number[]> = {};
const failures: Record<string, number> = {};

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await work();
    (samples[label] ??= []).push(Math.round(performance.now() - start));
    return result;
  } catch (error) {
    failures[label] = (failures[label] ?? 0) + 1;
    // 不输出请求正文、交易数据或完整错误对象。
    console.log(JSON.stringify({ stage: label, failed: true, ms: Math.round(performance.now() - start), error: error instanceof Error ? error.name : "Error" }));
    throw error;
  }
}

for (let round = 1; round <= 3; round++) {
  if (round > 1) await new Promise((resolve) => setTimeout(resolve, 8_000));
  const start = performance.now();
  // 与当前买入相同：风控、代币读取、余额、报价/构建同时开始。
  const prepared = await Promise.allSettled([
    timed("risk", async () => {
      const report = await checkToken(56, token);
      if (!report) throw new Error("检测不可用");
      return report;
    }),
    timed("token_read", async () => {
      const code = await client.getCode({ address: token });
      if (!code || code === "0x") throw new Error("无合约");
      const values = await client.multicall({ allowFailure: false, contracts: [
        { address: token, abi: erc20Abi, functionName: "name" },
        { address: token, abi: erc20Abi, functionName: "symbol" },
        { address: token, abi: erc20Abi, functionName: "decimals" },
        { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      ] });
      return values;
    }),
    timed("native_balance", () => client.getBalance({ address: owner })),
    (async () => {
      const route = await timed("buy_quote", () => getRoute("bsc", NATIVE, token, amount));
      const swap = await timed("buy_build", () => buildSwap("bsc", route, owner, 1000));
      return { route, swap };
    })(),
  ]);
  // 等全部检查结束，失败时也不会与下一轮测速重叠。
  if (prepared.every((step) => step.status === "fulfilled") && prepared[3].status === "fulfilled") {
    const prepMs = Math.round(performance.now() - start);
    (samples.buy_checks_and_route ??= []).push(prepMs);
    const { route, swap } = prepared[3].value;
    const prepareStart = performance.now();
    const gasSteps = await Promise.allSettled([
      timed("gas_estimate", () => client.estimateGas({ account: owner, to: swap.routerAddress, data: swap.data, value: swap.transactionValue })),
      timed("gas_price", () => client.getGasPrice()),
      timed("pending_nonce", () => client.getTransactionCount({ address: owner, blockTag: "pending" })),
    ]);
    const ready = gasSteps.every((step) => step.status === "fulfilled");
    const prepareMs = Math.round(performance.now() - prepareStart);
    if (ready) (samples.buy_to_unsigned_ready ??= []).push(prepMs + prepareMs);
    console.log(JSON.stringify({ mode, round, buyChecksMs: prepMs, unsignedReadyMs: ready ? prepMs + prepareMs : null }));
    // 卖出只测报价和构建；不会授权，不会调用 sell()。
    await Promise.allSettled([(async () => {
      const reverse = await timed("sell_quote", () => getRoute("bsc", token, NATIVE, BigInt(route.routeSummary.amountOut)));
      await timed("sell_build", () => buildSwap("bsc", reverse, owner, 1000));
    })()]);
  } else {
    console.log(JSON.stringify({ mode, round, buyChecksFailed: true }));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

await Promise.allSettled([
  timed("telegram_network", async () => {
    const response = await fetch("https://api.telegram.org/bot123:fake/getMe", { signal: AbortSignal.timeout(10_000) });
    await response.text();
    if (response.status !== 401 && response.status !== 404) throw new Error("Unexpected response");
  }),
  (async () => {
    const block = await client.getBlock();
    const previous = await client.getBlock({ blockNumber: block.number - 20n });
    console.log(JSON.stringify({ observedAverageBlockIntervalSeconds: Number(block.timestamp - previous.timestamp) / 20 }));
  })(),
]);

const summary = Object.fromEntries(Object.entries(samples).map(([label, values]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return [label, { count: values.length, minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) }];
}));
console.log(JSON.stringify({ mode, summary, failures }));
// keep-alive 连接与预热定时器只服务本次测速。
process.exit(Object.keys(failures).length ? 1 : 0);
