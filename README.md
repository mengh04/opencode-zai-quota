# opencode-zai-quota

OpenCode TUI 侧边栏的智谱（Z.AI）coding-plan 额度插件：在 `sidebar.content` 末尾追加一个"智谱额度"块，显示 5 小时滚动、每周、每月三个计量窗口的已用百分比、进度条与重置倒计时。用量 ≥60% 变警告色，≥85% 变危险色。API key 只留在本机 TUI 进程内，不进入任何网络日志。

在 OpenCode v2.0.24 上开发验证。侧边栏渲染效果：

```
智谱额度

5小时 ██░░░░░░░░  18% · 4h
本周  ███░░░░░░░  31% · 2d
月度  █████░░░░░  47% · 13d
```

本仓库不含任何密钥。安装时从目标机器自己的 OpenCode 凭据存储里读取，见下文。

## 给 AI 的安装指南

你（AI 代理）正要在某台机器上安装本插件。按顺序执行以下步骤，不要跳步。所有命令都在目标机器上执行。

### 前置检查

1. 确认 OpenCode 已安装且为 v2：`opencode --version` 输出应为 `v2.x.x`。没有就先装 OpenCode，终止本流程。
2. 确认用户已登录智谱 coding-plan（即 `opencode.db` 的 `credential` 表里有对应行）：

   ```sh
   sqlite3 -readonly ~/.local/share/opencode/opencode.db \
     "select count(*) from credential where integration_id = 'zai-coding-plan';"
   ```

   输出非 `0` 即已登录。若为 `0`，让用户先运行 `opencode auth login` 完成登录，或让用户手动提供 apiKey 后跳到第 2 步的备选分支。

### 第 1 步：取出 apiKey

额度接口和模型提供方用同一把 key，直接复用本机凭据存储：

```sh
sqlite3 -readonly ~/.local/share/opencode/opencode.db \
  "select value from credential where integration_id = 'zai-coding-plan';" \
| jq -r '.key'
```

`credential.value` 是形如 `{"type":"key","key":"…"}` 的 JSON，`.key` 字段即所需 key（53 字符，中间含一个 `.`）。记下它的值，第 3 步要用。

- 没有sqlite3 或 jq 时，用 python3 等价实现：连 `~/.local/share/opencode/opencode.db`，执行同一 SQL，`json.loads(value)["key"]`。
- 都失败时：让用户手动粘贴 key。用户可以在已装好的机器上执行 `jq -r '.plugins[0].options.apiKey' ~/.config/opencode/cli.json` 取出。
- key 属于用户凭据：写入目标机器配置即可，不要打印到日志、聊天记录或任何仓库文件。

### 第 2 步：放置插件文件

```sh
mkdir -p ~/.config/opencode/lib/zai-quota
```

把本仓库 `plugin/` 目录下的全部文件（`package.json`、`index.ts`、`tui.tsx`）复制到上面的目录。若本仓库已 clone 到目标机器：

```sh
cp <仓库路径>/plugin/* ~/.config/opencode/lib/zai-quota/
```

**不要**在插件目录里运行 `npm install` / `pnpm install`，也不需要构建：`@opencode/plugin`、`@opentui/*`、`solid-js` 全部由 OpenCode 运行时自带，目录里有 `node_modules` 反而可能引起版本冲突。

### 第 3 步：注册到 cli.json

编辑 `~/.config/opencode/cli.json`（没有就创建）：

1. **先读现有内容**（如有）。文件里通常已有 `keybinds`、`theme` 等字段，可能已有 `plugins` 数组——全部原样保留，只做合并，**禁止整体覆盖**。
2. 确保存在 `$schema` 字段，值为 `"https://opencode.ai/v2/cli.json"`。
3. 在 `plugins` 数组中追加一项（数组不存在则创建）：

   ```json
   {
     "package": "/home/<该机器用户名>/.config/opencode/lib/zai-quota",
     "options": { "apiKey": "<第 1 步取出的 key>" }
   }
   ```

4. `package` 必须是**目标机器上的绝对路径**：以本机 `$HOME` 展开写入，禁止照抄文档或别的机器上的 `/home/xxx`。

改完后校验 JSON 合法（`jq . ~/.config/opencode/cli.json`）并确认原有字段一个不少。

### 第 4 步：重启并验证

```sh
opencode service restart
```

然后启动 `opencode` TUI，检查：

- 侧边栏出现"智谱额度"块，带三条进度条 → 安装成功。
- 弹 toast `zai-quota: 未配置 apiKey，插件未启动` → 第 3 步的 `options.apiKey` 没写对。
- 显示"读取失败：HTTP 401/403" → key 无效，回第 1 步重新取。
- 侧边栏完全没有该块 → 检查 `package` 路径是否存在、`plugins` 数组位置是否在 `cli.json` 顶层；再看 `~/.local/share/opencode/log/opencode.log` 里的插件加载报错。

### 卸载

1. 从 `cli.json` 的 `plugins` 数组里删掉 `package` 以 `lib/zai-quota` 结尾的那一项（其余项保留）。
2. `rm -rf ~/.config/opencode/lib/zai-quota`
3. `opencode service restart`

## 配置项

全部可选，写在 `plugins` 条目的 `options` 里（与 `apiKey` 同级）：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | 必填 | coding-plan API key，Bearer 凭据 |
| `endpoint` | `https://open.bigmodel.cn/api/monitor/usage/quota/limit` | 额度查询端点 |
| `timeoutMs` | `10000` | 单次请求超时 |
| `cacheMs` | `60000` | 一次成功读数复用时长 |
| `refreshMs` | `300000` | 自动刷新间隔（下限 30000） |
| `showLevel` | `false` | 标题里是否显示套餐档位（如 `pro`） |
| `barWidth` | `12` | 进度条宽度，4–30 字符 |

## 原理

- `plugin/index.ts` 是服务端半边的空壳，只为让包有主入口；所有工作在 `plugin/tui.tsx`，它跑在终端进程里。
- `tui.tsx` 通过 `@opencode/plugin/tui` 的 `ui.slot({ append: "sidebar.content" })` 注册渲染块，按 `(unit, number)` 识别 5 小时滚动与每周窗口（`unit=3,number=5` / `unit=6,number=1`），按 `type=TIME_LIMIT` 识别月度 MCP 窗口，线格式与 `dsh-zai-quota`（DeepSeek Harness 版同名插件）一致。
