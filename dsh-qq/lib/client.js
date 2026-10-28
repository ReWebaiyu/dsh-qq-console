/**
 * dsh-qq 的浏览器半边：在 DSH 侧边栏加一个「QQ」面板，内容就是网页面板（同源 /qq-panel iframe），
 * 显示效果和 http://127.0.0.1:3014/ 完全一致；另外在设置里加一页「QQ 消息」，
 * 用来开关侧边框入口、一键打开网页面板、看连接状态。
 *
 * 不用 any 构建工具：直接走 window.__ModuleLoader__ + React（宿主提供）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const PANEL_ID = 'qq';
    const SAME_ORIGIN_BASE = '/qq-panel';
    const DIRECT_BASE = 'http://127.0.0.1:3014';
    const zh = !String((typeof navigator !== 'undefined' && navigator.language) || 'zh').toLowerCase().startsWith('en');

    const text = zh
      ? {
          panel: 'QQ 消息',
          connecting: '正在连接 QQ 面板…',
          embedded: '内嵌',
          direct: '直连 3014',
          refresh: '刷新',
          openBrowser: '在浏览器打开',
          settingsLabel: 'QQ 消息',
          settingsTitle: 'QQ 消息',
          settingsIntro: '把 QQ 机器人面板挂成侧边框。不想多一个侧边框就关掉这里，从网页版管理；两套界面完全一致。',
          showSidebar: '在侧边栏显示 QQ 面板',
          sidebarOn: '已显示（左侧栏出现 QQ 图标，点开就是完整面板）',
          sidebarOff: '已隐藏（只保留网页版，左侧栏不再出现 QQ 图标）',
          openWeb: '打开网页面板',
          account: '登录账号',
          status: '连接状态',
          connected: '已连接',
          offline: '后端未连接',
          notLoggedIn: '未登录',
          loading: '读取中…',
          failed: '读不到面板服务，确认插件已启用',
          back: '返回对话',
        }
      : {
          panel: 'QQ',
          connecting: 'Connecting to the QQ panel…',
          embedded: 'embedded',
          direct: 'direct :3014',
          refresh: 'Reload',
          openBrowser: 'Open in browser',
          settingsLabel: 'QQ',
          settingsTitle: 'QQ Messenger',
          settingsIntro: 'Mount the QQ bot console as a sidebar panel. Turn it off here to keep only the web console — both render the same UI.',
          showSidebar: 'Show the QQ panel in the sidebar',
          sidebarOn: 'Shown (a QQ icon appears in the left rail)',
          sidebarOff: 'Hidden (web console only)',
          openWeb: 'Open web console',
          account: 'Account',
          status: 'Status',
          connected: 'Connected',
          offline: 'Backend offline',
          notLoggedIn: 'Not signed in',
          loading: 'Loading…',
          failed: 'Panel service unreachable — is the plugin enabled?',
          back: 'Back to chat',
        };

    /** 面板 API 基址：优先同源路由，失败退回 3014。 */
    let resolvedBase = null;
    async function resolveBase() {
      if (resolvedBase) return resolvedBase;
      try {
        const response = await fetch(SAME_ORIGIN_BASE + '/api/state', { method: 'GET' });
        if (response.ok) {
          resolvedBase = SAME_ORIGIN_BASE;
          return resolvedBase;
        }
      } catch {
        /* 同源路由不可用，退回直连端口 */
      }
      resolvedBase = DIRECT_BASE;
      return resolvedBase;
    }

    async function readState(base) {
      const response = await fetch(base + '/api/state');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }

    async function saveSetting(base, patch) {
      const response = await fetch(base + '/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-base, transparent)' },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        borderBottom: '1px solid var(--dsw-alias-line-divider, rgba(255,255,255,.08))',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, rgba(255,255,255,.7))',
        flex: 'none',
      },
      title: { fontWeight: 650, fontSize: 12.5, color: 'var(--dsw-alias-label-primary, #fff)' },
      spacer: { flex: 1 },
      button: {
        all: 'unset',
        cursor: 'pointer',
        padding: '4px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-line-divider, rgba(255,255,255,.12))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.05))',
        color: 'inherit',
        fontSize: 11.5,
      },
      frame: { flex: 1, width: '100%', border: 0, display: 'block', minHeight: 0, background: 'transparent' },
      center: { display: 'grid', placeItems: 'center', height: '100%', fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary, rgba(255,255,255,.55))' },
      card: {
        border: '1px solid var(--dsw-alias-line-divider, rgba(255,255,255,.1))',
        borderRadius: 14,
        padding: 16,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03))',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      row: { display: 'flex', alignItems: 'center', gap: 10 },
      hint: { fontSize: 11.5, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary, rgba(255,255,255,.55))', margin: 0 },
      dot: (on) => ({
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: on ? '#2fd47a' : '#ff5c74',
        boxShadow: '0 0 0 3px ' + (on ? 'rgba(47,212,122,.18)' : 'rgba(255,92,116,.18)'),
        flex: 'none',
      }),
    };

    /** 侧边栏面板：一条细工具栏 + iframe（iframe 里就是网页面板本体）。 */
    function QqPanel(props) {
      const [base, setBase] = useState(null);
      const [nonce, setNonce] = useState(0);
      const [ready, setReady] = useState(false);
      const triedDirect = useRef(false);

      useEffect(() => {
        let alive = true;
        resolveBase().then((value) => {
          if (alive) setBase(value);
        });
        return () => {
          alive = false;
        };
      }, []);

      // 内嵌页加载完会 postMessage 报到；超时没报到说明同源路由被拦（或页面没起来），退回 3014 直连。
      useEffect(() => {
        const onMessage = (event) => {
          if (event && event.data && event.data.type === 'dsh-qq-panel-ready') setReady(true);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, []);

      useEffect(() => {
        if (!base || ready) return undefined;
        const timer = setTimeout(() => {
          if (!ready && base === SAME_ORIGIN_BASE && !triedDirect.current) {
            triedDirect.current = true;
            resolvedBase = DIRECT_BASE;
            setBase(DIRECT_BASE);
            setNonce((value) => value + 1);
          }
        }, 5000);
        return () => clearTimeout(timer);
      }, [base, ready, nonce]);

      if (!base) return h('div', { style: styles.center }, text.connecting);

      const search = typeof window !== 'undefined' && window.location.search ? '&' + window.location.search.slice(1) : '';
      const src = base + '/?embed=1' + search;

      return h(
        'div',
        { style: styles.wrap },
        h(
          'div',
          { style: styles.bar },
          h('span', { style: styles.title }, text.panel),
          h('span', { style: { opacity: 0.6 } }, (base === SAME_ORIGIN_BASE ? text.embedded : text.direct) + (ready ? '' : ' · ' + text.connecting)),
          h('span', { style: styles.spacer }),
          props && typeof props.goChat === 'function'
            ? h('button', { type: 'button', style: styles.button, onClick: () => props.goChat() }, text.back)
            : null,
          h(
            'button',
            { type: 'button', style: styles.button, onClick: () => setNonce((value) => value + 1) },
            text.refresh,
          ),
          h(
            'button',
            {
              type: 'button',
              style: styles.button,
              onClick: () => window.open(DIRECT_BASE + '/', '_blank', 'noreferrer'),
            },
            text.openBrowser,
          ),
        ),
        h('iframe', { key: nonce, src, title: 'QQ Console', style: styles.frame, allow: 'clipboard-write' }),
      );
    }

    /** 侧栏图标：气泡 + 三个点；size/active 由侧栏面板行传入。 */
    function QqIcon(props) {
      const size = props && props.size ? props.size : 18;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'aria-hidden': true, style: { opacity: props && props.active ? 1 : 0.75 } },
        h('path', {
          d: 'M20.5 11.4a7.9 7.9 0 0 1-8 8 8.2 8.2 0 0 1-3.6-.85L4 20.2l1.35-4.6A7.9 7.9 0 1 1 20.5 11.4Z',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 9, cy: 11.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 12.5, cy: 11.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 16, cy: 11.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      );
    }

    /** 设置里的「QQ 消息」页：侧边框开关 + 打开网页面板 + 状态。 */
    function QqSettings({ close }) {
      const [base, setBase] = useState(null);
      const [panelEnabled, setPanelEnabled] = useState(true);
      const [account, setAccount] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [ready, setReady] = useState(false);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const resolved = await resolveBase();
            if (!alive) return;
            setBase(resolved);
            const state = await readState(resolved);
            if (!alive) return;
            setAccount(state.account || null);
            setPanelEnabled(state.settings ? state.settings.panelEnabled !== false : true);
            setReady(true);
          } catch (cause) {
            if (alive) setError(String((cause && cause.message) || cause));
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

      const toggle = async (next) => {
        if (!base || busy) return;
        setBusy(true);
        setPanelEnabled(next);
        controller.setEnabled(next);
        try {
          await saveSetting(base, { panelEnabled: next });
        } catch (cause) {
          setError(String((cause && cause.message) || cause));
        } finally {
          setBusy(false);
        }
      };

      const connected = Boolean(account && account.backendReachable && account.loggedIn);

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 } },
        h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650 } }, text.settingsTitle),
        h('p', { style: styles.hint }, text.settingsIntro),
        h(
          'div',
          { style: styles.card },
          h(
            'label',
            { style: { ...styles.row, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: panelEnabled,
              disabled: !ready || busy,
              onChange: (event) => toggle(event.target.checked),
            }),
            h('span', { style: { fontSize: 13 } }, text.showSidebar),
          ),
          h('p', { style: styles.hint }, panelEnabled ? text.sidebarOn : text.sidebarOff),
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              {
                type: 'button',
                style: { ...styles.button, padding: '7px 14px', fontSize: 12.5 },
                onClick: () => window.open(DIRECT_BASE + '/', '_blank', 'noreferrer'),
              },
              text.openWeb,
            ),
            h('span', { style: { ...styles.hint, margin: 0 } }, DIRECT_BASE + '/'),
          ),
        ),
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.dot(connected) }),
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, connected ? text.connected : account && account.backendReachable ? text.notLoggedIn : text.offline),
            h('span', { style: { ...styles.hint, margin: 0 } }, account && account.uin ? '· ' + (account.nick || account.uin) + '（' + account.uin + '）' : ''),
          ),
          error ? h('p', { style: { ...styles.hint, color: '#ff8b9a' } }, text.failed + '：' + error) : null,
        ),
        h(
          'div',
          { style: styles.row },
          h('button', { type: 'button', style: { ...styles.button, padding: '7px 14px', fontSize: 12.5 }, onClick: () => close && close() }, text.back),
        ),
      );
    }

    /** 侧边框挂载控制：设置页可以随时把图标和面板卸掉/装回。 */
    const controller = { setEnabled() {} };

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        let stopIcon = null;
        let stopMain = null;

        const unmount = () => {
          try {
            stopIcon && stopIcon();
          } catch {
            /* ignore */
          }
          try {
            stopMain && stopMain();
          } catch {
            /* ignore */
          }
          stopIcon = null;
          stopMain = null;
        };

        const mount = () => {
          if (stopMain || stopIcon) return;
          ctx.slots.inject('main', () => {
            stopMain = ctx.slots.register({ name: 'main', key: PANEL_ID }, (props) =>
              h(QqPanel, {
                ...props,
                goChat: () => {
                  try {
                    ctx.layout.selectPanel('conversation');
                  } catch {
                    /* 宿主没有 layout 服务时忽略 */
                  }
                },
              }),
            );
            return () => {
              try {
                stopMain && stopMain();
              } catch {
                /* ignore */
              }
              stopMain = null;
            };
          });
          ctx.slots.inject('sidebar.panellist', () => {
            stopIcon = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => text.panel },
              QqIcon,
            );
            return () => {
              try {
                stopIcon && stopIcon();
              } catch {
                /* ignore */
              }
              stopIcon = null;
            };
          });
        };

        controller.setEnabled = (enabled) => {
          if (enabled) mount();
          else unmount();
        };

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'qq', order: 36, label: () => text.settingsLabel }, QqSettings),
        );

        ctx.effect(() => {
          let alive = true;
          (async () => {
            try {
              const base = await resolveBase();
              const state = await readState(base);
              if (alive && state.settings && state.settings.panelEnabled !== false) mount();
            } catch {
              // 面板服务没起来也先把入口装上，页面里会提示
              if (alive) mount();
            }
          })();
          return () => {
            alive = false;
            unmount();
          };
        }, 'dsh-qq: sidebar panel lifecycle');
      },
    };
  },
});
