/**
 * 持久化：面板里改的东西（人设、白名单、限流…）和用量统计都落在这里。
 *
 * 为什么不写 profile 的 cordis.patch.yml：那是宿主的组合文件，插件不该改它；
 * 这里用一个独立 JSON（插件目录 data/admin.json），启动时覆盖到运行时 cfg 上。
 * @module dsh-qq/store
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 面板可写的设置项（也是持久化白名单）。 */
export const EDITABLE_KEYS = [
  'persona',
  'groups',
  'watchUsers',
  'aliases',
  'autoReply',
  'panelEnabled',
  'chatChance',
  'cooldownSec',
  'maxPerHourGroup',
  'maxPerHourTotal',
  'maxReplyChars',
  'contextSize',
];

const NUMBER_LIMITS = {
  chatChance: [0, 1],
  cooldownSec: [3, 3600],
  maxPerHourGroup: [1, 200],
  maxPerHourTotal: [1, 500],
  maxReplyChars: [10, 400],
  contextSize: [4, 60],
};

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function todayKey(date = new Date()) {
  const pad = (v) => String(v).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function sanitizeList(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\s]+/) : [];
  return [...new Set(list.map((item) => String(item).trim()).filter((item) => item !== ''))];
}

/**
 * 校验并归一化一个设置补丁；返回 { patch, rejected }。
 * @param {Record<string, unknown>} input
 */
export function normalizePatch(input) {
  const source = asRecord(input);
  const patch = {};
  const rejected = [];
  for (const [key, value] of Object.entries(source)) {
    if (!EDITABLE_KEYS.includes(key)) {
      rejected.push(key);
      continue;
    }
    if (key === 'persona') {
      if (typeof value !== 'string') {
        rejected.push(key);
        continue;
      }
      patch.persona = value.slice(0, 8000);
      continue;
    }
    if (key === 'groups' || key === 'watchUsers' || key === 'aliases') {
      patch[key] = sanitizeList(value);
      continue;
    }
    if (key === 'autoReply' || key === 'panelEnabled') {
      if (typeof value === 'boolean') patch[key] = value;
      else rejected.push(key);
      continue;
    }
    const [min, max] = NUMBER_LIMITS[key] || [0, Number.MAX_SAFE_INTEGER];
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(number)) {
      rejected.push(key);
      continue;
    }
    patch[key] = Math.min(max, Math.max(min, number));
  }
  return { patch, rejected };
}

/**
 * @param {{dir: string}} options 数据目录（会在里面写 admin.json）
 */
export function createStore({ dir }) {
  const file = join(dir, 'admin.json');
  const state = { settings: {}, usage: {}, persona: '', updatedAt: null };
  let saveTimer = null;

  try {
    if (existsSync(file)) {
      const parsed = asRecord(JSON.parse(readFileSync(file, 'utf8')));
      state.settings = asRecord(parsed.settings);
      state.usage = asRecord(parsed.usage);
      state.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
    }
  } catch {
    /* 坏文件就当空的 */
  }

  function flush() {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify({ settings: state.settings, usage: state.usage, updatedAt: state.updatedAt }, null, 2);
      const temp = file + '.tmp';
      writeFileSync(temp, payload, 'utf8');
      renameSync(temp, file);
    } catch {
      /* 磁盘写失败不影响运行 */
    }
  }

  function save() {
    state.updatedAt = new Date().toISOString();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flush();
    }, 400);
    saveTimer.unref?.();
  }

  /** 把持久化设置覆盖到运行时 cfg（只覆盖面板管的字段）。 */
  function applyTo(cfg) {
    for (const key of EDITABLE_KEYS) {
      if (state.settings[key] !== undefined) cfg[key] = state.settings[key];
    }
    return cfg;
  }

  /**
   * 保存一个补丁：写盘 + 立刻覆盖到 cfg（引擎在调用时读 cfg，所以即时生效）。
   * @returns {{patch: Record<string, unknown>, rejected: string[], settings: Record<string, unknown>}}
   */
  function savePatch(input, cfg) {
    const { patch, rejected } = normalizePatch(input);
    state.settings = { ...state.settings, ...patch };
    applyTo(cfg);
    save();
    return { patch, rejected, settings: { ...state.settings } };
  }

  /**
   * 记一次模型调用用量。
   * @param {{model?: string, inputTokens?: number, outputTokens?: number}} usage
   */
  function addUsage(usage) {
    const key = todayKey();
    const day = asRecord(state.usage[key]);
    const next = {
      calls: Number(day.calls || 0) + 1,
      inputTokens: Number(day.inputTokens || 0) + Number(usage.inputTokens || 0),
      outputTokens: Number(day.outputTokens || 0) + Number(usage.outputTokens || 0),
      models: { ...asRecord(day.models) },
    };
    if (usage.model) next.models[usage.model] = Number(next.models[usage.model] || 0) + 1;
    state.usage[key] = next;
    // 只留最近 60 天
    const keys = Object.keys(state.usage).sort();
    for (const stale of keys.slice(0, Math.max(0, keys.length - 60))) delete state.usage[stale];
    save();
  }

  /** 记一条「真的发出去了」的回复（今日计数用）。 */
  function addReply() {
    const key = todayKey();
    const day = asRecord(state.usage[key]);
    state.usage[key] = { ...day, replies: Number(day.replies || 0) + 1 };
    save();
  }

  /** 今天的用量 + 最近 7 天。 */
  function usageSummary() {
    const today = asRecord(state.usage[todayKey()]);
    const days = [];
    for (let index = 6; index >= 0; index -= 1) {
      const date = new Date();
      date.setDate(date.getDate() - index);
      const key = todayKey(date);
      const day = asRecord(state.usage[key]);
      days.push({
        date: key,
        calls: Number(day.calls || 0),
        inputTokens: Number(day.inputTokens || 0),
        outputTokens: Number(day.outputTokens || 0),
      });
    }
    const total = days.reduce(
      (acc, day) => ({ calls: acc.calls + day.calls, inputTokens: acc.inputTokens + day.inputTokens, outputTokens: acc.outputTokens + day.outputTokens }),
      { calls: 0, inputTokens: 0, outputTokens: 0 },
    );
    return {
      today: {
        calls: Number(today.calls || 0),
        inputTokens: Number(today.inputTokens || 0),
        outputTokens: Number(today.outputTokens || 0),
        models: asRecord(today.models),
        replies: Number(today.replies || 0),
      },
      days,
      week: total,
    };
  }

  return { file, state, applyTo, savePatch, addUsage, addReply, usageSummary, flush };
}
