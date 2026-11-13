import fs from 'node:fs';
import { env, log, http, azdToken, sleep, HttpError } from '../lib/util.mjs';
import { SITES } from './sharepoint.mjs';

export const API_VERSION = '2026-08-01-preview';

function template(name, vars) {
  const raw = fs.readFileSync(new URL(`../../search/${name}.json`, import.meta.url), 'utf8');
  const filled = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => {
    const v = vars[k] ?? process.env[k];
    if (v === undefined) throw new Error(`Template ${name}.json needs ${k}`);
    return v;
  });
  return JSON.parse(filled);
}

export async function search(path, opts = {}) {
  const url = `${env('SEARCH_ENDPOINT')}/${path}${path.includes('?') ? '&' : '?'}api-version=${API_VERSION}`;
  // Role assignments for the deploying admin can take a few minutes to propagate.
  for (let i = 0; ; i++) {
    try {
      return await http(url, { ...opts, token: azdToken('https://search.azure.com/.default') });
    } catch (e) {
      if (e instanceof HttpError && e.status === 403 && i < 20) {
        if (i === 0) log.info('waiting for Azure AI Search role assignments to propagate...');
        await sleep(15000);
        continue;
      }
      throw e;
    }
  }
}

const put = (path, body) => search(path, { method: 'PUT', body, headers: { Prefer: 'return=representation' } });

export async function setupSearch({ runAndWait = true } = {}) {
  log.step('Azure AI Search pipeline (index, skillset, one data source + indexer per site)');
  process.env.INDEXER_SCHEDULE = env('INDEXER_SCHEDULE', 'PT15M');
  const index = env('SEARCH_INDEX_NAME');

  try {
    await put(`indexes('${index}')?allowIndexDowntime=true`, template('index', {}));
  } catch (e) {
    // Field removals/renames can't be applied in place: recreate the index (indexers re-populate it).
    if (!(e instanceof HttpError) || e.status !== 400) throw e;
    log.warn(`index schema change needs a rebuild: ${String(e.body?.error?.message ?? '').slice(0, 160)}`);
    await search(`indexes('${index}')`, { method: 'DELETE' });
    await put(`indexes('${index}')`, template('index', {}));
    for (const key of Object.keys(SITES)) {
      await search(`indexers('ixr-${key}')/search.reset`, { method: 'POST' }).catch(() => {});
    }
  }
  log.ok(`index ${index} (permissionFilterOption=enabled, SharePoint group resolution configured)`);
  await put(`skillsets('sharepoint-acl-skillset')`, template('skillset', {}));
  log.ok('skillset sharepoint-acl-skillset (split + embed, ACL projected per chunk)');

  const created = [];
  for (const key of Object.keys(SITES)) {
    const vars = { SITE_KEY: key, SITE_URL: env(`SITE_${key.toUpperCase()}_URL`) };
    await put(`datasources('ds-${key}')`, template('datasource', vars));
    try {
      await put(`indexers('ixr-${key}')`, template('indexer', vars));
      log.ok(`data source ds-${key} + indexer ixr-${key} (schedule ${process.env.INDEXER_SCHEDULE})`);
      created.push(key);
    } catch (e) {
      // Azure AI Search validates data source access when the indexer is created.
      // For the site WITHOUT a Sites.Selected grant this must fail: that's the proof.
      const msg = String(e.body?.error?.message ?? e.message);
      if (!SITES[key].granted && e instanceof HttpError && e.status === 400 && /accessDenied|Access denied/i.test(msg)) {
        log.ok(`ixr-${key} REJECTED by Azure AI Search as expected (no Sites.Selected grant): ${msg.split('\r\n').slice(0, 2).join(' ')}`);
        continue;
      }
      throw e;
    }
  }

  if (!runAndWait) return;
  const triggered = Date.now() - 60_000;
  for (const key of created) {
    try {
      await search(`indexers('ixr-${key}')/search.run`, { method: 'POST' });
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 409) throw e; // 409: already running
    }
  }
  await waitForIndexers(created, 20, triggered);
}

export async function indexerStatus(key) {
  const s = await search(`indexers('ixr-${key}')/search.status`);
  const last = s.lastResult;
  return {
    key,
    status: last?.status ?? s.status,
    itemsProcessed: last?.itemsProcessed,
    itemsFailed: last?.itemsFailed,
    error: last?.errorMessage ?? last?.errors?.[0]?.errorMessage,
    startTime: last?.startTime,
    endTime: last?.endTime,
  };
}

export async function waitForIndexers(keys = Object.keys(SITES), timeoutMinutes = 20, since = 0) {
  log.step('Waiting for the first indexer runs');
  const deadline = Date.now() + timeoutMinutes * 60_000;
  const done = new Map();
  while (Date.now() < deadline && done.size < keys.length) {
    for (const key of keys) {
      if (done.has(key)) continue;
      const st = await indexerStatus(key);
      const finished = st.status && !['inProgress', 'reset'].includes(st.status) && st.endTime;
      if (finished && Date.parse(st.startTime ?? st.endTime) >= since) done.set(key, st);
    }
    if (done.size < keys.length) await sleep(15000);
  }
  for (const key of keys) {
    const st = done.get(key);
    if (!st) { log.warn(`ixr-${key}: still running (check the Admin tab later)`); continue; }
    const line = `ixr-${key}: ${st.status}, ${st.itemsProcessed ?? 0} processed, ${st.itemsFailed ?? 0} failed`;
    if (SITES[key].granted) {
      st.status === 'success' && !st.itemsFailed ? log.ok(line) : log.warn(`${line}\n      ${st.error ?? 'see item errors in the Admin tab / indexer status'}`);
    } else {
      st.status === 'success' && (st.itemsProcessed ?? 0) > 0
        ? log.err(`${line} -- UNEXPECTED: the ungranted site was readable`)
        : log.ok(`${line} -- expected: no Sites.Selected grant${st.error ? `\n      ${st.error.slice(0, 300)}` : ''}`);
    }
  }
}
