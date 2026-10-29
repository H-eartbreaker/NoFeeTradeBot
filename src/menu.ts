import type { Api } from "grammy";

export const commands = [
  { command: "start", description: "打开交易终端" },
  { command: "chain", description: "选择交易链：BSC / Base / ETH / 罗宾汉" },
  { command: "balance", description: "查看各链余额和持仓" },
  { command: "settings", description: "交易参数、买前确认和显示设置" },
  { command: "logos", description: "链 Logo 显示和导入" },
  { command: "slippage", description: "设置滑点，点击后直接发送百分比" },
  { command: "tpsl", description: "设置止盈止损，点击后直接回复数字" },
  { command: "help", description: "查看使用说明" },
];

export async function configureCommandMenu(api: Api, userId: number): Promise<void> {
  // 仅给白名单用户的私聊设置菜单，命令处理仍使用原有的身份校验。
  await api.setMyCommands(commands, { scope: { type: "chat", chat_id: userId } });
  await api.setChatMenuButton({ chat_id: userId, menu_button: { type: "commands" } });
}
