import { ingestCredential, decodeJwt } from './credentials.mjs';
import { config } from './config.mjs';

// API lab, server side: calls made AS THE INGESTION APP (app-only token via its federated credential).
// Only fixed, read-only operations are allowed — never a free-form URL — because the app can read every granted site
// regardless of the caller's own SharePoint permissions. Operations that reveal more than site/folder names or
// SharePoint group names are restricted to the demo admins.
export const APP_OPS = {
  'app-token': { admin: false },
  'app-get-site': { admin: false },
  'app-list-root': { admin: false },
  'app-get-grants': { admin: false },
  'app-sp-sitegroups': { admin: false },
  'app-item-permissions': { admin: true },
  'app-sp-group-users': { admin: true },
  'app-sp-roleassignments': { admin: true },
};

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GUIDISH = /^[A-Za-z0-9!_\-.,]{1,200}$/;
const siteCache = new Map();

async function token(resource) {
  const cred = ingestCredential();
  if (!cred) throw Object.assign(new Error('App-only calls run in Azure only (the web app managed identity is the federated credential).'), { status: 501 });
  return (await cred.getToken(`${resource}/.default`)).token;
}

async function call(method, url, tok, accept = 'application/json') {
  const started = Date.now();
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${tok}`, Accept: accept } });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text.slice(0, 4000); }
  return {
    request: { method, url, headers: { Authorization: 'Bearer <ingestion app token — redacted>', Accept: accept } },
    response: {
      status: res.status,
      ms: Date.now() - started,
      headers: Object.fromEntries(['request-id', 'client-request-id', 'sprequestguid', 'date'].filter((h) => res.headers.get(h)).map((h) => [h, res.headers.get(h)])),
      body,
    },
  };
}

function siteFor(key) {
  const site = config.sites.find((s) => s.key === key && s.url);
  if (!site) throw Object.assign(new Error(`unknown site '${key}'`), { status: 400 });
  return site;
}

async function graphSiteId(site, tok) {
  if (siteCache.has(site.key)) return { id: siteCache.get(site.key) };
  const u = new URL(site.url);
  const r = await call('GET', `${GRAPH}/sites/${u.hostname}:${u.pathname}?$select=id`, tok);
  if (r.response.status !== 200) return { failed: r };
  siteCache.set(site.key, r.response.body.id);
  return { id: r.response.body.id };
}

export async function runAppOp(op, { site: siteKey, itemId, groupId } = {}) {
  if (op === 'app-token') {
    const tok = await token('https://graph.microsoft.com');
    const c = decodeJwt(tok);
    const pick = ['aud', 'iss', 'appid', 'app_displayname', 'idtyp', 'roles', 'oid', 'tid', 'xms_mirid', 'iat', 'exp'];
    return {
      request: { method: 'POST', url: `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, headers: {}, body: {
        grant_type: 'client_credentials', client_id: config.ingestClientId, scope: 'https://graph.microsoft.com/.default',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: '<web app managed identity token for api://AzureADTokenExchange — redacted>',
      } },
      response: { status: 200, ms: 0, headers: {}, body: { note: 'Decoded claims of the access token (the token itself is not shown).', claims: Object.fromEntries(pick.filter((k) => c[k] !== undefined).map((k) => [k, c[k]])) } },
    };
  }

  const site = siteFor(siteKey);
  if (op.startsWith('app-sp-')) {
    const host = new URL(site.url).origin;
    const tok = await token(host);
    const accept = 'application/json;odata=nometadata';
    if (op === 'app-sp-sitegroups') return call('GET', `${site.url}/_api/web/sitegroups?$select=Id,Title,OwnerTitle`, tok, accept);
    if (op === 'app-sp-roleassignments') return call('GET', `${site.url}/_api/web/roleassignments?$expand=Member,RoleDefinitionBindings&$select=Member/Id,Member/Title,Member/PrincipalType,RoleDefinitionBindings/Name`, tok, accept);
    if (op === 'app-sp-group-users') {
      if (!/^\d{1,6}$/.test(String(groupId ?? ''))) throw Object.assign(new Error('groupId must be a SharePoint group number, e.g. 5'), { status: 400 });
      return call('GET', `${site.url}/_api/web/sitegroups/getbyid(${groupId})/users?$select=Id,Title,Email,PrincipalType`, tok, accept);
    }
  }

  const tok = await token('https://graph.microsoft.com');
  if (op === 'app-get-site') {
    const u = new URL(site.url);
    const r = await call('GET', `${GRAPH}/sites/${u.hostname}:${u.pathname}?$select=id,displayName,webUrl`, tok);
    if (r.response.status === 200) siteCache.set(site.key, r.response.body.id);
    return r;
  }
  const sid = await graphSiteId(site, tok);
  if (sid.failed) return { ...sid.failed, note: 'Resolving the site ID already failed, so the operation was not attempted.' };
  if (op === 'app-list-root') return call('GET', `${GRAPH}/sites/${sid.id}/drive/root/children?$select=id,name,folder,webUrl`, tok);
  if (op === 'app-get-grants') return call('GET', `${GRAPH}/sites/${sid.id}/permissions`, tok);
  if (op === 'app-item-permissions') {
    if (!GUIDISH.test(String(itemId ?? ''))) throw Object.assign(new Error('itemId required (run "List folders as the app" and pick one)'), { status: 400 });
    return call('GET', `${GRAPH}/sites/${sid.id}/drive/items/${itemId}/permissions`, tok);
  }
  throw Object.assign(new Error(`unknown operation '${op}'`), { status: 400 });
}
