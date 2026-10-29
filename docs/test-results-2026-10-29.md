# 免费测试结果（2026-10-29）

## 结果

**128 项通过、0 项失败、0 项跳过，共 21 个测试文件。** 类型检查与 Git 差异格式检查通过，Mac 脚本语法检查通过。

本轮没有发起真实交易、授权、转账或跨链，没有使用真实钱包签名，没有购买接口服务。测试钱包只存在临时目录；真实机器人未为测试而重启或停止。

## 已执行的免费检查

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 原有自动测试 | 89 项通过 | 确认、取消、防重复、滑点、止盈止损、账本、盈亏、钱包、授权、资金操作与 Logo |
| 新增自动测试 | 39 项通过 | Solana、限价/市值/定投、订单界面与运行恢复、追踪、风控与发送前检查 |
| 四链真实 UI 只读 | 4 链通过 | BNB、Base、Ethereum、Robinhood 卡片与买前确认，交易调用 0 |
| 稳定币报价/未签名构建 | 4 链双向通过 | BNB-USDT、Base-USDC、ETH-USDT、Robinhood-USDG |
| 跨链报价 | 4 条路线通过 | BNB→Base、Base→BNB、ETH→Base、Robinhood→Base，只生成报价 |
| Solana 只读 | 3 组通过 | 原生余额/SPL 与 Token-2022 持仓、USDC 信息、Jupiter 双向报价/未签名构建，签名和发送 0 |

## 本轮发现并修复

1. **限价舍入不够严格**：最小接收量和卖出市值目标改为向上取整，避免因为舍入允许比目标更差的成交价。
2. **重复订单 ID 未拒绝**：持久化层现在拒绝重复 ID，避免同一任务出现两份。
3. **空风控金额被当成零**：缺失报价美元金额现在显示未知并遵守过滤规则。
4. **取消/暂停期间仍可能继续下单**：报价回来后重读订单状态；排队、准备、授权及最终发送前再检查。已取消/暂停/过期的订单不会被旧检查继续执行。
5. **未知交易哈希未保存到专门字段**：自动订单待核对时保存 lastHash，结果不明不重发。
6. **Solana 广播后查询断网丢失待确认状态**：保留签名，返回待确认而不是普通失败。
7. **Solana 默认节点拒绝查持仓**：原 PublicNode 的持仓方法返回 HTTP 403；官方免费主网节点余额和持仓均通过，默认值已更换。显式配置的自定义节点仍保留。

上述行为都有新增回归断言，节点切换另有真实只读验证。为测试 Solana 界面增加可注入服务，默认生产依赖不变。

## 测试文件

| 文件 | 项数 | 结果 |
| --- | ---: | --- |
| `approvals.test.ts` | 5 | 通过 |
| `auto-rules.test.ts` | 7 | 通过 |
| `automation-panels.test.ts` | 3 | 通过 |
| `bot.test.ts` | 13 | 通过 |
| `button-icons.test.ts` | 1 | 通过 |
| `funds.test.ts` | 11 | 通过 |
| `ledger.test.ts` | 7 | 通过 |
| `logos.test.ts` | 7 | 通过 |
| `monitor.test.ts` | 5 | 通过 |
| `order-runner.test.ts` | 10 | 通过 |
| `orders.test.ts` | 5 | 通过 |
| `pnl-card.test.ts` | 2 | 通过 |
| `pnl.test.ts` | 5 | 通过 |
| `positions.test.ts` | 4 | 通过 |
| `risk-policy.test.ts` | 3 | 通过 |
| `settings.test.ts` | 3 | 通过 |
| `sol-core.test.ts` | 11 | 通过 |
| `sol-panel.test.ts` | 6 | 通过 |
| `trade.test.ts` | 7 | 通过 |
| `util.test.ts` | 7 | 通过 |
| `wallet-panel.test.ts` | 6 | 通过 |

## 命令与复现

```sh
npm run check
env -u SOLANA_PRIVATE_KEY npm test
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/ui-smoke.ts
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/funds-smoke.ts
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/sol-smoke.ts
zsh -n scripts/bot-service.zsh
zsh -n scripts/build-mac-apps.zsh
```

这些测试命令不加 `--env-file=.env`。按本机实际情况调整代理。真实只读接口受节点、限流与行情影响，本次通过不保证以后一直可用。

## 还不能据此保证的内容

- 没有验证真实资金成交、真实到账、最终手续费和滑点效果。
- 没有在 Telegram 里用真账号逐项点完所有页面；交互测试拦截全部 API，用假 RPC 和模拟交易函数验证行为。
- 没有运行新的 Mac 应用重启测试，以免打断当前自动任务；本轮只检查脚本语法。此前实际启动验证记录仍保留。
- 外部 API 所有畸形返回、长期高频运行、链重组等极端组合尚未全部覆盖。
- 测试发现的代码修复尚未自动载入当前运行进程；下次双击「启动机器人」会加载本轮修复。
