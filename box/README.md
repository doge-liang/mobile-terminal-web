# box —— agent 工作沙盒

> 状态(2026-07-16):设计、实现、真机验收均已完成。跨机 park/up 续聊、租约拦截、`.auth-secret` 铁律排除、断电韧性、增量快照、`box-snapshot.timer`/`box-prune.timer` 定时器——以上六项在 term1↔term2 两节点真实环境端到端验收通过(2026-07-16)。本文档描述的是两节点实测跑通的行为,不是纸面设计。

## 1. 是什么

box 是给 AI coding agent(Claude Code / Codex / Grok)准备的 per-project 工作沙盒:每个项目一个盒,可在两个节点之间 park(归档)/ up(拉起)迁移,项目文件和会话记忆随迁移带走,**不做进程热迁移**。四层架构,各层各管一件事,box CLI 本身只是薄编排层:

| 层 | 机制 | 负责 |
|---|---|---|
| 隔离 | bwrap + systemd-run(transient service + cgroup 限额) | 防误伤宿主、限内存、PID 隔离 |
| 环境版本 | Nix flake(Determinate Nix) | 工具链锁定,两节点字节级一致,可回滚 |
| 数据版本/迁移 | restic → Cloudflare R2 | 项目目录 + 会话记忆快照,meta.json 记租约 |
| 代码版本 | git(原有,不变) | 项目源码本身 |

一个活跃沙盒 = 一个 systemd transient service 包住的一棵 bwrap 进程树,锚进程是盒内自己的 tmux server(`tmux -S /run/box/<名>/tmux.sock`)。`box attach` 只是宿主上一句 `tmux attach` 连进那个 socket,盒内 `/tmp` 是私有 tmpfs——这就是 2026-07-13 "grok agent `rm -rf /tmp/*` 删掉宿主 tmux socket" 那类事故的免疫机制。

## 2. 安装

两节点各跑一次:

```bash
bash box/install.sh                       # 装本机(例如 term1)
bash box/install.sh --to my-second-node   # 打包推到另一节点(ssh 别名)并远程安装
```

`install.sh` 做的事:把 `bin/lib/exclude.txt/env.example/nodes.example` 复制到 `/opt/box`,软链 `/usr/local/bin/box`;把 `tmux-inner.conf` 装到 `/etc/box/`,`base-flake` 装到 `/etc/box/base-flake/`;若 `box/systemd/` 存在则装 4 个 unit 文件(`box-snapshot.{service,timer}`、`box-prune.{service,timer}`)并 `daemon-reload`;写 `dev.tty.legacy_tiocsti=0` sysctl;最后检查 `bwrap/restic/rclone/node/tmux` 是否都在 PATH 上,缺一个就报错退出。

依赖(装机脚本只检查不安装,除 bwrap/restic 外均假定已存在):bubblewrap(`apt-get install -y bubblewrap`)、restic、rclone(`curl https://rclone.org/install.sh | bash`)、node 20+、tmux。**Determinate Nix** 需要单独装(`curl -fsSL https://install.determinate.systems/nix | sh -s -- install`)——只有想给某个盒挂 `nix: true` 的 flake 环境层时才需要,一期沙盒不装 Nix 也能跑(直接用宿主系统工具链)。

### 新节点工具链(接入前必读)

box 的挂载策略把宿主 `/usr /lib /lib64 /bin /sbin /etc /nix` 只读绑进盒内(见"安全边界"挂载清单),**没有单独给盒装一份 agent CLI**——盒内能跑哪些 agent,取决于宿主上已经装了哪些。这是设计文档"宿主预装统一工具链"这条假设的落地要求,不是遗漏。

新节点(例如新加一台 term2 类型的机器)接入 box 集群前,必须先在**宿主**上装齐要用的 agent CLI,版本建议与主节点对齐:

- Claude Code:`npm install -g @anthropic-ai/claude-code@<版本>`(验收时 term1 与 term2 对齐装的是 `2.1.211`)。
- Codex / Grok:各自官方安装方式装到宿主 PATH 上(与 Claude Code 同理,盒内直接复用宿主二进制,不单独在盒里装)。

不做这一步的后果:跨机 `box up` 会把会话数据(`~/.claude/projects/<slug>/`、`.codex`/`.grok` 会话)正常迁移过去,但新节点盒内敲 `claude`/`codex`/`grok` 会 `command not found`——**数据已经在,只是运行时没装**,容易被误判成迁移失败。装好对应 CLI 后无需重新 track,直接 `attach` 即可用。

配置文件(每节点各一份,`chmod 600`,不入仓,模板已在 `/opt/box/`):

- `/root/.config/box/env` —— 参照 `box/env.example`:`BOX_NODE`(本机节点名)、`BOX_GLOBALS_ROLE`(term1 填 `push`,其余节点填 `pull`)、`BOX_S3_ENDPOINT`/`BOX_BUCKET`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`(R2)、`RESTIC_PASSWORD`、`BOX_MEMORY_MAX`(本节点单盒默认内存上限,按盒可在 meta.json 覆盖)。
- `/root/.config/box/nodes` —— 参照 `box/nodes.example`:每行「节点名 ssh 别名」,本机那行写 `local`。两节点各一份、内容不同(各自视角):term1 的文件里 term2 那行是 ssh 别名,term2 的文件里 term1 那行是 ssh 别名。

**R2 凭证获取步骤**:

1. Cloudflare dashboard → R2 → 新建桶,名字用 `agent-boxes`(设计约定的公开名)。
2. R2 → Manage API Tokens → 新建 token,权限选 **Object Read & Write**,Scope **限定到 `agent-boxes` 这一个桶**(不要给账号级权限)。
3. 拿到 Access Key ID / Secret Access Key,连同 endpoint(`https://<account-id>.r2.cloudflarestorage.com`,account id 在 dashboard 右侧栏)填入 env 的 `BOX_S3_ENDPOINT`/`BOX_BUCKET`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` 四行。
4. `openssl rand -base64 24` 生成一串填 `RESTIC_PASSWORD`。
5. env 四行 S3 字段 + 密码就位后,**box 代码本身不会自动 `restic init`**——新建的 R2 仓库要先手动 `restic init` 一次(用 env 里拼出的 `RESTIC_REPOSITORY=s3:$BOX_S3_ENDPOINT/$BOX_BUCKET/restic`),否则第一次 `box track`/`box snapshot` 会因仓库不存在而失败。

**`RESTIC_PASSWORD` 是全部快照的唯一解密钥,丢失 = 永久不可恢复**(restic 仓库 AES-256 加密,没有找回机制,Cloudflare 也无法代为解密)。它当前只以明文存在于两节点各自的 `/root/.config/box/env`(600 权限)——两节点若同时全毁(或两份 env 都丢),即使 R2 上的快照数据完好无损,也**永久无法解密、等同于数据全部丢失**。生成后必须**离线单独备份一份**(密码管理器/纸面均可,不要只留邮件或聊天记录),不要只依赖"两节点各存一份"当作冗余——两节点同时失联的场景(断电、误删、被抢占清盘)并不罕见,离线备份是唯一不依赖这两台机器存活的保险。

## 3. 日常命令

以 `box --help` 实际输出为准:

```
用法: box <命令> [参数]
  ls                         列出全部沙盒
  track <名> [路径]           登记现有目录为沙盒(默认 /root/<名>)
  up <名> [--node N] [--force]  拉起沙盒(自动调度节点)
  attach <名>                接入盒内 tmux
  exec <名> -- <命令...>      在盒内执行一次性命令
  park <名>                  快照归档并释放本节点
  snapshot [<名>|--active]   手动快照(--active=本机全部活跃盒并续租)
  globals <push|pull|auto>   全局配置同步
  prune                      按保留策略清理旧快照
  drop <名>                  删除沙盒的 R2 数据(交互确认)
  status                     本机视角状态
```

典型循环——一个项目从登记到跨节点续聊:

```bash
box track myproj                          # /root/myproj 登记为沙盒,首次全量快照,租约在本机
box attach myproj                         # 接入盒内 tmux,开始跑 agent
# ...干活、agent 写代码、git commit...
box park myproj                           # 快照上传、释放租约、盒内进程停止
ssh my-second-node box up myproj          # 另一节点拉起;不带 --node 时按各节点 MemAvailable 自动调度
ssh -t my-second-node box attach myproj   # 接入,agent 里 --resume 续上原会话,记忆在位
```

`box up` 在非目标节点执行且未指定本机 `--node` 时,会探测各节点内存并自动 ssh 到目标节点远程拉起;`--force` 用于抢占他机仍持有的活跃租约(见"故障排查")。

## 4. 铁律

- **`.auth-secret` 永不入快照**:`box/exclude.txt` 里排除;`box track` 检测到项目目录里有 `.auth-secret` 会自动把该盒 `pin` 到当前节点——mobile-terminal-web 就是这种场景(term2 同路径是生产部署的 tar 同步副本),防止被调度到别的节点覆盖生产。
- **改了 `box/exclude.txt` 之后必须重跑 `install.sh`**(本机以及 `--to <节点>` 远程都要跑):`box/lib/snapshot.js` 里 `EXCLUDE_FILE` 优先读 `/opt/box/exclude.txt`(已安装副本),不会跟着仓库文件自动更新——只改仓库不重装,铁律排除会静默滞后,`.auth-secret` 之类的规则可能实际没生效。

## 5. 安全边界(诚实声明)

**一期防住的**:agent 误删/误改宿主文件(系统目录只读、其它项目不可见、`/tmp` 是盒内私有 tmpfs);内存失控拖垮宿主(systemd `MemoryMax` cgroup 限额,OOM 只死盒内;`OOMPolicy=continue` 让盒内单进程被杀后盒能自愈,不用整体重启);TIOCSTI 终端注入(两节点 `dev.tty.legacy_tiocsti=0`);进程可见范围(`--unshare-pid`)。

**一期不防的**:恶意逃逸——盒内进程是 root、内核面与宿主共享,威胁模型是"误伤与 prompt 注入级",不是敌对租户;网络横向——一期共享宿主 netns;向任意域名的数据外发没有拦截,任何白名单方案都防不住已经拿到出网权限的恶意代码,**凭证根本不落进沙盒可读路径**才是唯一有效控制。

凭证/配置挂载清单(权威定义在 `box/lib/mounts.js`):

- 只读:`~/.claude/{CLAUDE.md,settings.json,output-styles,skills,plugins}`、`~/.gitconfig`、`~/.config/gh`、`~/.local`
- 读写:`~/.claude/.credentials.json`、`~/.claude.json`、`~/.claude/projects/<本盒 slug>`、整个 `~/.codex`、整个 `~/.grok`(token 刷新需要写;`.codex`/`.grok` 是整目录 RW,意味着跨盒的 codex/grok 会话彼此可读——一期已知取舍,见"已知边界")
- 不可见:宿主 `/root` 下其它项目目录、`~/.ssh`

`gh` 凭证在盒内以**只读**挂载可读,这是 `git push` 能跑通的必要取舍(agent 要能在盒内提交推送),不是疏漏——只读意味着盒内代码读得到 token 但改不了宿主的 gh 配置本身。

**二期加固路径**(不占磁盘/不常驻内存,机制已调研可行,尚未实现):每盒独立非 root uid(bwrap 内降权);`--unshare-net` + 域名白名单代理(复用 Anthropic sandbox-runtime 的 socat 桥模式)或 pasta 用户态网络栈。

## 6. 已知边界

- **进程不迁移**:park/up 迁移的是文件和会话上下文,不是运行中的进程——`park` 时盒内正在跑的命令会被终止,agent 靠 `--resume` 之类机制在新节点接上下文,不是断点续行。
- **嵌套 tmux**:从网页终端 attach(其本身就跑在宿主 tmux 里)再 `box attach` 进盒,会出现 tmux 套 tmux;盒内层用绿色状态栏(`box/tmux-inner.conf`,`[box:<hostname>]`)做视觉区分,不是消除嵌套。
- **grok 全局索引不迁移**:`~/.grok/session_search.sqlite` 这类全局索引文件不在会话切片范围内(`box/lib/sessions.js` 只按目录名解码出的 cwd 匹配单个项目的会话),不随快照迁移。
- **globals 单向流**:`box globals push/pull` 不做双向合并——防止两机同时刷新 OAuth refresh token 互相顶掉。约定 term1 push、其余节点 pull(`box-snapshot.timer` 每小时按 `BOX_GLOBALS_ROLE` 自动跑 `globals auto`)。**push 节点(term1)是凭证的真相源**:`push`=`restic backup`(本机盘→R2),`pull`=`restic restore latest`(R2→本机盘),二者不对称——pull 节点执行 `push` 只是把自己的文件当新快照传到 R2,并不会写回 term1 的本地盘,而 term1 下一轮定时任务仍会用它盘上的旧凭证 `push` 出新快照,把刚才传上去的覆盖掉;pull 节点因为角色是 pull,也永远不会主动把这份新快照拉回自己。因此在非 term1 节点重新登录了某个 agent(刷新了它的 auth)后,正确恢复流程二选一:**要么直接在 term1 上重新登录该 agent**(凭证直接落在真相源上);**要么该节点 `box globals push` 之后,登录 term1 手动跑一次 `box globals pull`**,让 term1 盘拿到这份新凭证,下一轮它的定时 `push` 才会把新凭证保持在 R2 上,而不是被旧凭证覆盖回去。
- **定时快照的完整行为**:`box-snapshot.timer`(`OnCalendar=hourly`)触发 `box-snapshot.service`,依次执行两条 `ExecStart`:`box snapshot --active`(本机当前持有租约的全部活跃盒各打一次快照并续租)、再 `box globals auto`(按本机 `BOX_GLOBALS_ROLE` push 或 pull)。两条 `ExecStart` 均未加 `-` 前缀,是标准 `Type=oneshot` 语义——**前一步真失败(非零退出)会阻断第二步、globals 同步会被跳过、unit 标记 failed**。正因如此,"本机没有活跃盒"这种每小时都会遇到的正常情况必须让 `box snapshot --active` 走成功退出(0),不能算失败:活跃盒列表为空时打印"本机无活跃盒,跳过快照"并正常返回,globals 同步才能照常跑到。
- **`box exec` 的 PATH 与 `attach` 不完全一致**:`exec`(`box/lib/runtime.js` 的 `execIn`)走 `nsenter` 继承调用方 shell 的 PATH,不是 `mounts.js` 里 `attach`/`startSandbox` 用的固定 `BASE_PATH`/`NIX_PATH`;不是安全问题,但调试时用 `exec` 复现的行为可能和交互式 attach 不完全一样。
- **Nix 闭包可能被 GC 回收后重拉**:term1 磁盘吃紧,`nix.conf` 配了 min-free/max-free 水位自动 GC;`nix develop` 的输出没有持久 gcroot,base-flake 闭包被回收后下次 `nix develop` 大概率要从 substituter(优先 term2)重新拉取,不是常驻不动的。

## 7. 故障排查

- `journalctl -u boxrun-<名>` —— 盒起不来、OOM、崩溃先看这个。注意 unit 名是 `boxrun-<名>`(transient service),不是 `.scope`。
- `box status` —— 本机视角汇总:节点身份/globals 角色/内存默认上限/R2 连通性/restic 快照数/定时快照 timer 状态/本机活跃盒列表,一条命令代替下面几条手动核对。真机输出示例(term1):

```
$ box status
节点: term1(globals push)  内存默认上限: 1500M
R2 连通: ok
restic 快照数: 3
定时快照: active
本机活跃盒:
  (无)
```

`本机活跃盒` 有活跃沙盒时列出对应的 `boxrun-<名>.service` 行,没有则显示 `(无)`。
- `restic snapshots --tag box:<名>` —— 查某个盒的快照历史(需要先把 `box/lib/env.js` 拼的 `RESTIC_REPOSITORY`/`RESTIC_PASSWORD`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` 四个变量 export 进当前 shell,或直接读 `/root/.config/box/env` 手动拼)。
- 盒起不来:先查 `/run/box/<名>/tmux.sock` 是否存在,再 `systemctl status boxrun-<名>` 看 unit 是不是直接 failed。
- 租约冲突(报错"沙盒活跃于 <节点>"):去持有租约的节点 `box park <名>` 正常释放;确认对方确实已下线/失联,再用 `box up <名> --force` 强制抢占(会警告分叉风险,对方未落盘的改动会在快照历史里分叉,以后到者为准)。
