/**
 * NapCat 进程侧操作：提权拉起 launcher（工具 qq_backend 与网页面板共用）。
 * @module dsh-qq/backend
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 用 PowerShell 的 Start-Process -Verb RunAs 提权启动 NapCat 的 launcher。
 *
 * 注意：这里**不能 detached**。之前用 detached + stdio:'ignore' 时，从宿主进程里
 * launch 出去的 powershell 偶发凭空消失（ExitCode 0 但 NapCat 没起来），
 * 非 detached 的普通 spawn 稳定可用。
 * @param {string} launcherPath
 * @param {string} [account] 传 QQ 号则走快速登录
 * @returns {{started: boolean, reason?: string}}
 */
export function startLauncher(launcherPath, account) {
  if (!launcherPath || !existsSync(launcherPath)) {
    return { started: false, reason: '启动器不存在：' + (launcherPath || '(未配置 launcherPath)') };
  }
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'];
  const inner =
    'Start-Process -FilePath ' + quote(launcherPath) +
    ' -WorkingDirectory ' + quote(dirname(launcherPath)) +
    (account ? ' -ArgumentList ' + quote(account) : '') +
    ' -Verb RunAs';
  args.push(inner);
  try {
    const child = spawn('powershell.exe', args, {
      cwd: dirname(launcherPath),
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {
      /* 宿主进程里没地方报了，面板靠端口轮询判断成败 */
    });
    child.unref();
    return { started: true };
  } catch (error) {
    return { started: false, reason: '启动失败：' + (error && error.message ? error.message : String(error)) };
  }
}

/**
 * 启动 NapCat 并等 OneBot 端口起来。
 * @param {{launcherPath: string, account?: string, baseUrl: string, timeoutMs?: number}} options
 * @param {(baseUrl: string) => Promise<boolean>} probePort
 */
export async function startLauncherAndWait(options, probePort) {
  const timeoutMs = Math.min(90000, Number(options.timeoutMs) || 45000);
  const startedAt = Date.now();
  const launched = startLauncher(options.launcherPath, options.account);
  if (!launched.started) return { ok: false, started: false, reason: launched.reason, waitedMs: 0 };

  let portOpen = await probePort(options.baseUrl);
  while (!portOpen && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    portOpen = await probePort(options.baseUrl);
  }
  return {
    ok: portOpen,
    started: true,
    portOpen,
    waitedMs: Date.now() - startedAt,
    reason: portOpen ? null : '启动器已拉起，但 ' + Math.round(timeoutMs / 1000) + ' 秒内 OneBot 端口没起来（看 NapCat 控制台窗口是否报错）',
  };
}
