import { graphToken, sharePointToken } from './auth.mjs';
import { env, http } from './util.mjs';

export const GRAPH = 'https://graph.microsoft.com/v1.0';

export async function graph(pathOrUrl, opts = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  return http(url, { ...opts, token: await graphToken() });
}

export async function graphAll(path) {
  const items = [];
  let next = `${GRAPH}${path}`;
  while (next) {
    const page = await graph(next);
    items.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
  }
  return items;
}

// Graph as the admin's `azd auth login` session. Used for directory operations the deployment-only setup app is not
// consented for (reading/deleting app registrations, purging deleted items), so the setup app stays narrower.
let azdGraphToken;
export async function azdGraph(pathOrUrl, opts = {}) {
  if (!azdGraphToken) {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('azd', ['auth', 'token', '--scope', 'https://graph.microsoft.com/.default',
      '--tenant-id', env('AZURE_TENANT_ID'), '--output', 'json'], { encoding: 'utf8' });
    azdGraphToken = JSON.parse(out).token;
  }
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  return http(url, { ...opts, token: azdGraphToken });
}

// SharePoint REST (JSON light, no metadata)
export async function spo(siteUrl, apiPath, { method = 'GET', body, headers = {} } = {}) {
  return http(`${siteUrl}/_api/${apiPath}`, {
    method,
    body,
    token: await sharePointToken(),
    headers: {
      Accept: 'application/json;odata=nometadata',
      'Content-Type': 'application/json;odata=nometadata',
      ...headers,
    },
  });
}

export function siteUrl(key) {
  return env(`SITE_${key.toUpperCase()}_URL`);
}
