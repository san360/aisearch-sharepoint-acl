import { ingestCredential, decodeJwt } from './credentials.mjs';
import { config, collections } from './config.mjs';
import { indexerStatus } from './search.mjs';

// Sites.Selected proof: call Microsoft Graph AS the ingestion app (app-only,
// via its federated credential) and try to read each site. Admin consent for
// Sites.Selected is identical for all three sites; only the per-site grant differs.
async function probeSite(token, site) {
  const u = new URL(site.url);
  const started = Date.now();
  const res = await fetch(`https://graph.microsoft.com/v1.0/sites/${u.hostname}:${u.pathname}?$select=id,displayName`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = { httpStatus: res.status, ms: Date.now() - started };
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    result.error = body?.error?.message ?? res.statusText;
    return result;
  }
  const s = await res.json();
  result.displayName = s.displayName;
  const files = await fetch(`https://graph.microsoft.com/v1.0/sites/${s.id}/drive/root/children?$select=name,folder&$top=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  result.listHttpStatus = files.status;
  if (files.ok) result.items = (await files.json()).value.map((f) => (f.folder ? `${f.name}/` : f.name));
  return result;
}

export async function proof() {
  const cred = ingestCredential();
  let token;
  let tokenInfo = null;
  let tokenError = null;
  if (cred) {
    try {
      token = (await cred.getToken('https://graph.microsoft.com/.default')).token;
      const claims = decodeJwt(token);
      tokenInfo = { appId: claims.appid, appDisplayName: claims.app_displayname, roles: claims.roles ?? [], tenant: claims.tid };
    } catch (e) {
      tokenError = e.message;
    }
  } else {
    tokenError = 'The live probe runs in Azure only (it uses the web app managed identity as a federated credential).';
  }

  // Sites.Selected grants are per site collection; subsites are covered by their collection's grant.
  const sites = await Promise.all(collections().map(async (site) => ({
    ...site,
    probe: token ? await probeSite(token, site).catch((e) => ({ error: e.message })) : null,
    indexer: await indexerStatus(site.key),
  })));
  return { tokenInfo, tokenError, sites };
}
