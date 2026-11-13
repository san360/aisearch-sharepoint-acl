import { appToken } from './credentials.mjs';
import { config } from './config.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const cache = new Map();

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, exp: Date.now() + ttlMs });
  return value;
}

async function graph(path, init = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await appToken('https://graph.microsoft.com/.default')}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
  return res.json();
}

// Fresh lookup (no cache) so membership changes made in the Admin tab show up at once.
export async function userGroups(oid) {
  const res = await graph(`/users/${oid}/transitiveMemberOf/microsoft.graph.group?$select=id,displayName&$top=100`);
  return res.value.map((g) => ({ id: g.id, name: g.displayName }));
}

export function isAdmin(oid) {
  return cached(`admin:${oid}`, 60_000, async () => {
    if (!config.groups.admins) return false;
    const res = await graph(`/users/${oid}/checkMemberGroups`, { method: 'POST', body: JSON.stringify({ groupIds: [config.groups.admins] }) });
    return res.value.includes(config.groups.admins);
  });
}

// Resolve ACL principal IDs (Entra users/groups, SharePoint site groups) to names.
export async function resolvePrincipals(ids) {
  const out = {};
  await Promise.all([...new Set(ids)].map(async (id) => {
    if (id.startsWith('spg:')) {
      // Format: spg:<site url>:<SharePoint group id>. New sites use 3/4/5 for Owners/Visitors/Members.
      const m = /^spg:(.+):(\d+)$/.exec(id);
      const site = m ? m[1].split('/').pop() : '';
      const role = { 3: 'Owners', 4: 'Visitors', 5: 'Members' }[m?.[2]] ?? `group ${m?.[2] ?? id.slice(4)}`;
      out[id] = { kind: 'sharepoint-group', name: `SP ${site} ${role}` };
      return;
    }
    out[id] = await cached(`p:${id}`, 10 * 60_000, async () => {
      for (const kind of ['groups', 'users']) {
        try {
          const o = await graph(`/${kind}/${id}?$select=displayName`);
          return { kind: kind === 'groups' ? 'entra-group' : 'user', name: o.displayName };
        } catch { /* try next */ }
      }
      return { kind: 'unknown', name: id };
    });
  }));
  return out;
}
