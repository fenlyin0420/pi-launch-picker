# pi-launch-picker

> **English** — A Pi extension that decides the session's starting state before the
> conversation begins: which tools are active, which system prompt is used, which
> skills are advertised, and which extensions may contribute — saved as named
> profiles and reachable from the TUI, a CLI flag, or RPC.
>
> 中文文档见下。

在对话开始前决定这次会话的"起点状态"：启用哪些工具、用哪份系统提示词、只向模型广告哪些 skill、只保留哪些插件贡献，并把组合保存成命名 profile。可以用交互式选择器、CLI flag 或 RPC 命令三条路径操作。

## 安装

```bash
pi install npm:@fenlyin/pi-launch-picker
```

或临时试用一次，不写入设置：

```bash
pi -e npm:@fenlyin/pi-launch-picker
```

## 它管什么

| 对象 | 说明 |
|---|---|
| 工具集 | 通过 `pi.setActiveTools()` 精确设定激活工具，支持"一个都不留"的干净状态 |
| 系统提示词 | 每轮经 `before_agent_start` 整体替换，预设来自 `~/.pi/agent/system-prompts/*.md`；内置两个特殊选项：`(default)` 用 pi 自带提示词，`(empty)` 置空，让用户消息成为唯一提示词内容 |
| 技能 | 白名单过滤 pi 注入 system prompt 的 skills 块；名单外的不再广告给模型，`/skill:<名字>` 仍可显式调用 |
| 插件贡献 | 扩展白名单：未选中扩展的工具不激活、包内 skill 不广告、包内提示词模板被拦截。扩展本身不会被卸载，见[限制](#限制pi-的能力边界) |
| Profile | 工具集 + 提示词预设 + 技能白名单 + 插件白名单，命名后持久化到 `~/.pi/agent/launch-profiles.json` |

## 启动行为

**每次启动都从 pi 的默认状态开始**：`defaultTools` 决定的默认工具集（含 `codemode`）＋ pi 内置系统提示词。
保存的 profile 不会被隐式套用——过期的 profile（例如工具集为空、提示词为空的那种）不会再把会话弄成"只剩 `codemode`、没有系统提示词"。

profile 只在明确要求时才生效：

1. CLI flag `--lp-profile <名字>`
2. 会话内命令 `/pprofile <名字>`、`/ppick`，或快捷键 `ctrl+shift+l`
3. 想恢复旧行为（自动沿用），在设置里打开 `launchPicker.startup`

`launchPicker.startup` 取值：

| 值 | 含义 |
|---|---|
| `"default"`（默认） | 每次都从 pi 默认工具集 + 内置提示词开始 |
| `"session"` | 会话记录里存过 profile 就恢复它（`/resume` 后仍生效），否则默认 |
| `"last"` | 旧行为：会话记录 > profiles 文件里的 `last` > 真 TUI 时弹选择器 |

```json
{ "launchPicker": { "startup": "last" } }
```

## 命令

| 命令 | 作用 |
|---|---|
| `/ppick` | 打开交互式选择器（profile → 工具多选 → 插件多选 → 技能多选 → 提示词预设） |
| `/pprofile [名字]` | 套用 profile 并持久化为 `last`；不带参数开选择器；`(none)` 清除回默认 |
| `/pprompt [名字]` | 切换系统提示词预设；不带参数开选择器 |
| `/ptools <spec>` | 设定激活工具：`all` / `none` / `read,bash,edit` 这样的逗号列表；`+todo,-bash` 相对当前状态增删 |
| `/pskills <spec>` | 设定技能白名单：`all` / `none` / `docx,pdf`；`+pdf,-docx` 相对当前状态增删；不带参数在 TUI 开多选 |
| `/pplugins <spec>` | 设定插件白名单：`all` / `none` / `pi-lens,builtin:codemode`；`-pi-lens` 相对当前状态增删；不带参数在 TUI 开多选 |
| `/psave <名字>` | 把当前工具集 + 提示词 + 技能 + 插件存成 profile |
| `/pstate [prompt]` | 查看当前状态：工具数、技能生效数、插件白名单、提示词预设与字符数；带 `prompt` 输出提示词全文 |
| `/pexport` | 把当前生效的系统提示词写到工作目录，文件名 `system-prompt-<YYYYMMDD-HHMMSS>.md` |

快捷键 `ctrl+shift+l` 打开选择器。

## 自定义系统提示词预设

在 `~/.pi/agent/system-prompts/` 放 Markdown 文件，文件名即预设名：

```
~/.pi/agent/system-prompts/chat.md        ->  预设 "chat"
~/.pi/agent/system-prompts/research.md    ->  预设 "research"
```

配合 `(empty)` 可以做出"完全没有系统提示词"的会话，此时发给模型的只有用户消息（工具 schema 仍随 API 的 `tools` 参数传递）。

## 技能与插件

### 技能白名单

`skills` 决定 pi 往 system prompt 的 `<available_skills>` 里广告哪些 skill。白名单本身只影响"模型自动挑选"这一层：名单外的 skill 不再出现，但 `/skill:<名字>` 仍可显式加载（被禁插件的包内 skill 除外，见下）。`disable-model-invocation: true` 的 skill 依旧按 pi 的规则不广告。

`skills` 省略 = 不动当前白名单（新会话从"全部"开始）；`[]` = 一个都不广告。自定义提示词预设下同样生效：预设会整体覆盖 pi 的提示词，本扩展会把允许的 skills 块重新拼在预设后面（`(empty)` 除外）。

### 插件白名单

`extensions` 列出这次会话允许贡献内容的扩展。未选中的扩展会被剔除：

| 贡献物 | 处理 |
|---|---|
| 工具 | 不进入激活集，`/ptools` 也设不上 |
| 包内 skill | 不广告，`/skill:<名字>` 被拦截并提示 |
| 包内提示词模板 | `/模板名` 被拦截并提示 |
| 工具自带的 prompt guideline | 随工具一起消失，因为它只对激活工具生效 |

插件 id 按来源有三种形式，也接受短名：

```
npm:pi-lens
git:github.com/fenlyin0420/pi-todo          （@dev 之类的 ref 后缀可省略）
builtin:codemode   builtin:mcp
pi-launch-picker                            （本地扩展文件或目录名）
```

`extensions` 省略 = 不动当前白名单（新会话从"不限制"开始）；`[]` = 只剩 pi 内置工具。

### 字段冲突时

`extensions` 优先，冲突按"剔除未选中插件"处理，不会反向把插件加回来：

| 写法 | 结果 |
|---|---|
| `tools` 里写了被禁插件的工具 | 该工具不激活；应用 profile 时 warning `tools from disabled plugins skipped: …` |
| `skills` 里写了被禁插件的包内 skill | 不广告；warning `Skills from disabled plugins skipped: …`。名字仍保留在白名单里，之后 `/pplugins all` 重新启用该插件，它会自动恢复 |
| `extensions` 省略，但之前已有白名单生效 | 沿用之前那份白名单（"省略 = 不动"），新 profile 的 skills 同样受它限制 |

状态栏显示 `skills:生效/名单`（两者相同时省略分母）和 `plugins:数量`。

### 限制（pi 的能力边界）

- **扩展不能运行时卸载**：pi 只在进程启动和 `/reload` 时按 settings 加载扩展。白名单只过滤贡献物，扩展自己的命令、事件 hook、后台行为仍然在跑。
- **扩展命令拦不住**：pi 先执行 extension command，再进 `input` 钩子，所以被禁插件的 `/命令` 仍可用；能拦的只有 skill 命令和提示词模板。
- **扩展注入的 prompt section 无法归属**：扩展通过 `before_agent_start` 往 system prompt 加的 section 不带来源，因此不会被剔除。
- **本地 skill 没有插件来源**：`~/.agents/skills/`、`.agents/skills/` 等非包安装的 skill 只能用 `skills` 白名单控制。
- **打开白名单不会恢复工具**：`/pplugins all` 只解除限制，之前被剔除的工具需要 `/ptools` 重新选择。

## Profile 文件

`~/.pi/agent/launch-profiles.json`：

```json
{
  "last": "lean",
  "profiles": {
    "clean": { "tools": [], "prompt": "(empty)" },
    "dev": { "tools": ["read", "bash", "edit", "write"], "prompt": "(default)" },
    "lean": {
      "tools": ["read", "bash", "edit", "write", "todo"],
      "prompt": "(default)",
      "skills": ["docx", "pdf"],
      "extensions": ["pi-todo", "builtin:codemode"]
    }
  }
}
```

| 字段 | 省略时 | 空数组 `[]` |
|---|---|---|
| `tools` | 不动工具集 | 关闭全部工具 |
| `prompt` | 不动提示词预设 | —（关提示词用 `"(empty)"`） |
| `skills` | 不动技能白名单；新会话从"全部"开始 | 一个都不广告 |
| `extensions` | 不动插件白名单；新会话从"不限制"开始 | 只剩 pi 内置工具 |

`last` 只记录"上次套用过谁"，默认启动不会自动套用它（见[启动行为](#启动行为)）。

### 相对列表（`+` / `-`）

列表默认是绝对语义：把当前选择整体换成列表内容。只要有一个条目带 `+`/`-` 前缀，整份列表就变成相对「套用时的当前状态」增删：

| 写法 | 结果 |
|---|---|
| `"tools": ["+todo", "-bash"]` | 当前激活工具加上 `todo`、去掉 `bash`，其余不动 |
| `"skills": ["-docx"]` | 全部 skill 去掉 `docx` |
| `"extensions": ["-pi-lens"]` | 允许的插件里去掉 `pi-lens` |

- 相对基准就是套用那一刻的状态：新会话即 pi 默认工具集、全部 skill、不限制插件。所以 `"skills": ["-docx"]` 等于"全部减去 docx"，而未设白名单时 `"+docx"` 不产生任何限制。
- 结果是「全部」时收敛成默认值：剩余 skill 等于全部就存成"全部"，剩余插件等于全部就存成"不限制"。
- 同一个列表里混用普通名字和 `+`/`-` 条目视为歧义：整个 profile 不套用并报错，会话状态保持原样。
- 增删仍受 `extensions` 白名单约束：被禁插件的工具/skill 加不进来（warning），`-` 一个不存在的名字也只 warning。
- `/psave` 永远写绝对列表：套用相对 profile 后再保存，得到的是当时状态的完整快照。

## RPC / app 集成

命令本身就是普通的 slash command，通过 RPC 的 `prompt` 消息即可调用：

```json
{"type":"prompt","message":"/ptools none"}
{"type":"prompt","message":"/pprompt (empty)"}
{"type":"prompt","message":"/pskills docx,pdf"}
{"type":"prompt","message":"/pplugins pi-todo,builtin:codemode"}
{"type":"prompt","message":"/psave chat"}
{"type":"prompt","message":"/pstate"}
{"type":"prompt","message":"/pexport"}
```

执行结果以 notify 形式返回（`extension_ui_request` 的 `method: "notify"`）。

注意：

- 命令要作为整条消息发送，斜杠命令才会被拦截执行。
- `ui.select` / `ui.input` 对话框会降级成 `extension_ui_request`，由客户端回 `extension_ui_response`；但工具、插件、技能多选用的是 `ui.custom`，非 TUI 环境取不到，应改用 `/ptools` + `/pplugins` + `/pskills` + `/pprompt` + `/psave` 组合。
- 想要启动即干净：`pi --mode rpc --lp-profile clean`，全程无对话框。

## 与内置 flag 的关系

pi 自带 `--system-prompt`、`--tools`、`-ns`、`-ne` 等一次性开关，本扩展补的是**可交互、可持久化、可远程调用**的那一层。两者不冲突：flag 决定进程初始状态，本扩展在此之上覆盖工具集与提示词，并把选择记住。

## 开发

```bash
npm install --ignore-scripts
npm run check
```
