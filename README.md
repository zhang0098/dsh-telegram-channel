# dsh-telegram-channel（martty 兼容 fork）

> **项目由来**：本仓库 fork 自 [hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)（MIT，版权归上游 contributors，见 [LICENSE](LICENSE)）。
>
> **fork 原因**：原版在 Martty Host（`dsh --profile martty`）上无法启动——它硬声明 `inject: ['agents', 'apiProxy']`，而 `apiProxy` 只有 web profile（`dsh-host-apiproxy`）提供；Cordis 的 inject 全为必选，fiber 永久 pending，启动报 `1 entry did not activate`（[openma-ai/Martty#46](https://github.com/openma-ai/Martty/issues/46)）。
>
> **差异**：不再 inject `apiProxy`（改运行时探测）；`/model` 无 apiProxy 时回退到 `ctx.llm` + `installModelSelection` 本地路径；依赖对齐 rc.8。**web profile 行为与上游一致**。上游修复后本 fork 可同步或退役。

Telegram 手机遥控器 for DeepSeek Harness：附着本机会话，手机 ↔ 电脑同轨迹、双向可见。

## 安装

```bash
# web profile（完整会话目录，走 apiProxy，同上游）
dsh plugin --profile web add github:zhang0098/dsh-telegram-channel

# martty profile（列运行中的本机会话，/model 走本地）
dsh plugin --profile martty add github:zhang0098/dsh-telegram-channel
```

环境变量（或 config）：`DSH_TELEGRAM_TOKEN`、`DSH_TELEGRAM_ALLOWED_USER_IDS`（数字白名单，可逗号分隔）。

## 使用

- `/sessions` → 选工作区 → 选会话 → 附着；之后手机发文字即进入该会话（与电脑同轨迹）
- 宿主询问（ask_user_question / plan review）**双渠道镜像**：绑定后问题同时出现在 Telegram 与电脑 TUI/Web，任一渠道回答即生效（先答者胜）
- `/last` 查看上次问答；`/model` 切换模型（下一回合生效）；`/status` 查看绑定；`/unbind` 断开（不关电脑会话）；`/help` 帮助
- martty 下 `/sessions` 只列**运行中**的会话；冷会话需先在 TUI 打开
- 一键管理脚本：`scripts/install.ps1`（Windows）/ `scripts/install.sh`（Unix），`-ProfileName martty` 指定 profile

## 配置

| 键 / 环境变量 | 含义 |
|---|---|
| `token` / `DSH_TELEGRAM_TOKEN` | Bot token |
| `allowedUserIds` / `DSH_TELEGRAM_ALLOWED_USER_IDS` | 白名单；都空 = 谁都不能用 |
| `allowAllUsers` | `true` 仅调试 |
| `maxMessageLength` | 默认 4096 |
| `pollingTimeoutSec` | 默认 30 |
| `rendering` | `rich`（默认）或 `html` |

## 开发

```bash
pnpm install
pnpm test
pnpm run build
```

## License

MIT（上游 hi-wenw 及 fork 贡献者）

---

## English (summary)

Fork of [hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel) (MIT) to run on the Martty / ACP host (`dsh --profile martty`): the upstream hard-injects `apiProxy`, a web-profile-only service, which parks the Cordis fiber forever (`1 entry did not activate`, see [openma-ai/Martty#46](https://github.com/openma-ai/Martty/issues/46)). This fork probes `apiProxy` at runtime, adds a local `/model` fallback over `ctx.llm`, and keeps web-profile behavior identical.

```bash
dsh plugin --profile web add github:zhang0098/dsh-telegram-channel
dsh plugin --profile martty add github:zhang0098/dsh-telegram-channel
```

Bot commands: `/sessions` (workspace → session → bind), plain text = followup, `/last`, `/model`, `/status`, `/unbind`, `/help`. Env: `DSH_TELEGRAM_TOKEN`, `DSH_TELEGRAM_ALLOWED_USER_IDS`.
