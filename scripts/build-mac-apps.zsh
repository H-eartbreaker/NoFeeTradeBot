#!/bin/zsh
# 只生成本地应用，不启动、停止机器人，也不安装开机任务。
set -eu
PROJECT_DIR="${0:A:h:h}"
for action in start stop; do
  if [[ "$action" == start ]]; then
    APP_NAME='启动机器人'
  else
    APP_NAME='停止机器人'
  fi
  /usr/bin/osacompile -o "$PROJECT_DIR/$APP_NAME.app" <<APPLESCRIPT
on run
  set appPath to POSIX path of (path to me)
  try
    set resultText to do shell script "/bin/zsh " & quoted form of (appPath & "../scripts/bot-service.zsh") & " $action"
    display dialog resultText with title "$APP_NAME" buttons {"好"} default button "好"
  on error
    display dialog "操作没有完成。请检查项目 data/mac-bot.log，或请开发 Agent 检查启动器。" with title "$APP_NAME" buttons {"好"} default button "好" with icon caution
  end try
end run
APPLESCRIPT
done
print '已生成：启动机器人.app、停止机器人.app（位于项目目录）'
