# dsh-qq

让我（DSH 里的 Agent）在 **QQ** 上发消息、在群里**自动接话**，并带一个**网页面板**管理。Host 半边，走本机 NapCat 的 OneBot 11 接口。

## 三块东西

| 部分 | 地址 | 作用 |
| --- | --- | --- |
| 工具 | （Agent 直接调用） | 发消息、读历史、自动接话开关 |
| 事件入口 | `http://127.0.0.1:3012/` | 收 NapCat 的 httpClients 推送 |
| 管理面板 | **`http://127.0.0.1:3014/`** | 人设、白名单、用量、扫码登录 |

## 侧边框（DSH 界面内）

刷新一次页面后，左侧栏会出现 **QQ 图标**（sidebar.panellist + main 两个 Slot）：

- 点图标 → 中间区域就是完整面板（iframe 指向 /qq-panel/?embed=1，和网页版是同一份页面，只是去掉了左侧竖栏、导航变顶部横排）。
- 面板顶部的细工具栏有「刷新」和「在浏览器打开」。
- 同一份页面也挂在 DSH Web 服务上（/qq-panel），所以内嵌时走同源；万一同源路由被拦，5 秒没收到 ready 信号会自动退回直连 127.0.0.1:3014。

**不想多挂一个侧边框**：设置 → 「QQ 消息」→ 关掉「在侧边栏显示 QQ 面板」。这会把图标和面板一起卸载（不是隐藏空占位），只留网页版；同一页里还有「打开网页面板」按钮。开关状态存在 data/admin.json 的 panelEnabled，刷新后仍生效。

## 工具

| 工具 | 作用 |
| --- | --- |
| `qq_status` | 体检：后端连通性、端口监听、登录 QQ 号与昵称、在线状态、后端版本、延迟 |
| `qq_send_private` | 按 QQ 号发私聊 |
| `qq_send_group` | 按群号发群聊，可选 `atUserIds` @ 人 |
| `qq_history` | 读好友/群最近消息、最近会话与未读数 |
| `qq_backend` | 查端口；提权启动 NapCat |
| `qq_bot` | 自动接话：status / on / off / test（带面板地址） |

## 网页面板

打开 `http://127.0.0.1:3014/`（桌面上还有「QQ 管理面板.url」快捷方式）。

- **顶栏**：QQ 头像 + 昵称 + QQ 号 + 连接状态点。已连接=绿点；后端在线但没登录=黄点（右侧出现「扫码登录」）；后端没起=红点（右侧出现「启动后端」）。
- **启动后端**：点一下会提权拉起 NapCat，并**等 OneBot 端口起来**（最多 45 秒，接口返回真实结果）；起来后如果发现没登录，会**自动弹出扫码登录框**，已登录则直接提示账号。
- **扫码登录**：点「扫码登录」会向 NapCat WebUI 要二维码（重试 4 次，NapCat 刚启动时 WebUI 可能还没就绪）；拿到 cache/qrcode.png 就显示，接口失败但磁盘上有图也会显示并标注可能过期；二维码 60 秒自动换一次，登录成功自动关。实在拿不到就提示去看 NapCat 控制台窗口里的二维码。
- **概览**：今日回复 / 今日 Token / 监听群 / 监听账号 + 最近决策流 + 运行状态（事件数、限流、模型、后端版本）+ 快捷操作。
- **人设**：直接编辑 persona 提示词（留空=内置代聊人设），保存即生效；右侧「试说一句」用真实模型生成预览，不会发到群里。
- **白名单**：监听群 + 监听账号两组名单（与关系：群和人都命中才处理；都空=全部）。名单外的群/人连上下文都不进。
- **用量**：今日调用次数、输入/输出 token、近 7 天柱状图、今日模型分布。数字来自每次请求返回的 usage。
- **设置**：闲聊接话概率、同群冷却、回复长度、每群/全局每小时上限、上下文条数、触发词（静默）。

面板只监听 `127.0.0.1`，配置和用量落在 `dsh-qq/data/admin.json`（改完立即覆盖到运行时，不用重启）。

## 自动接话怎么工作

```
群消息 ──NapCat httpClients──▶ POST http://127.0.0.1:3012/event
                                     │
                              engine.handleEvent
                                     │  ① 白名单 + 触发判定
                     @我 / 叫到名字 / 闲聊概率 + 问题句
                                     │  ② 组 prompt（人设 + 最近 N 条上下文）
                       宿主 llm 服务（DeepSeek 默认模型，无需额外 key）
                                     │  ③ 清洗 + 拟人延迟 + send_group_msg + 记用量
                                     ▼
                                  群里看到一句话
```

- **触发**：被 @ 必回；文本含 `aliases`（小白/机器人/小助手）或账号昵称必回；其余按概率只捡问句。
- **拟人**：限长（默认 80 字）、按字数算 0.7–5 秒「打字时间」+ 抖动、同群串行。
- **限流**：每群每小时 8 条、全局 30 条、同群冷却 25 秒（被点名 8 秒）。

## 配置（`cordis.patch.yml` 的 config）

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:3000` | OneBot HTTP 根地址 |
| `accessToken` | — | 与 NapCat `onebot11_<uin>.json` 的 `token` 一致 |
| `launcherPath` / `loginAccount` | NapCat 路径 / QQ 号 | `qq_backend start`、面板「启动后端」用 |
| `eventPort` | `3012` | 事件监听端口（改完要同步改 NapCat httpClients 并重启 NapCat） |
| `eventToken` | 空 | **必须空**：NapCat httpClients 不发 Authorization |
| `adminPort` | `3014` | 面板端口 |
| `napcatWebuiUrl` / `napcatWebuiConfig` | `127.0.0.1:6099` / `webui.json` | 面板读 token 走 WebUI 接口（登录状态 / 二维码） |
| `qrcodePath` | `D:\WenJian\NapCat\cache\qrcode.png` | 扫码登录时面板直接回这张图 |
| `groups` / `watchUsers` | `['1017271626']` / `[]` | 白名单（面板里改更直观，会存进 data/admin.json） |
| `persona` / `aliases` / `chatChance` / `cooldownSec` / … | 见 `lib/config.js` | 面板里都能改 |

## 后端（NapCat）怎么起

1. QQNT 9.9.33（`C:\Program Files\Tencent\QQNT`）+ NapCat.Shell 4.18.41（`D:\WenJian\NapCat`）。
2. 管理员运行 `launcher.bat 1766131793`（带 QQ 号走快速登录，首次仍需扫码）。
3. `onebot11_<QQ号>.json` 需要：`httpServers`（3000 + token）、`httpClients`（`http://127.0.0.1:3012/event`，`reportSelfMessage:false`）。

## 踩过的坑

- **改插件代码后**要 `remove_bundle` + `install_bundle`（ESM 缓存；单纯 reinstall 报 already-installed）。**只改面板 HTML 不用重启**，刷新页面即可。
- 事件监听器和面板服务都挂在 `globalThis`（`Symbol.for('dsh-qq.host')`）上整进程只建一次，面板每个请求现取 `cfg/store/engine`，所以热重载不会拿到旧对象、也不会占住端口。改端口要重启 DSH 才彻底生效。
- NapCat 的 `httpClients` **不发 Authorization**，`eventToken` 必须留空（否则每个事件 401）。
- NapCat WebUI 认证是两步：`POST /api/auth/login {hash: sha256(token+'.napcat')}` → 拿 `Credential`，再 `Authorization: Bearer <Credential>`。token 在 `config/webui.json`。
- 回复消耗自己的 DeepSeek 额度（默认 `deepseek-flash`）。
- 关掉 NapCat 控制台窗口 = 机器人下线；面板顶栏会变红点。
