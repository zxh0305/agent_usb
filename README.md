# 随身 Agent 盘

插到任意一台 **macOS / Windows / Linux** 电脑上就能用的 Claude Code,全部数据都在这个 U 盘里。
不在宿主机留下任何安装痕迹。

---

## 从零部署

仓库里只有源码 —— 运行时和 Claude Code 二进制不入库(体积大,且可重建)。
所以克隆之后需要跑一次构建:

```sh
git clone https://github.com/zxh0305/agent_usb.git agent_usb
cd agent_usb

# 1. 在本地磁盘构建运行时与 Claude Code,并拷进当前目录
#    (这一步需要联网;默认构建 darwin-arm64 + win32-x64 + linux-x64)
sh tools/build-local.sh

# 2. 录入一个供应商密钥(以 DeepSeek 为例)
node tools/secrets.mjs set deepseek

# 3. 体检并启动
sh tools/doctor.sh --probe
sh tools/claude.sh
```

想把整个东西装到 U 盘上:直接把构建好的目录拷到盘里即可。
`data/home/` 下的 Claude Code 配置会在**首次运行时自动补齐**,不需要手工准备。

> **为什么不在库内放二进制**:Node 约 120MB/平台,Claude Code 约 240MB/平台,
> 放进 git 会让仓库膨胀到 GB 级且无法有效增量;而这些都能用 `build-local.sh` 一键重建。

---

## 怎么用

### macOS / Linux
```sh
sh tools/claude.sh
```
或者直接双击 **`启动.command`**(macOS)。

### Windows
双击 **`启动.bat`**;或在命令行里:
```bat
tools\claude.bat
```

> **为什么必须双击、不能自动运行**:现代 macOS 和 Windows 都禁止了 U 盘自动执行程序(autorun),
> 这是系统安全限制,绕不过去。

---

## 常用命令

| 想做什么 | 命令 |
|---|---|
| 启动 | `sh tools/claude.sh` |
| 换一个模型/供应商 | `sh tools/claude.sh --list` 看列表,然后 `--provider <id>` |
| 只测连通性,不进对话 | `sh tools/claude.sh --check` |
| 体检 & 修复 | `sh tools/doctor.sh --clean --probe` |
| 录入/更换密钥 | `sh tools/claude.sh` 前先 `node tools/secrets.mjs set <name>` |
| 给 claude 传参数 | `sh tools/claude.sh -- -p "你的问题"` |
| 重新构建运行时 | `sh tools/build-local.sh` |

`--` 之后的参数会**原样传给 Claude Code**。例如非交互提问:
```sh
sh tools/claude.sh -- -p "用一句话解释什么是闭包"
```

---

## 交互面板

不带任何参数启动就是面板(双击入口走的也是这条路):

```
┌─ P O R T A B L E   A S S I S T A N T ─────────────────────────────┐
│                                                                   │
│  ██████ ██     ██████ ██  ██ █████  ██████    S Y S T E M         │
│  ██     ██     ██  ██ ██  ██ ██  ██ ██          OS    macOS …     │
│  ██     ██     ██████ ██  ██ ██  ██ ████        CPU   10 核       │
│  ██     ██     ██  ██ ██  ██ ██  ██ ██          RAM   16 GB       │
│  ██████ ██████ ██  ██ ██████ █████  ██████      DISK  27.9 GB 空闲│
│                                                                   │
│  RUNTIME   node v24.21.0  ·  claude-code 2.1.295                   │
│  MODEL     deepseek-flash  via DeepSeek (Flash · 更快更省)         │
│  BALANCE   ¥1.22                                                  │
│  CAPACITY  小模型 deepseek-flash · 上下文 1M · 密钥 ● 就绪         │
│  ───────────────────────────────────────────────────────────────  │
│  ▸ [1] 启动 Claude Code                        当前 deepseek-flash│
│    [2] 切换供应商 / 模型                        7 个              │
│    [3] 测试连通性                              真实探活           │
│    [4] 密钥管理                                2 个密钥          │
│    [5] 体检与修复                              10 项检查         │
│    [6] 关于 / 版本                                                │
│  ───────────────────────────────────────────────────────────────  │
│  1-6 选择   ↑↓ 导航   Enter 确认   Q 退出      claude 2.1.295     │
└───────────────────────────────────────────────────────────────────┘
```

**余额**会自动查询并显示(60 秒缓存)。要支持新供应商的余额,
在 `data/config/providers.json` 里给它加一段 `balance`:

```json
"balance": {
  "url": "https://api.deepseek.com/user/balance",
  "total": "balance_infos.0.total_balance",
  "currency": "balance_infos.0.currency"
}
```

`total` / `currency` 是从接口返回的 JSON 里取值的路径(点号分隔)。
没配 `balance` 的供应商显示 `—`。DeepSeek 已实测可用;其他家接口各不相同,需要你自己补。

### 退出后自动关闭终端窗口

双击 `启动.command` 退出后会**自动关闭窗口**。macOS 控制终端需要"自动化"权限,
第一次可能弹一次授权框;拒绝的话就会退化成"按回车键关闭窗口"。

想每次都保留窗口,两种办法:
- 在「终端 → 设置 → 描述文件 → Shell → 当 shell 退出时」改成"保持窗口"(推荐,无需权限);
- 或用 `USB_AGENT_KEEP_OPEN=1 sh 启动.command` 启动。

按键:

| 键 | 作用 |
|---|---|
| `1`–`6` / `↑` `↓` | 选择菜单项 |
| `Enter` | 确认 |
| `q` / `Esc` | 返回上一级 / 退出 |

> **字母键不分大小写**,按 `a` 和 `A` 效果一样。下面写小写只是为了不让人以为要按 Shift。

**供应商屏**(`2` 进入):

| 键 | 作用 |
|---|---|
| `Enter` | 把选中项设为当前供应商 |
| `m` | **获取该接口的模型列表**(拉不到会打开手动输入) |
| `n` | **手动输入模型名**(自建网关通常只能这样) |
| `x` | 切换鉴权方式(`Bearer` ↔ `x-api-key`) |
| `a` | **新增第三方接口**(填名称 / Base URL / 密钥,随后进入选模型) |
| `e` | 改名称 / URL / 密钥(留空表示不改) |
| `d` | 删除(**只能删自己新增的**,内置项删不掉,防误操作) |
| `k` | 跳到密钥屏 |

**模型屏**(按 `m` 后):`↑↓` 选择,**第一项是 `✎ 手动输入模型名`**,`Enter` 使用,`i` 直接手输,`Esc` 返回。

**密钥屏**(`4` 进入):`↑↓` 选择,`a` 录入,`d` 删除,`Esc` 返回。
录入时**独占全屏**并显示提示(输入不回显),提交后会告诉你读到多少字符。

面板只用 Node 内置模块实现(不引入 blessed/ink),所以**盘上不会出现 `node_modules`**——
exFAT 装不了软链接,npm 依赖在盘上根本装不起来,零依赖是最稳的选择。

> 布局做了自适应:终端低于 60×18 会提示放大;窗口不够宽时大 logo 自动换成小标题。
> 想检查排版是否对齐,可以跑 `node tools/tui.mjs --render-only 84 26 main`,它会逐行校验宽度。

---

## 目录说明

```
├── 启动.command / 启动.bat     双击入口
├── tools/
│   ├── claude.sh / .bat       启动入口(跨平台分发)
│   ├── launch.mjs             ★ 核心:重定向环境 + 注入供应商凭证 + 启动
│   ├── secrets.mjs            密钥库(加密)
│   ├── doctor.mjs / .sh / .bat 体检与修复
│   ├── build-local.sh         在本地磁盘重建运行时与 Claude Code
│   └── env.sh / .bat          想把当前 shell 的配置也指到盘上时用
├── runtime/node/<平台>/bin/node    Node 运行时(每个平台一份)
├── app/claude/                 Claude Code 本体(每个平台一份)
└── data/                       ★ 你的数据都在这,备份就打这个包
    ├── home/                   伪 HOME(配置、会话都在里面)
    ├── config/providers.json   供应商与模型清单(可手改)
    ├── config/secrets.json     加密后的密钥
    ├── workspace/              默认干活目录
    └── sessions/ memory/ logs/
```

**要备份或迁移,只需要拷走 `data/` 一个目录。** 其余都是可以重新构建的产物。

---

## 关于密钥安全(请读一下)

密钥用 AES-256-GCM 加密后存在 `data/config/secrets.json`,**盘上不是明文**。

但目前是**快捷模式**:解密口令放在 `data/config/passphrase` 里,所以拿到盘的人可以解开。
它防的是"误把文件发出去/被脚本扫到",**不防"丢了盘"**。

想提高安全性,记住当前口令后执行:
```sh
rm data/config/passphrase
```
之后每次启动会提示输入口令。**删之前请确认你记住了口令,否则密钥无法恢复。**

> 另外提醒:**不要把密钥和口令写进会被同步到云端的笔记或聊天记录。**

---

## 跨平台注意事项

- **exFAT 不支持软链接和硬链接**,所以盘上所有东西都是**普通文件**。这是刻意的设计。
  (你可能在 macOS 上看到过 `ln -s` 貌似成功——那是 Apple 的兼容假象,拿到 Windows/Linux 上会失效。)
- **macOS 会生成 `._*` 边车文件**(扩展属性在 exFAT 上的落盘形式)。
  搬到 Windows/Linux 前建议先跑一次:
  ```sh
  sh tools/doctor.sh --clean
  ```
- **别在盘上直接 `npm install`**。盘是"部署目标",不是构建环境。要更新就用:
  ```sh
  sh tools/build-local.sh
  ```
- 建议用 **USB 3.0 以上**的盘;USB 2.0 上写入很慢(实测约 5MB/s)。

---

## 改完怎么提交

```sh
sh tools/commit-push.sh "说明这次改了什么"
```

它会**先扫描、再提交**:检查私密路径有没有被跟踪、暂存内容里有没有私网地址
(`192.168.` / `10.` / `172.16-31.`)、`sk-` 形态的密钥、`Bearer <token>`,
以及本机密钥库口令 —— 全部通过才 commit + push。

> **不要用裸 `git push` 绕过这层检查。** 曾经因为绕过它(准确说是检查本身写错了),
> 把内网地址推到了公开仓库上,不得不重写历史强制推送来清理。

重写历史之后(例如刚清理掉敏感内容)要加 `--force`:

```sh
sh tools/commit-push.sh --force "清理历史中的敏感信息"
```

**脚本内部有个坑值得单独记一笔**:`git grep` 的参数位置必须写成
`git grep --cached -lE -e <模式>`。如果写成 `git grep -lE "<模式>" --cached`,
`--cached` 会被当成**路径参数**,结果一个文件都没搜到、永远返回"通过" ——
安全网完全失效,而且看起来一切正常。所以脚本里加了一条自检:
如果连一个必然命中的模式都搜不到任何文件,就直接中止而不是报"通过"。

---

## 已知现象(不是故障)

- 启动时会打印一行 `[claude-code:unrecognized_model] {"model":"deepseek-v4-pro"}`。
  这是 Claude Code 对"非内置模型名"的诊断提示,不影响使用,已通过
  `ANTHROPIC_CUSTOM_MODEL_OPTION` 声明为自定义模型。
- 首次在某个工作目录启动时,Claude Code 会问是否信任该目录,选 **yes** 即可(记在盘上,下次不再问)。

## 画面异常时怎么办

如果面板显示错乱、或者窗口看起来"卡住"不动:

1. 按 `Ctrl-C`;
2. 如果画面还是乱的,执行 `reset`(或 `tput reset`)把终端恢复回来;
3. 仍然不行就直接关掉终端窗口,重新双击启动。

`启动.command` 里已经有 `stty sane` 兜底,正常情况下不该再出现这种状态。

录入密钥时会**独占整个屏幕**(和面板区分开,避免和面板的提示混淆):

```
  粘贴 智谱 GLM 的密钥(glm):
  输入内容不回显,粘贴后按回车提交 · 直接回车 = 取消
```

提交后会回到面板并显示读到的字符数,例如 `glm 已加密写入(读到 53 字符)`。
**请核对那个数字。** 智谱的密钥是 `id.secret` 形式、约 50 多位;
如果明显偏小(比如 4),说明粘贴没成功,重新按 `4` → `A` 录一次。
不想录了就**直接回车取消**,或按 `Ctrl-C` 退出。

---

## 接第三方接口 / 换模型

**不用手改配置文件**,面板里就能做:按 `2` 进供应商屏 → 按 `A` 新增 → 依次填
**名称**、**Base URL**、**密钥**,填完会**自动去拉模型列表**,选一个就完事了。

对已有的供应商,按 `M` 可以随时重新拉取模型列表并换模型。

关于 Base URL,有两个坑,第二个特别容易踩:

**坑一:必须是 Anthropic 兼容的接口。** Claude Code 讲的是 Anthropic 的 `/v1/messages`
协议,所以接口商/中转站得提供这个协议。只有 OpenAI 协议(`/chat/completions`)的接口
不能直接用,需要在中间加一层转换代理。

**坑二:Base URL 里不要带 `/v1`。** Claude Code 会**自动**在 base 后面接 `/v1/messages`:

| 客户端 | 它的约定 | 所以它的 Base URL 长这样 |
|---|---|---|
| Claude Code / 本项目 | `base` + `/v1/messages` | `http://host:10006/code` |
| 某些客户端(如 ZCode 的"Anthropic Messages"格式) | `base` + `/messages` | `http://host:10006/code/v1` |

**两边的 Base URL 不能照抄。** 把后者的 `.../code/v1` 填进来,实际请求会变成
`.../code/v1/v1/messages` → **404**。项目在保存时会自动去掉多余的 `/v1`,
并在供应商屏的详情里显示**最终实际请求的完整路径**,方便你核对:

```
端点   https://your-gateway.example.com/code
主模型 GLM-5.3    小模型 GLM-5.3
鉴权   Authorization: Bearer   (按 x 切换)    请求路径 https://your-gateway.example.com/code/v1/messages
```

**关于模型名:不是所有接口都能自动列出来。** 很多自建网关(以及一些中转站)根本没有
"列模型"接口 —— 在别的客户端里也是**手工添加模型名**的。所以:

- 按 `m` 能拉到列表就选一个;
- 拉不到会直接打开选择界面,**第一项就是 `✎ 手动输入模型名`**;也可以直接按 `n` 输入。
  模型名**照抄客户端里显示的那个**(例如 `GLM-5.3`),大小写要一致。

**鉴权方式**:多数网关认 `Authorization: Bearer`,少数只认 `x-api-key`。默认用前者;
按 `x` 可以切换,供应商屏详情里会显示当前用的是哪种。探活时如果 401,程序会
**自动两种都试一遍**,哪种通就自动记住哪种。

"获取模型"是对着**这些**地址逐个试出来的(各家实现不一样):

1. `<base_url>/models`
2. `<base_url>/v1/models`
3. `<origin>/v1/models` ← 实测 DeepSeek 靠这条成功
4. `<origin>/models`

> 实测发现:DeepSeek 的 **Anthropic 路径下并没有列模型的接口**
> (`/anthropic/models` 和 `/anthropic/v1/models` 都是 404),但它的**根域名**有。
> 所以不要以为"配了 Anthropic 端点就一定能列出模型",这也是要挨个试的原因。

返回里若带 `context_window`,会自动写进该供应商的上下文长度。

**已实测可用:DeepSeek**(`deepseek-v4-pro` / `deepseek-flash`)。
另预置了智谱 GLM、Kimi、通义 Qwen、MiniMax、硅基流动的端点与模型名,但**未逐一实测**,
建议进供应商屏按 `M` 拉一次真实列表来确认。

要手改也可以:编辑 `data/config/providers.json`(不含密钥,随便改)。
密钥在 `data/config/secrets.json`,已加密。
