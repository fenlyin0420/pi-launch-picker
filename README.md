# pi-launch-picker

> **English** — A Pi extension that decides the session's starting state before the
> conversation begins: which tools are active, which system prompt is used, and saved
> named profiles for both — reachable from the TUI, a CLI flag, or RPC.
>
> 中文文档见下。

在对话开始前决定这次会话的"起点状态"：启用哪些工具、用哪份系统提示词，并把组合保存成命名 profile。可以用交互式选择器、CLI flag 或 RPC 命令三条路径操作。

## 安装

```bash
pi install git:github.com/fenlyin0420/pi-launch-picker
```

或临时试用一次，不写入设置：

```bash
pi -e git:github.com/fenlyin0420/pi-launch-picker
```

## 它管什么

| 对象 | 说明 |
|---|---|
| 工具集 | 通过 `pi.setActiveTools()` 精确设定激活工具，支持"一个都不留"的干净状态 |
| 系统提示词 | 每轮经 `before_agent_start` 整体替换，预设来自 `~/.pi/agent/system-prompts/*.md`；内置两个特殊选项：`(default)` 用 pi 自带提示词，`(empty)` 置空，让用户消息成为唯一提示词内容 |
| Profile | 工具集 + 提示词预设的组合，命名后持久化到 `~/.pi/agent/launch-profiles.json` |

## 启动行为

按优先级依次尝试：

1. CLI flag `--lp-profile <名字>`
2. 会话记录里的 profile（`/resume` 后仍生效）
3. profiles 文件里的 `last`（上次用过的）
4. 以上都没有，且终端是真 TUI → 弹出选择器

也就是说：第一次用会问你一次，之后每次静默沿用上次的选择，想换用 `/lpick` 或 `/lprofile`。

## 命令

| 命令 | 作用 |
|---|---|
| `/lpick` | 打开交互式选择器（profile → 自定义工具多选 → 提示词预设） |
| `/lprofile [名字]` | 套用 profile 并持久化为 `last`；不带参数开选择器；`(none)` 清除回默认 |
| `/lprompt [名字]` | 切换系统提示词预设；不带参数开选择器 |
| `/ltools <spec>` | 设定激活工具：`all` / `none` / `read,bash,edit` 这样的逗号列表 |
| `/lsave <名字>` | 把当前工具集 + 提示词存成 profile |
| `/lstate [prompt]` | 查看当前状态：工具数、实际进提示词的 skill 数、扩展、提示词预设与字符数；带 `prompt` 输出提示词全文 |

快捷键 `ctrl+shift+l` 打开选择器。

## 自定义系统提示词预设

在 `~/.pi/agent/system-prompts/` 放 Markdown 文件，文件名即预设名：

```
~/.pi/agent/system-prompts/chat.md        ->  预设 "chat"
~/.pi/agent/system-prompts/research.md    ->  预设 "research"
```

配合 `(empty)` 可以做出"完全没有系统提示词"的会话，此时发给模型的只有用户消息（工具 schema 仍随 API 的 `tools` 参数传递）。

## Profile 文件

`~/.pi/agent/launch-profiles.json`：

```json
{
  "last": "clean",
  "profiles": {
    "clean": { "tools": [], "prompt": "(empty)" },
    "dev": { "tools": ["read", "bash", "edit", "write"], "prompt": "(default)" }
  }
}
```

`tools` 省略表示不动工具集，`prompt` 省略表示不动提示词预设。

## RPC / app 集成

命令本身就是普通的 slash command，通过 RPC 的 `prompt` 消息即可调用：

```json
{"type":"prompt","message":"/ltools none"}
{"type":"prompt","message":"/lprompt (empty)"}
{"type":"prompt","message":"/lsave chat"}
{"type":"prompt","message":"/lstate"}
```

执行结果以 notify 形式返回（`extension_ui_request` 的 `method: "notify"`）。

注意：

- 命令要作为整条消息发送，斜杠命令才会被拦截执行。
- `ui.select` / `ui.input` 对话框会降级成 `extension_ui_request`，由客户端回 `extension_ui_response`；但 `/lpick` 里的工具多选用的是 `ui.custom`，非 TUI 环境取不到，应改用 `/ltools` + `/lprompt` + `/lsave` 组合。
- 想要启动即干净：`pi --mode rpc --lp-profile clean`，全程无对话框。

## 与内置 flag 的关系

pi 自带 `--system-prompt`、`--tools`、`-ns`、`-ne` 等一次性开关，本扩展补的是**可交互、可持久化、可远程调用**的那一层。两者不冲突：flag 决定进程初始状态，本扩展在此之上覆盖工具集与提示词，并把选择记住。

## 开发

```bash
npm install --ignore-scripts
npm run check
```
