import { createBot } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { startMonitor } from "./monitor.ts";
import { State } from "./state.ts";
import type { TradeDeps } from "./trade.ts";
import { createClients } from "./wallet.ts";

const cfg = loadConfig();
const state = new State("data/state.json");
const deps = new Map<string, TradeDeps>(
  cfg.chains.map((chain) => [chain.key, { chain, clients: createClients(cfg.privateKey, chain) }]),
);
const bot = createBot(cfg, deps, state);

console.log(`链: ${cfg.chains.map((c) => c.label).join(", ")} | 钱包: ${deps.get(cfg.chains[0].key)!.clients.account.address}`);
const timer = setTimeout(
  () => console.error("15 秒仍未连上 Telegram：请检查代理软件是否开启、HTTPS_PROXY 端口是否正确"),
  15_000,
);
await bot.start({
  onStart: (me) => {
    clearTimeout(timer);
    console.log(`机器人 @${me.username} 已启动`);
    startMonitor({
      state,
      deps,
      slippageBps: () => state.slippageBps ?? cfg.defaultSlippageBps,
      notify: (html) =>
        bot.api
          .sendMessage(cfg.allowedUserId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
          .catch((e) => console.log("通知发送失败:", e instanceof Error ? e.message : e)),
    });
  },
});
