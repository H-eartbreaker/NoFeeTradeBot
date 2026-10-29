import { createBot } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { enableKeepAlive } from "./http.ts";
import { configureCommandMenu } from "./menu.ts";
import { startMonitor } from "./monitor.ts";
import { State } from "./state.ts";
import { tradingSettings } from "./settings.ts";
import { Wallets } from "./wallets.ts";
import { Journal } from "./journal.ts";
import { applyJournalEntry, reconcile } from "./reconcile.ts";
import { startBridgeMonitor } from "./bridge.ts";
import { startOrderRunner } from "./order-runner.ts";
import { OrderStore } from "./orders.ts";

const cfg = loadConfig();
enableKeepAlive([
  "https://api.telegram.org",
  "https://aggregator-api.kyberswap.com",
  "https://api.honeypot.is",
  ...cfg.chains.map((c) => c.rpcUrls[0]),
]);
const state = new State("data/state.json");
const journal = new Journal("data/trades.jsonl", (e) => applyJournalEntry(state, e));
const wallets = new Wallets(cfg.privateKey, cfg.chains, ".env", journal);
const deps = wallets.depsFor("main");
await reconcile(journal, state, (wallet, chain) => wallets.get(wallet, chain));
const orders = new OrderStore("data/orders.json");
const bot = createBot(cfg, deps, state, {}, wallets, orders);

console.log(`链: ${cfg.chains.map((c) => c.label).join(", ")} | 钱包: ${deps.get(cfg.chains[0].key)!.clients.account.address}`);
const timer = setTimeout(
  () => console.error("15 秒仍未连上 Telegram：请检查代理软件是否开启、HTTPS_PROXY 端口是否正确"),
  15_000,
);
await bot.start({
  onStart: (me) => {
    clearTimeout(timer);
    console.log(`机器人 @${me.username} 已启动`);
    startBridgeMonitor(journal, (text) => bot.api.sendMessage(cfg.allowedUserId, text));
    void configureCommandMenu(bot.api, cfg.allowedUserId)
      .then(() => console.log("命令菜单已更新"))
      .catch(() => console.error("命令菜单更新失败，下次启动时会重试"));
    const notify = (html: string) =>
      bot.api
        .sendMessage(cfg.allowedUserId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
        .catch((e) => console.log("通知发送失败:", e instanceof Error ? e.message : e));
    startMonitor({
      state,
      deps,
      getDeps: (wallet, chain) => wallets.get(wallet, chain),
      onTick: () => reconcile(journal, state, (wallet, chain) => wallets.get(wallet, chain)),
      slippageBps: (chain) => tradingSettings(state, deps.get(chain)!.chain, cfg.defaultSlippageBps).sellSlippageBps,
      notify,
    });
    startOrderRunner({
      store: orders,
      state,
      getDeps: (wallet, chain) => wallets.get(wallet, chain),
      slippageBps: (chain, side) => {
        const t = tradingSettings(state, deps.get(chain)!.chain, cfg.defaultSlippageBps);
        return side === "buy" ? t.buySlippageBps : t.sellSlippageBps;
      },
      notify,
    });
  },
});
