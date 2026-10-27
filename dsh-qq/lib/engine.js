/**
 * 自动回复引擎：接住群里的事件，判断要不要说话，用宿主模型想一句人话，再发出去。
 *
 * 设计要点
 * - 判定分三档：被 @ > 被叫名字 > 闲聊接话（带冷却和概率），避免刷屏。
 * - 上下文按群维护最近若干条，喂给模型；机器人自己的回复也进上下文。
 * - 用宿主 llm 服务（同一个 DeepSeek 账号/模型），不需要额外 API key。
 * - 同一群串行处理，避免两条消息并发回复；每群每小时有上限。
 * @module dsh-qq/engine
 */
import { OneBotClient, messageToText } from './onebot.js';
import { defaultPersona } from './persona.js';

const HOUR_MS = 60 * 60 * 1000;

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function nowText() {
  const date = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

/** 判断像不像一个问题（闲聊模式下只捡这类，减少瞎插话）。 */
function looksLikeQuestion(text) {
  if (/[?？]\s*$/.test(text)) return true;
  return /(吗|呢|怎么|为什么|为啥|是不是|能不能|有没有|会不会|哪个|哪里|多少|咋|如何|求问|有人知道)/.test(text);
}

/** 清洗模型输出：去掉引号/名字前缀/markdown，压成一条短消息。 */
export function tidyReply(raw, maxChars) {
  let text = String(raw || '');
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/^\s*(?:我|机器人|助手|AI)\s*[:：]\s*/i, '');
  text = text.replace(/\*\*|__|`/g, '');
  text = text.replace(/^["'「『“”]+|["'」』“”]+$/g, '');
  text = text.replace(/^#+\s*/gm, '');
  text = text.replace(/\r/g, '');
  text = text.trim().replace(/[ \t]+/g, ' ');
  if (text.length > maxChars) {
    const slice = text.slice(0, maxChars);
    const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('，'), slice.lastIndexOf('？'), slice.lastIndexOf('！'), slice.lastIndexOf(' '));
    text = (cut > Math.floor(maxChars * 0.4) ? slice.slice(0, cut) : slice) + (cut > 0 ? '' : '…');
  }
  return text.trim();
}

export function createAutoReplyEngine({ ctx, cfg, log, store }) {
  const client = new OneBotClient({ baseUrl: cfg.baseUrl, accessToken: cfg.accessToken, timeoutMs: cfg.timeoutMs });
  const contexts = new Map();
  const replyTimes = new Map();
  const totalReplyTimes = [];
  const lastReplyAt = new Map();
  const queues = new Map();
  const decisions = [];

  const state = {
    enabled: cfg.autoReply !== false,
    selfId: '',
    nickname: '',
    lastError: null,
    replies: 0,
    skips: 0,
    lastReplyAt: null,
  };

  function record(entry) {
    decisions.unshift({ at: nowText(), ...entry });
    if (decisions.length > 30) decisions.length = 30;
  }

  function pushContext(groupId, item) {
    const key = String(groupId);
    let list = contexts.get(key);
    if (!list) {
      list = [];
      contexts.set(key, list);
    }
    list.push(item);
    if (list.length > cfg.contextSize) list.splice(0, list.length - cfg.contextSize);
  }

  function prune(list, cutoff) {
    while (list.length > 0 && list[0] < cutoff) list.shift();
  }

  function withinBudget(groupId) {
    const now = Date.now();
    const cutoff = now - HOUR_MS;
    prune(totalReplyTimes, cutoff);
    let groupTimes = replyTimes.get(String(groupId));
    if (!groupTimes) {
      groupTimes = [];
      replyTimes.set(String(groupId), groupTimes);
    }
    prune(groupTimes, cutoff);
    return totalReplyTimes.length < cfg.maxPerHourTotal && groupTimes.length < cfg.maxPerHourGroup;
  }

  function noteReply(groupId) {
    const now = Date.now();
    replyTimes.get(String(groupId))?.push(now) ?? replyTimes.set(String(groupId), [now]);
    totalReplyTimes.push(now);
    lastReplyAt.set(String(groupId), now);
    state.replies += 1;
    state.lastReplyAt = now;
  }

  async function ensureSelf() {
    if (state.selfId !== '') return;
    const probe = await client.probe('get_login_info');
    if (probe.ok) {
      const login = asRecord(probe.data);
      state.selfId = login.user_id !== undefined ? String(login.user_id) : '';
      state.nickname = typeof login.nickname === 'string' ? login.nickname : '';
    }
  }

  function personaText() {
    if (typeof cfg.persona === 'string' && cfg.persona.trim() !== '') {
      return cfg.persona.trim().replace(/\{nickname\}/g, state.nickname || '我');
    }
    return defaultPersona({ nickname: state.nickname, selfId: state.selfId });
  }

  async function generate(groupId, senderName, senderId, text, kind) {
    const llm = ctx.get('llm');
    if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有可用的 llm 服务，无法生成回复');
    let selection = {};
    try {
      selection = asRecord(ctx.get('agentDefaultModel')?.currentSelection());
    } catch {
      selection = {};
    }
    const provider = cfg.provider || selection.provider;
    const model = cfg.model || selection.model;
    if (!provider || !model) throw new Error('拿不到默认模型（provider/model），请在插件配置里写 model/provider');

    const lines = (contexts.get(String(groupId)) || []).map((item) => item.name + '：' + item.text);
    const kindNote = kind === 'mention' ? '（最后这条 @ 了你）' : kind === 'name' ? '（最后这条在叫你的名字）' : '';
    const system = [
      personaText(),
      '',
      '# 当前群聊（旧 → 新，最多 ' + cfg.contextSize + ' 条）',
      lines.join('\n') || '（暂无）',
      kindNote,
      '',
      '# 任务',
      '回最后一条消息。像平时在群里随口接一句，不要长篇大论。',
    ].join('\n');

    const messages = [{ role: 'user', content: [{ type: 'text', text: senderName + '：' + text }] }];
    let out = '';
    let finishReason = null;
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of llm.stream({ provider, model, system, messages, temperature: 0.95, maxTokens: 220 })) {
      const piece = asRecord(chunk);
      if (piece.type === 'usage') {
        const usage = asRecord(piece.usage);
        inputTokens += Number(usage.inputTokens || 0) || 0;
        outputTokens += Number(usage.outputTokens || 0) || 0;
      } else if (piece.type === 'text-delta' && typeof piece.text === 'string') out += piece.text;
      else if (piece.type === 'finish') {
        const reason = asRecord(piece.reason);
        finishReason = typeof reason.kind === 'string' ? reason.kind : null;
        if (finishReason === 'error') {
          const failure = asRecord(reason.failure);
          throw new Error('模型调用失败：' + String(failure.message || failure.code || '未知错误'));
        }
      }
    }
    if (store && typeof store.addUsage === 'function') {
      try {
        store.addUsage({ model: provider + '/' + model, inputTokens, outputTokens });
      } catch {
        /* 统计失败不影响回复 */
      }
    }
    return { text: out, provider, model, finishReason, inputTokens, outputTokens };
  }

  async function sendGroup(groupId, text) {
    const payload = await client.call('send_group_msg', { group_id: Number(groupId), message: text, auto_escape: true });
    const data = asRecord(payload.data);
    return data.message_id ?? null;
  }

  async function reply(groupId, senderName, senderId, sourceText, kind, options = {}) {
    await ensureSelf();
    if (!state.enabled && !options.force) return { skipped: 'disabled' };
    if (!withinBudget(groupId)) {
      state.skips += 1;
      record({ groupId, kind, sender: senderName, text: sourceText, skipped: 'rate-limit' });
      return { skipped: 'rate-limit' };
    }
    let generated;
    try {
      generated = await generate(groupId, senderName, senderId, sourceText, kind);
    } catch (error) {
      state.lastError = String((error && error.message) || error);
      record({ groupId, kind, sender: senderName, text: sourceText, error: state.lastError });
      return { error: state.lastError };
    }
    const text = tidyReply(generated.text, cfg.maxReplyChars);
    if (text === '') {
      record({ groupId, kind, sender: senderName, text: sourceText, skipped: 'empty' });
      return { skipped: 'empty' };
    }
    // 像人一样：想一会儿再发，字数越多打字越久。
    const thinkMs = Math.min(5000, 700 + text.length * 110) + Math.floor(Math.random() * 900);
    if (!options.noDelay) await new Promise((resolve) => setTimeout(resolve, thinkMs));
    let messageId = null;
    let error = null;
    if (options.send !== false) {
      try {
        messageId = await sendGroup(groupId, text);
      } catch (caught) {
        error = String((caught && caught.message) || caught);
        state.lastError = error;
      }
    }
    if (messageId !== null || options.send === false) {
      noteReply(groupId);
      pushContext(groupId, { name: state.nickname || '我', text, self: true });
    }
    // 只有真的发出去了才算今日回复（预览/自测不计数）
    if (messageId !== null && store && typeof store.addReply === 'function') {
      try {
        store.addReply();
      } catch {
        /* ignore */
      }
    }
    record({
      groupId,
      kind,
      sender: senderName,
      text: sourceText,
      reply: text,
      sent: messageId !== null,
      messageId,
      model: generated.provider + '/' + generated.model,
      delayMs: thinkMs,
      error,
    });
    return { reply: text, messageId, error, delayMs: thinkMs };
  }

  /** 一个群一条队列，保证串行回复。 */
  function enqueue(groupId, task) {
    const key = String(groupId);
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.then(task).catch((error) => {
      state.lastError = String((error && error.message) || error);
      if (log) log('自动回复出错：' + state.lastError);
    });
    queues.set(key, next);
    return next;
  }

  function shouldHandle(event) {
    if (asRecord(event).post_type !== 'message') return null;
    if (event.message_type !== 'group') return null;
    const groupId = event.group_id !== undefined ? String(event.group_id) : '';
    if (groupId === '') return null;
    if (cfg.groups.length > 0 && !cfg.groups.includes('*') && !cfg.groups.includes(groupId)) return null;
    const senderId = event.user_id !== undefined ? String(event.user_id) : '';
    if (state.selfId !== '' && senderId === state.selfId) return null;
    // 白名单：watchUsers 非空时，只理会这些 QQ 号说的话，其它人一律无视。
    const watchUsers = Array.isArray(cfg.watchUsers) ? cfg.watchUsers : [];
    if (watchUsers.length > 0 && !watchUsers.includes(senderId)) return null;
    const message = event.message;
    const text = messageToText(message).trim();
    const segments = Array.isArray(message) ? message : [];
    const atMe = segments.some((segment) => asRecord(segment).type === 'at' && String(asRecord(asRecord(segment).data).qq) === state.selfId);
    const aliasHit = cfg.aliases.some((alias) => alias !== '' && text.includes(alias)) || (state.nickname !== '' && text.includes(state.nickname));
    const senderName = String(asRecord(event.sender).card || asRecord(event.sender).nickname || senderId || '群友');
    return { groupId, senderId, senderName, text, atMe, aliasHit };
  }

  function handleEvent(event) {
    const base = shouldHandle(event);
    if (!base) return;
    pushContext(base.groupId, { name: base.senderName, text: base.text || '[非文本消息]', self: false });
    if (!state.enabled) return;

    let kind = null;
    if (base.atMe) kind = 'mention';
    else if (base.aliasHit) kind = 'name';
    else if (base.text !== '' && (looksLikeQuestion(base.text) || Math.random() < cfg.chatChance)) kind = 'chat';
    if (kind === null) {
      state.skips += 1;
      return;
    }
    // 冷却：被点名至少隔 cooldownSec，闲聊按更长的间隔算。
    const gap = kind === 'chat' ? cfg.cooldownSec * 1000 : Math.min(cfg.cooldownSec, 8) * 1000;
    const last = lastReplyAt.get(base.groupId) || 0;
    if (Date.now() - last < gap) {
      state.skips += 1;
      record({ groupId: base.groupId, kind, sender: base.senderName, text: base.text, skipped: 'cooldown' });
      return;
    }
    enqueue(base.groupId, () => reply(base.groupId, base.senderName, base.senderId, base.text, kind));
  }

  /** 手动跑一遍生成管线（不依赖真实群消息），用于自测。 */
  async function simulate({ text, senderName = '测试群友', senderId = '10000', groupId, send = false, noDelay = true }) {
    await ensureSelf();
    const gid = String(groupId || cfg.groups.find((g) => g !== '*') || '0');
    pushContext(gid, { name: senderName, text, self: false });
    return reply(gid, senderName, String(senderId), text, 'mention', { send, noDelay, force: true });
  }

  function status() {
    const now = Date.now();
    prune(totalReplyTimes, now - HOUR_MS);
    const groups = [...contexts.keys()].map((key) => {
      const times = replyTimes.get(key) || [];
      prune(times, now - HOUR_MS);
      return { groupId: key, context: (contexts.get(key) || []).length, repliesLastHour: times.length };
    });
    return {
      enabled: state.enabled,
      selfId: state.selfId,
      nickname: state.nickname,
      groupsWatched: cfg.groups.length === 0 ? ['(未限制)'] : cfg.groups,
      usersWatched: Array.isArray(cfg.watchUsers) && cfg.watchUsers.length > 0 ? cfg.watchUsers : ['(所有人)'],
      contextSize: cfg.contextSize,
      chatChance: cfg.chatChance,
      cooldownSec: cfg.cooldownSec,
      limits: { perGroupPerHour: cfg.maxPerHourGroup, totalPerHour: cfg.maxPerHourTotal },
      replies: state.replies,
      skips: state.skips,
      repliesLastHour: totalReplyTimes.length,
      lastReplyAt: state.lastReplyAt ? new Date(state.lastReplyAt).toLocaleString('zh-CN', { hour12: false }) : null,
      lastError: state.lastError,
      model: cfg.model || cfg.provider ? { provider: cfg.provider || '(默认)', model: cfg.model || '(默认)' } : '(跟随 DSH 默认模型)',
      groups,
      decisions: decisions.slice(0, 10),
    };
  }

  return {
    state,
    warmup: ensureSelf,
    handleEvent,
    simulate,
    status,
    setEnabled(value) {
      state.enabled = Boolean(value);
      return state.enabled;
    },
    dispose() {
      queues.clear();
      contexts.clear();
    },
  };
}
