# agy-xiaozhi-notifier

**Google Antigravity 原生语音播报插件** —— 监听 Antigravity 原生 `Stop` 生命周期钩子，自动识别并过滤内部子代理与 `run_workflow` Worker，仅在主对话任务完成、异常中断或达到步数上限时，通过本机 **GPT-SoVITS（`19880`）** + **[小智 Windows PC 音频桥接（`18900`）](https://github.com/zou172866/xiaozhi-windows-pc-mcp)** 主动开口播报。

> 零第三方云依赖 · 零 npm 外部依赖（纯 Node.js 24 原生 API + `node:sqlite`）· 无黑框静默后台运行 · 离线真语音缓存兜底

## 工作原理

```text
Antigravity 主对话结束 (Stop Hook, fullyIdle=true)
  └─ hooks/on-stop.mjs (<50ms 立即返回 {"decision":"allow"}，绝不阻塞 Agent)
       └─ 后台静默拉起 hooks/speak-worker.mjs (windowsHide: true)
            ├─ 查 conversation_summaries.db → 静默跳过子代理 / run_workflow Worker
            ├─ 跨进程文件锁 + 4s 去重 → 防并发叠音与重复提醒
            ├─ 调本机 19880 GPT-SoVITS /tts → 动态按任务主题与情绪合成语音
            │    └─ 19880 离线时自动播放 cache/fallback_{done,error,limit}.wav 真人语音缓存
            └─ 优先推 18900 /audio/play (Bearer 鉴权 WinMM) → 离线自动降级无黑框 SoundPlayer
```

## 快速安装（Windows）

需要 **Node.js 24+**（内置 `node:sqlite`）以及 Antigravity 桌面端 / IDE。

```powershell
git clone https://github.com/zou172866/agy-xiaozhi-notifier.git
cd agy-xiaozhi-notifier
.\install.ps1 -XiaozhiServerDir "D:\path\to\xiaozhi-server"
```

`install.ps1` 会将插件安装到 `%USERPROFILE%\.gemini\config\plugins\agy-xiaozhi-notifier`：
- 首次安装自动从 [config.example.json](config.example.json) 生成 `config.json` 并填入你的 `xiaozhi-server` 路径；
- 重复运行更新代码时**自动保留**已有的 `config.json` 与 `cache/*.wav`；
- 安装完成后可在 Antigravity 的 **Customizations / Plugins** 页面一键开关。

## 预生成离线真语音缓存（推荐）

当你本机 `19880` GPT-SoVITS 处于运行状态时，执行一次预缓存命令即可在 `cache/` 下生成 3 条本地 48kHz WAV（`fallback_done.wav` / `fallback_error.wav` / `fallback_limit.wav`）；之后**即使关闭 `19880` GPU 服务，反重力任务完成依然能用真实角色声音开口提醒**：

```powershell
node "$env:USERPROFILE\.gemini\config\plugins\agy-xiaozhi-notifier\hooks\speak-worker.mjs" --precache
```

手动试播一句：

```powershell
node "$env:USERPROFILE\.gemini\config\plugins\agy-xiaozhi-notifier\hooks\speak-worker.mjs" --test-text "检查云端测试状态"
```

## 配置说明（`config.json`）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启用播报 |
| `ignoreSubagents` | `true` | 通过 `conversation_summaries.db` 自动过滤子代理与 `run_workflow` Worker |
| `xiaozhiServerDir` | `""` | 本地 `xiaozhi-server` 目录（用于读取 `voices/raiden_mei/mei_emotions.json` 与 `secrets/pc_mcp_token.txt`；也可通过环境变量 `XIAOZHI_SERVER_DIR` 指定） |
| `gsvBaseUrl` | `http://127.0.0.1:19880` | 本地 GPT-SoVITS API 地址 |
| `pcMcpBaseUrl` | `http://127.0.0.1:18900` | 本地小智 PC 音频桥接地址 |
| `volume` | `1.0` | 播报音量（`0.1`～`1.8`） |
| `sampleSteps` | `8` | GPT-SoVITS 采样步数（`8` 兼顾低延迟与音质） |
| `addressPrefix` | `""` | 可选自定义称呼前缀（例如 `"哥哥，"`） |
| `doneEmotion` / `errorEmotion` / `limitEmotion` | `gentle` / `serious` / `calm` | 完成 / 异常 / 达上限对应的情绪音色 |
| `includeTaskTopic` | `true` | 是否从用户首句提炼简短中文任务主题读出 |
| `dedupeWindowMs` | `4000` | 同会话去重窗口（毫秒） |
| `toastCooldownMs` | `60000` | 离线且无语音缓存时的 Windows Toast 节流间隔（毫秒） |
| `toastAppId` | `electron.app.Antigravity` | Windows 通知中心注册的 Antigravity AppID |

## 本地测试

```bash
node --no-warnings --test tests/test-notifier.mjs
```

## 关联项目

- 配套服务端：[xiaozhi-windows-pc-mcp](https://github.com/zou172866/xiaozhi-windows-pc-mcp)

## License

[MIT](LICENSE)
