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
