import { appToken } from './credentials.mjs';
import { config } from './config.mjs';

const SELECT = 'chunk_id,parent_id,title,url,metadata_spo_item_path,site,last_modified,chunk';

export async function searchApi(path, { method = 'GET', body, headers = {} } = {}) {
  const url = `${config.searchEndpoint}/${path}${path.includes('?') ? '&' : '?'}api-version=${config.searchApiVersion}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await appToken('https://search.azure.com/.default')}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    let message = data?.error?.message ?? `Search ${res.status}`;
    if (/siteusers\/getbyemail.*User cannot be found/s.test(message)) {
      message = 'Azure AI Search could not resolve your SharePoint site-group memberships: your account is not in the '
        + 'user list of every indexed site (open each site once, or have an admin run '
        + '"node scripts/setup/index.mjs --only sharepoint"). Details: ' + message;
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Query the index on behalf of the signed-in user.
 * - Authorization: the app's managed identity (needs a Search data role).
 * - x-ms-query-source-authorization: the USER's token. Azure AI Search resolves
 *   the user's object ID + transitive Entra groups (+ SharePoint site groups)
 *   and trims results against the UserIds/GroupIds stored on each chunk.
 * - elevated=true (admins only) adds x-ms-enable-elevated-read to bypass trimming.
 */
export async function searchAsUser(userToken, { q = '*', mode = 'hybrid', top = 10, elevated = false, withAcl = false } = {}) {
  const text = q?.trim() || '*';
  const body = {
    search: text,
    top,
    count: true,
    select: withAcl ? `${SELECT},UserIds,GroupIds` : SELECT,
    highlight: 'chunk',
    highlightPreTag: '<mark>',
    highlightPostTag: '</mark>',
  };
  if ((mode === 'semantic' || mode === 'hybrid') && text !== '*') {
    body.queryType = 'semantic';
    body.semanticConfiguration = 'semantic-config';
    body.captions = 'extractive';
  }
  if (mode === 'hybrid' && text !== '*') {
    body.vectorQueries = [{ kind: 'text', text, fields: 'chunk_vector', k: 50 }];
  }
  const headers = {};
  // Elevated read can't be combined with a user token: it's an admin-only, untrimmed view.
  if (elevated) headers['x-ms-enable-elevated-read'] = 'true';
  else if (userToken) headers['x-ms-query-source-authorization'] = userToken;

  const started = Date.now();
  const data = await searchApi(`indexes('${config.indexName}')/docs/search.post.search`, { method: 'POST', body, headers });
  return {
    count: data['@odata.count'] ?? data.value.length,
    tookMs: Date.now() - started,
    results: data.value.map((d) => ({
      id: d.chunk_id,
      parentId: d.parent_id,
      title: d.title,
      url: d.url,
      path: d.metadata_spo_item_path,
      site: d.site,
      lastModified: d.last_modified,
      score: d['@search.rerankerScore'] ?? d['@search.score'],
      caption: d['@search.captions']?.[0]?.highlights || d['@search.captions']?.[0]?.text,
      highlight: d['@search.highlights']?.chunk?.[0],
      chunk: d.chunk,
      ...(withAcl ? { userIds: d.UserIds ?? [], groupIds: d.GroupIds ?? [] } : {}),
    })),
  };
}

export async function indexerStatus(key) {
  try {
    const s = await searchApi(`indexers('ixr-${key}')/search.status`);
    const last = s.lastResult;
    return {
      key,
      overall: s.status,
      status: last?.status ?? 'notRun',
      itemsProcessed: last?.itemsProcessed ?? 0,
      itemsFailed: last?.itemsFailed ?? 0,
      startTime: last?.startTime,
      endTime: last?.endTime,
      error: last?.errorMessage ?? last?.errors?.[0]?.errorMessage ?? null,
      history: (s.executionHistory ?? []).slice(0, 5).map((h) => ({
        status: h.status, startTime: h.startTime, endTime: h.endTime, itemsProcessed: h.itemsProcessed, itemsFailed: h.itemsFailed,
        error: h.errorMessage ?? h.errors?.[0]?.errorMessage ?? null,
      })),
    };
  } catch (e) {
    const granted = config.sites.find((s) => s.key === key)?.granted;
    if (e.status === 404 && granted === false) {
      return {
        key,
        status: 'rejected',
        error: 'No indexer exists for this site: Azure AI Search validates SharePoint access when an indexer is created, and rejected it with "accessDenied" because the ingestion app has no Sites.Selected grant on this site.',
      };
    }
    return { key, status: 'unavailable', error: e.message };
  }
}

export async function indexerDefinition(key) {
  const ixr = await searchApi(`indexers('ixr-${key}')`);
  return { schedule: ixr.schedule };
}

export async function indexStats() {
  return searchApi(`indexes('${config.indexName}')/search.stats`);
}
