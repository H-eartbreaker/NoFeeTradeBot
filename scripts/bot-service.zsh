#!/bin/zsh
# 双击应用使用的后台入口。只管理本项目，不按名称批量结束 Node。
set -eu
umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
PROJECT_DIR="${0:A:h:h}"
cd "$PROJECT_DIR"
mkdir -p data
SERVICE_LABEL="local.demobot.$(printf '%s' "$PROJECT_DIR" | /usr/bin/cksum | /usr/bin/awk '{print $1}')"
SERVICE_TARGET="gui/$(/usr/bin/id -u)/$SERVICE_LABEL"
SERVICE_PLIST="$PROJECT_DIR/data/mac-bot.plist"
SERVICE_LOG="$PROJECT_DIR/data/mac-bot.log"

if ! mkdir data/mac-launcher.lock 2>/dev/null; then
  print '另一个启动或停止操作正在进行，请稍等片刻再双击。'
  exit 1
fi
trap 'rmdir "$PROJECT_DIR/data/mac-launcher.lock" 2>/dev/null || true' EXIT

service_pid() {
  /bin/launchctl print "$SERVICE_TARGET" 2>/dev/null | /usr/bin/awk '/^[[:space:]]*pid = [0-9]+/ { print $3; exit }'
}

# 兼容以前从终端启动的实例，同时限定用户、启动参数和工作目录。
manual_pids() {
  local candidate cwd
  for candidate in $(/usr/bin/pgrep -u "$(/usr/bin/id -u)" -f 'node .*src/index[.]ts' || true); do
    cwd=$(/usr/sbin/lsof -a -p "$candidate" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p' || true)
    [[ "$cwd" == "$PROJECT_DIR" ]] && print "$candidate"
  done
  return 0
}

case "${1:-}" in
  start)
    if [[ -n "$(service_pid)" || -n "$(manual_pids)" ]]; then
      print '机器人已经在运行，无需重复启动。要更新代码，请先双击「停止机器人」，再双击「启动机器人」。'
      exit 0
    fi
    [[ -f .env && -d node_modules ]] || { print '配置或依赖缺失，请联系开发 Agent 检查；没有启动机器人。'; exit 1; }
    NODE_BIN=$(command -v node || true)
    [[ -n "$NODE_BIN" ]] || { print '没有找到 Node.js，请联系开发 Agent 检查安装。'; exit 1; }
    /bin/launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
    : > "$SERVICE_LOG"
    export PROJECT_DIR SERVICE_LABEL SERVICE_PLIST SERVICE_LOG NODE_BIN
    "$NODE_BIN" --input-type=module - <<'JS'
import { writeFileSync } from 'node:fs';
const e = process.env;
const xml = (value) => value.replace(/[&<>"']/g, (c) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]));
writeFileSync(e.SERVICE_PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(e.SERVICE_LABEL)}</string>
<key>ProgramArguments</key><array><string>${xml(e.NODE_BIN)}</string><string>--env-file=.env</string><string>src/index.ts</string></array>
<key>WorkingDirectory</key><string>${xml(e.PROJECT_DIR)}</string>
<key>EnvironmentVariables</key><dict><key>NODE_USE_ENV_PROXY</key><string>1</string></dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(e.SERVICE_LOG)}</string>
<key>StandardErrorPath</key><string>${xml(e.SERVICE_LOG)}</string>
</dict></plist>`, { mode: 0o600 });
JS
    if ! /bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$SERVICE_PLIST" 2>/dev/null; then
      print 'macOS 没有允许启动后台任务。没有启动成功，请让开发 Agent 检查。'
      exit 1
    fi
    for attempt in {1..20}; do
      if /usr/bin/grep -q '机器人 @.* 已启动' "$SERVICE_LOG"; then
        print '机器人已启动，可以去 Telegram 使用了。关闭这个提示框后，机器人会继续在后台运行。'
        exit 0
      fi
      if [[ "$attempt" -gt 2 && -z "$(service_pid)" ]]; then
        print '机器人启动失败。错误记录在项目 data/mac-bot.log，请让开发 Agent 检查；不要把 .env 发给别人。'
        exit 1
      fi
      /bin/sleep 1
    done
    print '后台进程已启动，但还没连上 Telegram。请检查代理软件；如果一直没回应，双击「停止机器人」后再启动。'
    ;;
  stop)
    /bin/launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
    for candidate in $(manual_pids); do
      # 再次核对工作目录，避免退出与 PID 复用期间误杀其他项目。
      cwd=$(/usr/sbin/lsof -a -p "$candidate" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p' || true)
      [[ "$cwd" != "$PROJECT_DIR" ]] || /bin/kill -TERM "$candidate" 2>/dev/null || true
    done
    for attempt in {1..10}; do
      if [[ -z "$(service_pid)" && -z "$(manual_pids)" ]]; then
        print '机器人已停止。停止期间，自动止盈止损和自动订单也不会执行。'
        exit 0
      fi
      /bin/sleep 1
    done
    print '停止请求已发出，但进程还没有退出。请稍后再试，暂时不要重复启动。'
    exit 1
    ;;
  *) print '请双击「启动机器人」或「停止机器人」。'; exit 1 ;;
esac
