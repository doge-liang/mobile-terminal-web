# mt-shell-integration.bash —— OSC 133 语义提示符标记(shell integration)
#
# 由 server.js 经 `bash --rcfile 本文件` 作为 tmux 会话的 shell 启动。协议与
# iTerm2/WezTerm/kitty 相同:A=提示符起、B=提示符止(命令输入起)、C=命令输出起、
# D;<exit>=命令结束。前端据此切出精确的「命令块」边界与成败状态。
#
# 关键点:本 shell 跑在 tmux 内,tmux 默认吞掉未知 OSC——必须用 DCS passthrough
# (\ePtmux; 载荷中 ESC 加倍 \e\\)包裹才能穿透到浏览器侧 xterm.js;server.js 已
# 对会话开 allow-passthrough(tmux>=3.3)。不在 tmux 内(手工调试)则发裸序列。

# --rcfile 取代了默认启动链:先按 login shell 的顺序补回用户自己的配置
[ -f /etc/profile ] && . /etc/profile
for __mt_f in ~/.bash_profile ~/.bash_login ~/.profile; do
  if [ -f "$__mt_f" ]; then . "$__mt_f"; break; fi
done
unset __mt_f

# 仅交互式 shell 且未装过时安装(防 source 两次把 PROMPT_COMMAND 叠加)
case $- in *i*) ;; *) return 0 2>/dev/null || exit 0;; esac
[ -n "$__MT_SI" ] && return 0
__MT_SI=1

__mt_osc() { # $1 = OSC 133 的载荷,如 "A" / "D;0"
  if [ -n "$TMUX" ]; then
    printf '\033Ptmux;\033\033]133;%s\007\033\\' "$1"
  else
    printf '\033]133;%s\007' "$1"
  fi
}

# D;<exit> 在每次画提示符前发(含首个提示符;前端忽略无 C 配对的 D),并标记
# 「正处于提示符后」供 DEBUG trap 判定首条命令
__mt_prompt_cmd() {
  local __mt_ec=$?
  __mt_osc "D;${__mt_ec}"
  __mt_at_prompt=1
}
PROMPT_COMMAND="__mt_prompt_cmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"

# C 只在提示符后的第一条命令执行前发一次(DEBUG trap 对复合命令会触发多次)
__mt_preexec() {
  [ -n "$COMP_LINE" ] && return       # 补全过程中的 trap,忽略
  [ -z "$__mt_at_prompt" ] && return
  __mt_at_prompt=
  __mt_osc "C"
}
trap '__mt_preexec' DEBUG

# A/B 包住提示符本体;\[ \] 告知 bash 零宽,不影响换行计算。
# 静态串里 tmux 包裹形态写死:本文件只在 tmux 会话中由 server 注入,$TMUX 恒真;
# 罕见的裸调试场景 A/B 缺失只影响提示符高亮,块边界(C/D)仍由 __mt_osc 自适应。
PS1='\[\ePtmux;\e\e]133;A\a\e\\\]'"${PS1}"'\[\ePtmux;\e\e]133;B\a\e\\\]'
