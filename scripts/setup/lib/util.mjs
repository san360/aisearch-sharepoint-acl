import { execFileSync } from 'node:child_process';

const isWin = process.platform === 'win32';

export const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

export const log = {
  step: (s) => console.log(`\n${c.bold(c.cyan('==> ' + s))}`),
  ok: (s) => console.log(`  ${c.green('✔')} ${s}`),
  info: (s) => console.log(`  ${c.dim('•')} ${s}`),
  warn: (s) => console.log(`  ${c.yellow('!')} ${s}`),
  err: (s) => console.log(`  ${c.red('✖')} ${s}`),
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment value ${name}. Run 'azd provision' first or 'azd env set ${name} <value>'.`);
  }
  return v;
}

function azd(args) {
  return execFileSync(isWin ? 'azd.exe' : 'azd', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function azdEnvSet(name, value) {
  azd(['env', 'set', name, String(value)]);
  process.env[name] = String(value);
}

// When run outside an azd hook, load the azd environment values ourselves.
export function loadAzdEnv() {
  if (process.env.AZURE_ENV_NAME && process.env.SEARCH_ENDPOINT) return;
  const out = azd(['env', 'get-values', '--output', 'json']);
  for (const [k, v] of Object.entries(JSON.parse(out))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const tokenCache = new Map();
// Azure Resource Manager / Azure AI Search tokens come from the azd login.
export function azdToken(scope) {
  const hit = tokenCache.get(scope);
  if (hit && hit.exp - Date.now() > 5 * 60_000) return hit.token;
  const args = ['auth', 'token', '--scope', scope, '--output', 'json'];
  if (process.env.AZURE_TENANT_ID) args.push('--tenant-id', process.env.AZURE_TENANT_ID);
  const res = JSON.parse(azd(args));
  tokenCache.set(scope, { token: res.token, exp: Date.parse(res.expiresOn) });
  return res.token;
}

export class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} ${url}\n${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

// fetch wrapper: JSON in/out, retries on throttling and transient errors.
export async function http(url, { method = 'GET', token, headers = {}, body, raw = false, retries = 5, retryOn = [] } = {}) {
  for (let attempt = 0; ; attempt++) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
      payload = JSON.stringify(body);
      h['Content-Type'] ??= 'application/json';
    }
    const res = await fetch(url, { method, headers: h, body: payload });
    if (res.ok) {
      if (raw) return res;
      const text = await res.text();
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    }
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    const transient = res.status === 429 || res.status >= 500 || retryOn.includes(res.status);
    if (transient && attempt < retries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || Math.min(30_000, 2000 * 2 ** attempt);
      await sleep(wait);
      continue;
    }
    throw new HttpError(res.status, parsed, `${method} ${url}`);
  }
}
