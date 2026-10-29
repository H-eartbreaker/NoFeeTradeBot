// 只在用户本机终端交互，不接收命令行私钥，不发送网络请求。
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Hex } from "viem";
import { loadConfig } from "../src/config.ts";
import { Wallets } from "../src/wallets.ts";

export async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("请在本机交互终端运行 npm run wallet:import；不要通过命令行参数或管道传入私钥");
  if (process.argv.length > 2) throw new Error("不接收命令行参数，请按隐藏输入提示操作");
  const cfg = loadConfig();
  const wallets = new Wallets(cfg.privateKey, cfg.chains);
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!hidden) process.stdout.write(chunk); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const controller = new AbortController();
  rl.on("SIGINT", () => controller.abort());
  try {
    process.stdout.write("粘贴要导入的专用钱包私钥（输入隐藏，Ctrl+C 取消）：");
    hidden = true;
    const key = (await rl.question("", { signal: controller.signal })).trim();
    hidden = false; process.stdout.write("\n");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("私钥格式无效，未导入");
    const w = wallets.importKey(key as Hex);
    process.stdout.write(`已在本机保存 ${w.label}\n地址：${w.address}\n重启机器人后，在钱包管理里选择该钱包。\n`);
  } finally {
    if (hidden) process.stdout.write("\n");
    rl.close(); output.end();
  }
}
if (import.meta.main) main().catch(() => { console.error("导入未完成，请检查本地配置、私钥格式和是否重复导入；私钥不会输出。"); process.exitCode = 1; });
