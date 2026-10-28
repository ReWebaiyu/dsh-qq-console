/**
 * dsh-qq 工具集：状态体检、发私聊、发群聊、读最近消息/未读、启停后端。
 *
 * 所有工具都返回结构化对象，并附带一段人读文本渲染；错误通过 throw 抛给 DSH，
 * 消息里带 OneBot retcode 的中文解释，便于模型自我纠正（例如号码写错、不是好友）。
 * @module dsh-qq/tools
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { OneBotClient, extractMessages, hostPortOf, messageToText, normalizeHistoryMessage, tcpProbe } from './onebot.js';

const objectSchema = { type: 'object', additionalProperties: true };

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function textRenderer(lines) {
  return (_args, value) => [{ type: 'text', text: lines(asRecord(value)).join('\n') }];
}

/** 把参数里的 QQ 号 / 群号解析成纯数字字符串。 */
function parseId(raw, label) {
  const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (value === '') throw new Error(label + '（必填）不能为空：请提供纯数字的 ' + label + '。');
  if (!/^\d{4,12}$/.test(value)) throw new Error(label + ' 必须是 4-12 位纯数字，收到的是「' + value + '」。');
  return value;
}

function parseCount(raw, fallback, max) {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.round(n));
}

function makeClient(cfg) {
  return new OneBotClient({ baseUrl: cfg.baseUrl, accessToken: cfg.accessToken, timeoutMs: cfg.timeoutMs });
}

function previewOf(text, limit = 60) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

/** 群消息里支持 @某人：把 atUsers 拼成 segment 前缀。 */
function buildMessage(text, atUsers) {
  const ids = Array.isArray(atUsers) ? atUsers.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v)) : [];
  if (ids.length === 0) return text;
  const segments = ids.map((qq) => ({ type: 'at', data: { qq } }));
  segments.push({ type: 'text', data: { text: ' ' + text } });
  return segments;
}

/**
 * 生成 dsh-qq 的全部工具定义。
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 * @param {{engine?: object, server?: object}} [extras] 自动回复引擎与事件监听（可选）
 */
export function buildQqTools(cfg, extras = {}) {
  const engine = extras.engine;
  const server = extras.server;
  const admin = extras.admin;
  const status = {
    name: 'qq_status',
    description:
      '检查 QQ 机器人后端（NapCat / OneBot 11）是否可用：连通性、登录账号（QQ 号与昵称）、在线状态、后端版本与延迟。发消息前或发送失败后先调它；返回 ok=false 时按 error/hint 排障（后端没启动、token 不对、还没扫码登录）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: objectSchema,
      render: textRenderer((v) => {
        const lines = [];
        const hp = v.host && v.port ? v.host + ':' + v.port : '';
        lines.push('QQ 后端：' + (v.reachable ? '可访问' : '不可访问') + '（' + v.baseUrl + '）');
        if (hp) lines.push('- 端口 ' + hp + '：' + (v.portOpen ? '监听中' : '未监听'));
        if (v.reachable) {
          lines.push('- 登录账号：' + (v.selfId ? v.selfId + (v.nickname ? '（' + v.nickname + '）' : '') : '未登录'));
          lines.push('- 状态：' + (v.online ? '在线' : '离线或未登录') + (v.good === false ? '（good=false，后端报告异常）' : ''));
          if (v.appName) lines.push('- 后端版本：' + v.appName + ' ' + (v.appVersion || '?') + (v.protocolVersion ? ' / OneBot ' + v.protocolVersion : ''));
          if (v.latencyMs !== null) lines.push('- 延迟：' + v.latencyMs + ' ms');
        }
        if (Array.isArray(v.errors) && v.errors.length > 0) lines.push('- 问题：' + v.errors.join('；'));
        if (v.hint) lines.push('- 建议：' + v.hint);
        return lines;
      }),
    },
    async execute() {
      const { host, port } = hostPortOf(cfg.baseUrl);
      const portOpen = await tcpProbe(host, port, 1200);
      const client = makeClient(cfg);
      const errors = [];
      let login = null;
      let runtime = null;
      let version = null;
      let latencyMs = null;

      const loginProbe = await client.probe('get_login_info');
      if (loginProbe.ok) {
        login = asRecord(loginProbe.data);
        latencyMs = loginProbe.latencyMs;
      } else {
        errors.push(loginProbe.error);
      }
      if (loginProbe.ok) {
        const statusProbe = await client.probe('get_status');
        if (statusProbe.ok) runtime = asRecord(statusProbe.data);
        else errors.push(statusProbe.error);
        const versionProbe = await client.probe('get_version_info');
        if (versionProbe.ok) version = asRecord(versionProbe.data);
      }

      const selfId = login && (login.user_id ?? login.userId) ? String(login.user_id ?? login.userId) : '';
      const nickname = login && typeof login.nickname === 'string' ? login.nickname : '';
      const reachable = loginProbe.ok;
      const hint = !portOpen
        ? '端口没在监听：后端进程没起来。用 qq_backend start 启动 NapCat，或在 NapCat 控制台启动并登录。'
        : !reachable
          ? '端口开着但 OneBot 请求失败：多半是 token 不匹配、HTTP 服务未启用，或还没扫码登录。'
          : selfId
            ? ''
            : '后端已连上但还没登录 QQ：在 NapCat 控制台扫码登录后再试。';

      return {
        ok: reachable && selfId !== '',
        reachable,
        portOpen,
        host,
        port,
        baseUrl: cfg.baseUrl,
        selfId,
        nickname,
        online: runtime ? runtime.online === true : null,
        good: runtime && typeof runtime.good === 'boolean' ? runtime.good : null,
        appName: version && typeof version.app_name === 'string' ? version.app_name : '',
        appVersion: version && typeof version.app_version === 'string' ? version.app_version : '',
        protocolVersion: version && typeof version.protocol_version === 'string' ? version.protocol_version : '',
        latencyMs,
        errors,
        hint,
      };
    },
  };

  const sendPrivate = {
    name: 'qq_send_private',
    description:
      '给一个 QQ 好友（或临时会话对象）发私聊消息。自动调用 OneBot 的 send_private_msg，返回 message_id。对象必须是数字 QQ 号；不是好友或对方关闭临时会话会失败（retcode=1200/103）。消息默认按纯文本发送，不会解析 CQ 码。发送后要确认的话，可用 qq_history 读最近消息。',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '目标 QQ 号（4-12 位数字），例如 "1766131793"。' },
        message: { type: 'string', description: '消息正文（纯文本）。换行会被 QQ 保留。' },
      },
      required: ['userId', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: textRenderer((v) =>
        v.ok
          ? ['已发送私聊 → ' + v.targetId + (v.nickname ? '（' + v.nickname + '）' : ''), '- message_id：' + v.messageId, '- 内容：' + v.preview, '- 延迟：' + v.latencyMs + ' ms']
          : ['发送失败：' + v.error],
      ),
    },
    async execute(args) {
      const raw = asRecord(args);
      const userId = parseId(raw.userId, 'QQ 号');
      const message = typeof raw.message === 'string' ? raw.message : '';
      if (message.trim() === '') throw new Error('消息内容不能为空（参数 message）。');
      const client = makeClient(cfg);
      const payload = await client.call('send_private_msg', { user_id: Number(userId), message, auto_escape: true });
      const data = asRecord(payload.data);
      return {
        ok: true,
        chat: 'private',
        targetId: userId,
        messageId: data.message_id ?? null,
        preview: previewOf(message),
        latencyMs: payload.latencyMs,
      };
    },
  };

  const sendGroup = {
    name: 'qq_send_group',
    description:
      '给一个 QQ 群发消息（需要机器人账号是该群成员）。调用 send_group_msg，可选 atUserIds 在正文前 @ 指定成员。返回 message_id。群号必须是数字；被禁言或不是群成员会失败。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '目标群号（数字）。' },
        message: { type: 'string', description: '消息正文（纯文本）。' },
        atUserIds: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：要在消息前 @ 的 QQ 号列表，例如 ["1061261631"]；留空表示不 @。',
        },
      },
      required: ['groupId', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: textRenderer((v) =>
        v.ok
          ? ['已发送群消息 → 群 ' + v.targetId, '- message_id：' + v.messageId, v.atUserIds.length > 0 ? '- @：' + v.atUserIds.join(', ') : '', '- 内容：' + v.preview, '- 延迟：' + v.latencyMs + ' ms'].filter(Boolean)
          : ['发送失败：' + v.error],
      ),
    },
    async execute(args) {
      const raw = asRecord(args);
      const groupId = parseId(raw.groupId, '群号');
      const message = typeof raw.message === 'string' ? raw.message : '';
      if (message.trim() === '') throw new Error('消息内容不能为空（参数 message）。');
      const atUserIds = Array.isArray(raw.atUserIds) ? raw.atUserIds.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v)) : [];
      const client = makeClient(cfg);
      const payload = await client.call('send_group_msg', {
        group_id: Number(groupId),
        message: buildMessage(message, atUserIds),
        auto_escape: atUserIds.length === 0,
      });
      const data = asRecord(payload.data);
      return {
        ok: true,
        chat: 'group',
        targetId: groupId,
        atUserIds,
        messageId: data.message_id ?? null,
        preview: previewOf(message),
        latencyMs: payload.latencyMs,
      };
    },
  };

  const history = {
    name: 'qq_history',
    description:
      '读取 QQ 最近消息。chat=private 需要好友 QQ 号、chat=group 需要群号、chat=recent 返回最近会话列表（含未读数与最后一条消息，不需要 id）。依赖 NapCat 的扩展接口 get_friend_msg_history / get_group_msg_history / get_recent_contact；旧后端不支持时会返回明确错误。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', enum: ['private', 'group', 'recent'], description: 'private=好友私聊，group=群聊，recent=最近会话与未读。默认 private。' },
        id: { type: 'string', description: 'chat=private 时为好友 QQ 号，chat=group 时为群号；chat=recent 时可省略。' },
        count: { type: 'number', description: '读取条数，默认 20，最大 100。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: textRenderer((v) => {
        const lines = [];
        if (v.chat === 'recent') {
          lines.push('最近会话（' + v.count + ' 个）：');
          if (v.messages.length === 0) lines.push('- 暂无会话记录');
          for (const m of v.messages) {
            const tag = m.chatType === 'group' ? '群' : '好友';
            lines.push('- [' + tag + '] ' + m.senderName + (m.senderId ? '(' + m.senderId + ')' : '') + (m.unread > 0 ? ' 未读 ' + m.unread + ' 条' : '') + (m.text ? '：' + m.text : '') + (m.time ? '  ｜ ' + m.time : ''));
          }
        } else {
          lines.push((v.chat === 'group' ? '群 ' : '好友 ') + v.targetId + ' 的最近 ' + v.messages.length + ' 条消息：');
          if (v.messages.length === 0) lines.push('- 没有读到消息（可能没有历史记录，或该后端不支持历史接口）');
          for (const m of v.messages) {
            lines.push('- ' + (m.time || '') + ' ' + (m.senderName || m.senderId || '?') + '：' + (m.text || ''));
          }
        }
        if (v.note) lines.push('- 备注：' + v.note);
        return lines;
      }),
    },
    async execute(args) {
      const raw = asRecord(args);
      const chat = raw.chat === 'group' || raw.chat === 'recent' ? raw.chat : 'private';
      const count = parseCount(raw.count, 20, 100);
      const client = makeClient(cfg);

      if (chat === 'recent') {
        const payload = await client.call('get_recent_contact', { count });
        const data = payload.data;
        const list = Array.isArray(data) ? data : Array.isArray(asRecord(data).recentContact) ? asRecord(data).recentContact : [];
        const messages = list.map((entry) => {
          const item = asRecord(entry);
          const peer = item.peerUin ?? item.peer ?? item.user_id ?? '';
          const chatTypeRaw = item.chatType ?? item.chat_type ?? null;
          const chatType = String(chatTypeRaw).toLowerCase().includes('group') || chatTypeRaw === 2 ? 'group' : 'private';
          return {
            chatType,
            chatTypeRaw,
            senderId: peer === '' ? null : String(peer),
            senderName: String(item.remark || item.peerName || peer || ''),
            unread: Number(item.unreadMsgCnt ?? item.unread ?? 0) || 0,
            text: previewOf(summaryOfLast(item.lastestMsg ?? item.lastMessage ?? item.message), 120),
            time: formatSeconds(item.msgTime ?? item.time),
          };
        });
        return {
          ok: true,
          chat,
          count: messages.length,
          messages,
          note: messages.length === 0 ? '后端没有返回会话；可能还没有任何聊天记录' : 'chatTypeRaw 是后端原始值，chatType 为按值推断的标签',
        };
      }

      const targetId = parseId(raw.id, chat === 'group' ? '群号' : 'QQ 号');
      const action = chat === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
      const params = chat === 'group' ? { group_id: Number(targetId), count } : { user_id: Number(targetId), count };
      const payload = await client.call(action, params);
      const rawMessages = extractMessages(payload.data);
      const messages = rawMessages.map(normalizeHistoryMessage);
      return {
        ok: true,
        chat,
        targetId,
        count: messages.length,
        messages,
        note: messages.length === 0 ? '接口返回空数组：可能确实没有历史消息，或需要先有会话' : null,
      };
    },
  };

  const backend = {
    name: 'qq_backend',
    description:
      '本地 QQ 机器人后端（NapCat）的启停体检。action=status 报告端口监听与登录状态；action=start 若端口没监听则用配置里的 launcherPath 启动 NapCat 并在超时内等待端口就绪（启动后仍可能需要在屏幕上的控制台扫码登录，工具不会替你登录）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start'], description: 'status=只检查；start=未监听时启动。默认 status。' },
        launcherPath: { type: 'string', description: '可选：本次使用的 launcher/napcat 批处理路径，覆盖配置里的 launcherPath。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: textRenderer((v) => {
        const lines = ['QQ 后端（' + v.baseUrl + '）：'];
        lines.push('- 端口 ' + v.host + ':' + v.port + '：' + (v.portOpen ? '监听中' : '未监听'));
        if (v.action === 'start') {
          lines.push('- 动作：' + (v.started ? '已发起启动' : '未启动（原因：' + (v.reason || '已在前端运行') + '）'));
          if (v.launcherPath) lines.push('- 启动器：' + v.launcherPath);
        }
        if (v.selfId) lines.push('- 已登录：' + v.selfId + (v.nickname ? '（' + v.nickname + '）' : ''));
        if (v.hint) lines.push('- 建议：' + v.hint);
        return lines;
      }),
    },
    async execute(args) {
      const raw = asRecord(args);
      const action = raw.action === 'start' ? 'start' : 'status';
      const { host, port } = hostPortOf(cfg.baseUrl);
      const launcherPath = typeof raw.launcherPath === 'string' && raw.launcherPath.trim() !== '' ? raw.launcherPath.trim() : cfg.launcherPath;
      let portOpen = await tcpProbe(host, port, 1500);
      let started = false;
      let reason = '';

      if (action === 'start' && !portOpen) {
        if (!launcherPath || !existsSync(launcherPath)) {
          reason = '启动器不存在：' + (launcherPath || '(未配置 launcherPath)');
        } else {
          try {
            // NapCat 要往 QQ 安装目录（通常是 Program Files）注入，必须提权启动；
            // 这里用 PowerShell 的 Start-Process -Verb RunAs 拉起启动器（UAC 由系统处理）。
            const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
            const script =
              'Start-Process -FilePath ' + quote(launcherPath) + ' -WorkingDirectory ' + quote(dirname(launcherPath)) + ' -Verb RunAs';
            const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
              cwd: dirname(launcherPath),
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
            child.unref();
            started = true;
          } catch (error) {
            reason = '启动失败：' + (error && error.message ? error.message : String(error));
          }
          if (started) {
            const deadline = Date.now() + cfg.startTimeoutMs;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 1500));
              portOpen = await tcpProbe(host, port, 1000);
              if (portOpen) break;
            }
          }
        }
      } else if (action === 'start') {
        reason = '端口已在监听';
      }

      const client = makeClient(cfg);
      let selfId = '';
      let nickname = '';
      const loginProbe = await client.probe('get_login_info');
      if (loginProbe.ok) {
        const login = asRecord(loginProbe.data);
        selfId = login.user_id !== undefined ? String(login.user_id) : '';
        nickname = typeof login.nickname === 'string' ? login.nickname : '';
      }

      let hint = '';
      if (!portOpen) hint = action === 'start' ? '启动后端口仍未就绪：检查 NapCat 控制台是否报错（版本不兼容 / 端口被占用）。' : '用 action=start 启动，或手动运行 NapCat 的 launcher。';
      else if (!selfId) hint = '端口已在监听但未取到登录信息：请在 NapCat 控制台扫码登录，或检查 token 配置。';

      return {
        ok: portOpen && selfId !== '',
        action,
        baseUrl: cfg.baseUrl,
        host,
        port,
        portOpen,
        started,
        reason: reason || null,
        launcherPath: launcherPath || null,
        selfId,
        nickname,
        hint,
      };
    },
  };

  const bot = {
    name: 'qq_bot',
    description:
      '群聊自动接话的开关与自测。action=status 看运行状态（监听的群、是否在收事件、最近回复决策、限流计数）；action=on / off 即时开关（只在本次运行内存生效）；action=test 用一条假消息跑一遍"判断→生成→（可选）发送"的完整管线，用来验证人设和模型，不会影响触发概率。触发规则：被 @ 必回，被叫名字（aliases）必回，其余按概率捡问题接话。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'on', 'off', 'test'], description: '默认 status。' },
        text: { type: 'string', description: 'action=test 时模拟的群友消息，例如「在吗，这游戏好玩吗？」。' },
        senderName: { type: 'string', description: 'action=test 时模拟的发言人昵称，默认「测试群友」。' },
        groupId: { type: 'string', description: 'action=test 时用哪个群的上下文/发到哪个群，默认取配置里第一个群。' },
        send: { type: 'boolean', description: 'action=test 时是否真的发到群里，默认 false（只生成不发送）。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: textRenderer((v) => {
        if (v.action === 'test') {
          if (v.error) return ['自动回复自测失败：' + v.error];
          return [
            '自动回复自测（' + (v.groupId || '?') + '）：',
            '- 模拟消息：' + v.source,
            '- 生成的回复：' + (v.reply || '(空)'),
            '- 模型：' + (v.model || '(未记录)'),
            '- 拟人延迟：' + (v.delayMs || 0) + ' ms',
            v.sent ? '- 已发送，message_id：' + v.messageId : '- 未发送（预览模式）',
          ];
        }
        if (v.action === 'on' || v.action === 'off') {
          return ['自动接话已' + (v.enabled ? '开启' : '关闭') + '（本次运行内生效）'];
        }
        const s = v.bot || {};
        const lines = ['自动接话：' + (s.enabled ? '开启' : '关闭') + (v.event && v.event.listening ? '，事件端口 ' + v.event.host + ':' + v.event.port + ' 监听中' : '，事件端口未监听')];
        lines.push('- 账号：' + (s.selfId || '未取到') + (s.nickname ? '（' + s.nickname + '）' : ''));
        lines.push('- 生效群：' + (Array.isArray(s.groupsWatched) ? s.groupsWatched.join(', ') : '?'));
        lines.push('- 触发：被 @ / 叫名字必回；闲聊接话概率 ' + Math.round((s.chatChance || 0) * 100) + '%，冷却 ' + s.cooldownSec + ' 秒');
        lines.push('- 限流：每群每小时 ' + (s.limits ? s.limits.perGroupPerHour : '?') + ' 条 / 合计 ' + (s.limits ? s.limits.totalPerHour : '?') + ' 条');
        lines.push('- 已回复 ' + s.replies + ' 条（近一小时 ' + (s.repliesLastHour || 0) + '），跳过 ' + s.skips + ' 次');
        if (v.event) lines.push('- 事件：收到 ' + v.event.received + '，处理 ' + v.event.accepted + '，拒绝 ' + v.event.rejected);
        if (v.event && v.event.lastRejection) {
          const r = v.event.lastRejection;
          lines.push('- 最近一次被拒：' + r.reason + '（' + r.method + ' ' + r.path + ' from ' + r.remote + '，authorization=' + (r.authorization || '(空)') + '）');
        }
        if (v.event && v.event.lastError) lines.push('- 事件端口错误：' + v.event.lastError);
        if (v.panelUrl) lines.push('- 管理面板：' + v.panelUrl + (v.panelListening === false ? '（未监听！）' : ''));
        if (s.lastError) lines.push('- 最近错误：' + s.lastError);
        if (Array.isArray(s.decisions) && s.decisions.length > 0) {
          lines.push('- 最近决策：');
          for (const d of s.decisions.slice(0, 5)) {
            lines.push('  · ' + d.at + ' [' + d.kind + '] ' + (d.sender || '') + '：' + (d.reply ? '回了「' + d.reply + '」' : d.skipped ? '跳过（' + d.skipped + '）' : d.error ? '出错：' + d.error : '—'));
          }
        }
        return lines;
      }),
    },
    async execute(args) {
      const raw = asRecord(args);
      const action = raw.action === 'on' || raw.action === 'off' || raw.action === 'test' ? raw.action : 'status';
      if (!engine) {
        return { ok: false, action, error: '自动回复引擎未启动（插件 apply 时没有创建引擎）' };
      }
      if (action === 'on' || action === 'off') {
        const enabled = engine.setEnabled(action === 'on');
        return { ok: true, action, enabled };
      }
      if (action === 'test') {
        const text = typeof raw.text === 'string' ? raw.text.trim() : '';
        if (text === '') throw new Error('action=test 需要 text（要模拟的群友消息）。');
        const senderName = typeof raw.senderName === 'string' && raw.senderName.trim() !== '' ? raw.senderName.trim() : '测试群友';
        const configured = Array.isArray(cfg.groups) ? cfg.groups.find((g) => g !== '*') : undefined;
        const groupId = typeof raw.groupId === 'string' && raw.groupId.trim() !== '' ? raw.groupId.trim() : configured || '';
        const result = await engine.simulate({
          text,
          senderName,
          groupId,
          send: raw.send === true,
        });
        const replyText = result && typeof result.reply === 'string' ? result.reply : '';
        const detail = engine.status();
        const last = Array.isArray(detail.decisions) && detail.decisions.length > 0 ? detail.decisions[0] : {};
        return {
          ok: Boolean(replyText) && !result.error,
          action,
          groupId: String(groupId || ''),
          source: senderName + '：' + text,
          reply: replyText,
          model: last.model || '',
          delayMs: result.delayMs || 0,
          sent: result.messageId !== null && result.messageId !== undefined,
          messageId: result.messageId ?? null,
          error: result.error || result.skipped || null,
        };
      }
      if (typeof engine.warmup === 'function') {
        try {
          await engine.warmup();
        } catch {
          /* 后端没起来时忽略，状态里会体现 */
        }
      }
      return {
        ok: true,
        action: 'status',
        bot: engine.status(),
        event: server ? server.state : null,
        panelUrl: 'http://127.0.0.1:' + cfg.adminPort + '/',
        panelListening: admin ? admin.state.listening : null,
      };
    },
  };

  return [status, sendPrivate, sendGroup, history, backend, bot];
}

/** recent 会话里最后一条消息的简述，兼容字符串 / segment 数组 / NT 原始 elements。 */
function summaryOfLast(last) {
  if (last === null || last === undefined) return '';
  if (typeof last === 'string') return last;
  if (Array.isArray(last)) return messageToText(last);
  if (typeof last === 'object') {
    if (typeof last.text === 'string') return last.text;
    if (Array.isArray(last.message)) return messageToText(last.message);
    if (Array.isArray(last.elements)) {
      return last.elements
        .map((element) => {
          if (element && typeof element.textElement === 'object' && element.textElement) return String(element.textElement.content ?? '');
          if (element && typeof element.faceElement === 'object') return '[表情]';
          if (element && typeof element.picElement === 'object') return '[图片]';
          return '';
        })
        .join('');
    }
    if (typeof last.raw_message === 'string') return last.raw_message;
  }
  return '';
}

/** 秒级时间戳 → 可读时间；毫秒级（>1e12）自动按毫秒处理。 */
function formatSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  const pad = (v) => String(v).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}
