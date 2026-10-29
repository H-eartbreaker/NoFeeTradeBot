import { loadConfig } from "./config.ts";
import { createBot } from "./bot.ts";
import { State } from "./state.ts";
import { createClients } from "./wallet.ts";

const cfg = loadConfig();
const clients = createClients(cfg);
const state = new State("data/state.json");
const bot = createBot(cfg, clients, state);

console.log(`链: ${cfg.chain.label} | 钱包: ${clients.account.address}`);
await bot.start({ onStart: (me) => console.log(`机器人 @${me.username} 已启动`) });
