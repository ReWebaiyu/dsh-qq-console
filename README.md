# DP0.0.1

个人 DSH（DeepSeek Harness）插件开发目录的 Git 备份 + 公开发布。

## 内容

| 目录 | 说明 |
| --- | --- |
| `dsh-qq/` | **dsh-qq**：让 DSH 在本机 QQ 上收发消息的插件（发送私聊/群聊、查询历史与未读数、自动接话、网页管理面板），通道为 NapCat（QQNT + OneBot 11 HTTP）。 |
| `scratch/` | 开发过程里的临时自测脚本与输出（跑 `qq_*` 工具、验证事件推送、压测管理面板等），不是插件的一部分。 |

## dsh-qq 快速开始

1. 安装并登录 NapCat（QQNT + NapCat.Shell），开启 OneBot 11 HTTP 服务（默认 `http://127.0.0.1:3000`）。
2. 把插件装进 DSH profile（`dsh.profile.bundles` 里登记，或以 link 方式安装）。
3. 准备配置：复制 `dsh-qq/cordis.patch.example.yml` 为 `dsh-qq/cordis.patch.yml`，
   把 `accessToken` / `groups` / `launcherPath` / `loginAccount` 换成自己的值。
   （真实配置含 token，已被 `.gitignore` 排除，不会出现在本仓库里。）
4. 重启 DSH，工具面板出现 `qq_status` / `qq_send_private` / `qq_send_group` / `qq_history` / `qq_backend` / `qq_bot`。

细节（配置项、自动接话的触发规则与限流、事件推送怎么配、面板端口）见 [`dsh-qq/README.md`](dsh-qq/README.md)。

## 说明

- 仓库里只有源码和模板，不含任何 token、QQ 号或群号。
- `scratch/` 里的脚本会真的去连本机的 127.0.0.1 服务，跑之前先确认后端已启动。

## License

MIT
