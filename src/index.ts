import { loadConfig } from "./config.ts";
import { createBot } from "./bot.ts";
import { State } from "./state.ts";
import { createClients } from "./wallet.ts";

const cfg = loadConfig();
const clients = createClients(cfg);
const state = new State("data/state.json");
const bot = createBot(cfg, clients, state);

console.log(`链: ${cfg.chain.label} | 钱包: ${clients.account.address}`);
const timer = setTimeout(
  () => console.error("15 秒仍未连上 Telegram：请检查代理软件是否开启、HTTPS_PROXY 端口是否正确"),
  15_000,
);
await bot.start({
  onStart: (me) => {
    clearTimeout(timer);
    console.log(`机器人 @${me.username} 已启动`);
  },
});
