/**
 * dsh-qq —— 让我在 QQ 上发消息、在群里自动接话，并带一个网页面板的 DSH 插件（Host 半边）。
 *
 * 通道：本机 NapCat（QQNT + OneBot 11 HTTP）。
 *   - 发消息：主动调用 OneBot HTTP API。
 *   - 收消息：NapCat 的 httpClients 把事件 POST 到本插件监听的 http://127.0.0.1:<eventPort>/。
 *   - 生成回复：用宿主的 llm 服务（同一个 DeepSeek 模型/账号），不需要额外 API key。
 *   - 管理面板：http://127.0.0.1:<adminPort>/（人设、白名单、用量、登录二维码）。
 *
 * 注册的工具：
 *   qq_status / qq_send_private / qq_send_group / qq_history / qq_backend / qq_bot
 *
 * 依赖：只用 node 内置模块。
 * @module dsh-qq
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './lib/config.js';
import { buildQqTools } from './lib/tools.js';
import { createEventServer } from './lib/events.js';
import { createAutoReplyEngine } from './lib/engine.js';
import { createStore } from './lib/store.js';
import { createAdminServer } from './lib/admin.js';
import { createNapcatWebui, readWebuiToken } from './lib/napcat.js';

/** cordis 服务注入：apply 里要用 ctx.tools，必须显式声明。 */
export const name = 'qq';
export const inject = ['tools'];

const HOST_KEY = Symbol.for('dsh-qq.host');

/** 面板代码版本：改了 admin.js / admin-ui.html 就改这里，热重载时会重建面板服务。 */
const ADMIN_BUILD = '2026-10-28.3';

/**
 * 事件监听器在每个进程里只留一份：插件热重载会重新 import 本模块，
 * 如果每次都重新 bind，旧实例的端口常常还没释放（EADDRINUSE），
 * 于是把 server 挂在 globalThis 上复用，只把 onEvent 指向新的 engine。
 */
function hostSlot() {
  if (!globalThis[HOST_KEY]) globalThis[HOST_KEY] = { holder: { engine: null }, server: null, port: 0, token: '', admin: null, adminStarted: false, context: {}, route: null };
  return globalThis[HOST_KEY];
}

function makeLogger() {
  return (line) => {
    try {
      console.log('[dsh-qq] ' + line);
    } catch {
      /* ignore */
    }
  };
}

/**
 * 插件入口：解析配置 → 持久化面板设置 → 起事件监听/自动回复/网页面板 → 注册工具。
 * @param {{tools: {register: (definition: unknown) => () => void}, get?: (name: string) => unknown, on?: Function}} ctx
 * @param {unknown} config 组合包补丁里的 config（可省略）
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const log = makeLogger();

  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const dataDir = cfg.dataDir !== '' ? cfg.dataDir : join(pluginDir, 'data');
  const store = createStore({ dir: dataDir });
  store.applyTo(cfg);

  const slot = hostSlot();
  const engine = createAutoReplyEngine({ ctx, cfg, log, store });
  slot.holder.engine = engine;

  slot.token = cfg.eventToken;
  let eventServer = slot.server;
  if (!eventServer || slot.port !== cfg.eventPort) {
    eventServer = createEventServer({
      port: cfg.eventPort,
      token: cfg.eventToken,
      getToken: () => slot.token,
      onEvent: (event) => slot.holder.engine?.handleEvent(event),
      onLog: log,
    });
    slot.server = eventServer;
    slot.port = cfg.eventPort;
  } else {
    eventServer.setToken?.(cfg.eventToken);
  }

  const napcat = createNapcatWebui({ baseUrl: cfg.napcatWebuiUrl, token: readWebuiToken(cfg.napcatWebuiConfig) });

  // 面板服务整进程只建一次：热重载时换掉 context，旧端口不会被占住；
  // 但面板代码本身变了（ADMIN_BUILD 不同）就关掉旧的、按新代码重建。
  slot.context = { cfg, store, engine, eventServer, napcat };
  if (slot.admin && slot.adminBuild !== ADMIN_BUILD) {
    try {
      void slot.admin.close();
    } catch {
      /* ignore */
    }
    slot.admin = null;
  }
  if (!slot.admin) {
    slot.admin = createAdminServer({ getContext: () => slot.context, log });
    slot.adminBuild = ADMIN_BUILD;
  }
  // 每个实例只 start 一次：用 state.port 判断，重建出来的实例才能自己重新监听。
  if (!slot.admin.state || !slot.admin.state.port) {
    slot.admin.start(cfg.adminPort);
  }
  const admin = slot.admin;

  // 把同一套页面挂到 DSH Web 服务上（/qq-panel）：侧边框 iframe 走同源，免 CORS/CSP 麻烦。
  if (!slot.route) {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (webServer && typeof webServer.register === 'function') {
      try {
        slot.route = webServer.register({
          kind: 'prefix',
          path: '/qq-panel',
          handler: (req, res) => admin.handle(req, res, '/qq-panel'),
        });
        log('已挂载 /qq-panel 到 DSH Web 服务');
      } catch (error) {
        log('挂载 /qq-panel 失败：' + String(error && error.message ? error.message : error));
      }
    }
  }

  const disposers = [];
  for (const definition of buildQqTools(cfg, { engine, server: eventServer, admin, store })) {
    disposers.push(ctx.tools.register(definition));
  }

  const disposeAll = () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose();
      } catch {
        /* ignore */
      }
    }
    disposers.length = 0;
    if (slot.holder.engine === engine) slot.holder.engine = null;
    try {
      engine.dispose();
    } catch {
      /* ignore */
    }
    try {
      store.flush();
    } catch {
      /* ignore */
    }
    // 面板与事件监听都留在进程里复用，这里只断开引用（插件卸载后重启 DSH 才会真正释放端口）。
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => disposeAll);
  else if (typeof ctx.on === 'function') ctx.on('dispose', disposeAll);
  return disposeAll;
}

export { resolveConfig, DEFAULTS } from './lib/config.js';
export * from './lib/onebot.js';
export * from './lib/tools.js';
export * from './lib/engine.js';
export * from './lib/persona.js';
export * from './lib/events.js';
export * from './lib/store.js';
export * from './lib/napcat.js';
export * from './lib/backend.js';
export * from './lib/admin.js';
