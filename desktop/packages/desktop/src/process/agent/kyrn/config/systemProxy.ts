import { execFileSync } from 'node:child_process';

/**
 * The proxy set in the system's network settings, for the mu processes the app starts.
 *
 * A browser on macOS or Windows follows that proxy; Node reads only HTTP(S)_PROXY, and an app opened from the Dock or
 * the Start menu has neither. With a proxy on (the usual way to reach Google, OpenAI or Anthropic from mainland China),
 * mu in the app then went straight to the provider: Google answered "User location is not supported", or the connection
 * timed out, while the same mu in a terminal that exports HTTPS_PROXY worked. So when the environment names no proxy,
 * the system's is handed on as HTTP_PROXY / HTTPS_PROXY / NO_PROXY, which pi's HTTP client honours.
 *
 * Only what those variables can say is used: an HTTP proxy per scheme and host exceptions. A proxy auto-config (PAC)
 * file or a SOCKS-only proxy is left alone, and so is an environment that already names any proxy (the person's own).
 */
export interface SystemProxy {
  http?: string;
  https?: string;
  exceptions: string[];
}

const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
/** Never through a proxy: the local judge and anything else mu talks to on this machine. */
const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1'];

const address = (host: string | undefined, port: string | undefined): string | undefined =>
  host && port && /^\d+$/.test(port) ? `http://${host.includes(':') ? `[${host}]` : host}:${port}` : undefined;

/** `scutil --proxy` (macOS). */
export function parseScutil(output: string): SystemProxy | undefined {
  const values = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const line of output.split('\n')) {
    if (/^\s*ExceptionsList : <array> \{/.test(line)) {
      inExceptions = true;
      continue;
    }
    if (inExceptions) {
      if (/^\s*\}/.test(line)) inExceptions = false;
      else {
        const item = line.match(/^\s*\d+ : (.+?)\s*$/);
        if (item) exceptions.push(item[1]);
      }
      continue;
    }
    const pair = line.match(/^\s*(\w+) : (.+?)\s*$/);
    if (pair) values.set(pair[1], pair[2]);
  }
  const on = (key: string) => values.get(`${key}Enable`) === '1';
  const http = on('HTTP') ? address(values.get('HTTPProxy'), values.get('HTTPPort')) : undefined;
  const https = on('HTTPS') ? address(values.get('HTTPSProxy'), values.get('HTTPSPort')) : undefined;
  return http || https ? { http, https, exceptions } : undefined;
}

/** `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` (Windows). */
export function parseInternetSettings(output: string): SystemProxy | undefined {
  const value = (name: string) => output.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'm'))?.[1];
  if (!/^0x0*1$/i.test(value('ProxyEnable') ?? '')) return undefined;
  const server = value('ProxyServer');
  if (!server) return undefined;
  const hostPort = (text: string | undefined) => {
    const parts = text?.match(/^(?:https?:\/\/)?(.+):(\d+)$/);
    return parts ? address(parts[1], parts[2]) : undefined;
  };
  // Either one proxy for everything ("127.0.0.1:7890") or one per scheme ("http=h:p;https=h:p;socks=h:p").
  const perScheme = new Map(
    server
      .split(';')
      .map((entry) => entry.split('='))
      .filter((pair) => pair.length === 2)
      .map(([scheme, target]) => [scheme.trim().toLowerCase(), target.trim()])
  );
  const http = perScheme.size ? hostPort(perScheme.get('http')) : hostPort(server);
  const https = perScheme.size ? hostPort(perScheme.get('https')) : hostPort(server);
  const exceptions = (value('ProxyOverride') ?? '').split(';').map((entry) => entry.trim());
  return http || https ? { http, https, exceptions } : undefined;
}

/**
 * The variables to add. An exception becomes a NO_PROXY entry when NO_PROXY can express it: a host, an address or a
 * domain suffix ("*.local"). Address ranges ("10.0.0.0/8", Windows' "10.*") and Windows' "<local>" cannot be, and are
 * dropped: such hosts then go through the proxy, which reaches them as well.
 */
export function proxyEnv(env: NodeJS.ProcessEnv, proxy: SystemProxy | undefined): Record<string, string> {
  if (!proxy || PROXY_VARIABLES.some((name) => env[name])) return {};
  const direct = [
    ...ALWAYS_DIRECT,
    ...proxy.exceptions.filter((entry) => entry && !entry.includes('/') && !/[<>]/.test(entry) && !/.\*/.test(entry)),
  ];
  const noProxy = [...new Set([...(env.NO_PROXY ?? env.no_proxy ?? '').split(','), ...direct])]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(',');
  return {
    ...(proxy.http ? { HTTP_PROXY: proxy.http } : {}),
    ...(proxy.https ? { HTTPS_PROXY: proxy.https } : {}),
    NO_PROXY: noProxy,
  };
}

type Run = (command: string, args: string[]) => string;

const run: Run = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/** The system's proxy settings, or undefined where they cannot be read (Linux, a failing command). */
export function readSystemProxy(platform: NodeJS.Platform, read: Run = run): SystemProxy | undefined {
  try {
    if (platform === 'darwin') return parseScutil(read('/usr/sbin/scutil', ['--proxy']));
    if (platform === 'win32') {
      return parseInternetSettings(
        read('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'])
      );
    }
  } catch {
    // Unreadable settings leave the environment as it is.
  }
  return undefined;
}

let cached: Record<string, string> | undefined;

/** What `proxyEnv` adds for this process's environment, read once per process: every mu started here shares it. */
export function systemProxyEnv(): Record<string, string> {
  cached ??= proxyEnv(process.env, readSystemProxy(process.platform));
  return cached;
}
