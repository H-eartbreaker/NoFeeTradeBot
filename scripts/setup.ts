// 交互式生成 .env：node scripts/setup.ts
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

if (existsSync(".env")) {
  console.log(".env 已存在，为避免覆盖已退出。需要重来请先手动删除或重命名它。");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => (await rl.question(q)).trim();

const token = await ask("1) Telegram 机器人 token（BotFather 给的）: ");
const userId = await ask("2) 你的 Telegram 数字 ID（@userinfobot 查）: ");
let key = await ask("3) 钱包私钥 0x...（直接回车 = 自动生成一个新的专用钱包）: ");
rl.close();

let generated = false;
if (!key) {
  key = generatePrivateKey();
  generated = true;
}

if (!/^\d+$/.test(userId)) throw new Error("Telegram ID 必须是纯数字");
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("私钥格式不对：需要 0x 开头加 64 位十六进制");
if (!token.includes(":")) throw new Error("token 格式不对，应该形如 123456:ABC...");

const content = readFileSync(".env.example", "utf8")
  .replace(/^TELEGRAM_BOT_TOKEN=.*$/m, `TELEGRAM_BOT_TOKEN=${token}`)
  .replace(/^ALLOWED_USER_ID=.*$/m, `ALLOWED_USER_ID=${userId}`)
  .replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${key}`);
writeFileSync(".env", content);
chmodSync(".env", 0o600);

console.log("\n.env 已生成（权限仅你本人可读）。");
console.log("钱包地址（往这里充 BSC 上的 BNB）:", privateKeyToAccount(key as `0x${string}`).address);
if (generated) console.log("这是新生成的钱包，私钥只保存在 .env 里。建议自己另外备份一份 .env。");
