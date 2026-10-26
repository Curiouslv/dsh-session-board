# dsh-session-board

DSH Desktop（DeepSeek Harness）的**会话看板**插件：右下角一颗可拖拽的悬浮球，展开后一览所有工作区的活跃会话——谁在运行、在想什么、等谁审批、上下文烧了多少，点击直达会话。

> 仅研究用途，不构成任何投资或消费建议；quota 校准为本地估算。

## 功能

- **实时看板**：跨工作区列出所有会话（运行中 / 等待审批 / 失败 / 空闲），悬浮球呼吸灯与角标提示
- **实时思考预览**：运行中的会话直接显示最新 assistant 内容（含流式思考文本），随会话同步刷新
- **点击直达会话**：点任意一行跳进该会话，不用翻列表
- **上下文用量**：每行灰色圆环 + 上下文占比 + 累计 token 消耗（含缓存读写）
- **coding plan 配额校准**（火山方舟按次限额）：输入控制台百分比 + 剩余时间，本地自动反推配额，百分比随请求实时增长；剩余时间以琥珀色圆环倒计
- **DeepSeek 余额**（可选）：安装 [dsh-usage](https://github.com/) 插件后自动显示 API 余额
- **可拖拽悬浮球**：位置持久化；面板内一键清除空闲会话

## 安装

前提：已安装 DSH Desktop。插件零 npm 依赖，只需挂进 profile。

```bat
git clone https://github.com/Curiouslv/dsh-session-board.git
```

编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

```jsonc
{
  "dependencies": {
    // 新增：link 指向 clone 出来的目录
    "dsh-session-board": "link:C:/path/to/dsh-session-board"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // 新增：
        "dsh-session-board"
      ]
    }
  }
}
```

创建 junction 并重启 DSH：

```bat
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-board" "C:\path\to\dsh-session-board"
```

（或在 profile 目录里跑 `pnpm install` 代替手动 mklink。）重启后在桌面端右下角即可看到悬浮球。

### 用 DSH CLI 安装（更简单）

本插件声明了 `dsh.bundle` 清单，可用官方 CLI 直接安装（具体参数以 `dsh plugin add --help` 为准）：

```sh
dsh plugin --profile desktop add https://github.com/Curiouslv/dsh-session-board
```

## 使用

| 操作 | 说明 |
|---|---|
| 点击悬浮球 | 展开 / 收起看板 |
| 拖拽悬浮球 | 任意位置，自动记忆 |
| 点击行 | 跳转到对应会话 |
| 行右侧 × | 隐藏该行；失败行同时清除该错误（会话恢复活动时自动回来） |
| 清除空闲 | 隐藏空闲行并清除失败状态，悬浮球恢复常色 |

### 近 5 小时用量统计

面板头部的 ⚡ 徽标显示火山方舟 Coding Plan 近 5 小时滚动窗口的实际用量：

- **请求次数**（每次模型调用 +1）
- **token 消耗**（输入 + 输出 + 缓存读写）

数据按「每次模型调用」本地统计，窗口持久化到 `~/.dsh/dsh-usage/session-board-window.json`，重启不清零。悬停可看统计口径说明。

## 可选依赖

- `@linxin666/dsh-usage` —— 提供DeepSeek API 余额数据（`~/.dsh/dsh-usage/provider-snapshots.json`）；未安装时余额徽标自动隐藏，其余功能不受影响

## 已知限制

- **上下文窗口表**：`index.js` 中的 `MODEL_CONTEXT` 按模型名列出上下文大小（默认覆盖常见模型）。你的模型不在表里时，圆环百分比不显示、token 数照常——欢迎按需补充
- **请求计数口径**：按「每次模型调用」计数。若厂商按用户轮次计数，百分比增速会与控制台略有偏差，重新校准即可对齐
- **流式粒度**：思考预览随会话表面更新；若长思考期间表面不刷新，预览会在步边界跳变
- 火山校准逻辑匹配 provider id 含 `volc` 的会话，其他厂商不受影响

## License

[MIT](./LICENSE)
