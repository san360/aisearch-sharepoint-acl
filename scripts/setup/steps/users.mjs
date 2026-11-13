import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { graph } from '../lib/clients.mjs';
import { env, log, sleep, HttpError, azdEnvSet } from '../lib/util.mjs';

export const PERSONAS = [
  { key: 'alice', displayName: 'Alice Quantum', jobTitle: 'Quantum researcher', groups: ['GROUP_ALL_STAFF_ID', 'GROUP_QUANTUM_ID'] },
  { key: 'bob', displayName: 'Bob Finance', jobTitle: 'Finance analyst', groups: ['GROUP_ALL_STAFF_ID'] },
  { key: 'carol', displayName: 'Carol Biology', jobTitle: 'Biology researcher', groups: ['GROUP_ALL_STAFF_ID'] },
];

function password() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%*-_+='];
  const all = sets.join('');
  const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (chars.length < 20) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function addMember(groupId, userId) {
  try {
    await graph(`/groups/${groupId}/members/$ref`, {
      method: 'POST',
      body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` },
    });
    return true;
  } catch (e) {
    if (e instanceof HttpError && e.status === 400 && JSON.stringify(e.body).includes('already exist')) return false;
    throw e;
  }
}

async function pickSharePointSku() {
  const skus = (await graph('/subscribedSkus')).value;
  const withSpo = skus.filter((s) =>
    s.capabilityStatus === 'Enabled' &&
    s.servicePlans.some((p) => p.servicePlanName.startsWith('SHAREPOINTENTERPRISE')));
  return withSpo.sort((a, b) =>
    (b.prepaidUnits.enabled - b.consumedUnits) - (a.prepaidUnits.enabled - a.consumedUnits))[0];
}

async function ensureTapPolicy(groupId) {
  const base = '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/TemporaryAccessPass';
  const cfg = await graph(base);
  const targets = cfg.includeTargets ?? [];
  const covered = targets.some((t) => t.id === groupId || t.id === 'all_users');
  if (cfg.state === 'enabled' && covered) return cfg.maximumLifetimeInMinutes;
  // When TAP was disabled, enable it ONLY for the demo personas group.
  const newTargets = cfg.state === 'enabled' ? [...targets, { id: groupId }] : [{ id: groupId }];
  await graph(base, {
    method: 'PATCH',
    body: {
      '@odata.type': '#microsoft.graph.temporaryAccessPassAuthenticationMethodConfiguration',
      state: 'enabled',
      includeTargets: newTargets.map((t) => ({ id: t.id, targetType: t.targetType ?? 'group', isRegistrationRequired: false })),
    },
  });
  log.ok('Temporary Access Pass method enabled for the demo personas group only');
  return cfg.maximumLifetimeInMinutes;
}

async function issueTap(userId, maxLifetime) {
  const base = `/users/${userId}/authentication/temporaryAccessPassMethods`;
  for (const old of (await graph(base)).value ?? []) {
    await graph(`${base}/${old.id}`, { method: 'DELETE' });
  }
  const lifetime = Math.min(Number(env('DEMO_TAP_LIFETIME_MINUTES', '480')), maxLifetime ?? 480);
  // Right after the TAP policy is enabled, issuance returns 400 for a minute or two.
  for (let i = 0; ; i++) {
    try {
      const tap = await graph(base, { method: 'POST', body: { lifetimeInMinutes: lifetime, isUsableOnce: false } });
      return tap.temporaryAccessPass;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 400 || i >= 12) throw e;
      await sleep(15000);
    }
  }
}

export async function ensureUsers({ issueTaps = env('DEMO_ISSUE_TAP', 'true') === 'true' } = {}) {
  log.step('Demo personas (Entra users, group memberships, licences, sign-in passes)');
  const org = (await graph('/organization?$select=verifiedDomains')).value[0];
  const domain = (org.verifiedDomains.find((d) => d.isDefault) ?? org.verifiedDomains[0]).name;
  const prefix = env('DEMO_PREFIX', 'acldemo');
  const usageLocation = env('DEMO_USAGE_LOCATION', 'FR');
  const credentials = new Map();
  const sku = await pickSharePointSku();
  if (!sku) log.warn('No licence including SharePoint found: personas can still search, but cannot open documents in SharePoint.');

  const users = {};
  for (const p of PERSONAS) {
    const upn = `${p.key}.${prefix}@${domain}`.toLowerCase();
    let user;
    try {
      user = await graph(`/users/${encodeURIComponent(upn)}?$select=id,userPrincipalName,assignedLicenses`);
      log.info(`${upn} already exists`);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
      const pwd = password();
      user = await graph('/users', {
        method: 'POST',
        body: {
          accountEnabled: true,
          displayName: p.displayName,
          jobTitle: p.jobTitle,
          mailNickname: `${p.key}.${prefix}`,
          userPrincipalName: upn,
          usageLocation,
          passwordProfile: { password: pwd, forceChangePasswordNextSignIn: false },
        },
      });
      user.assignedLicenses = [];
      credentials.set(upn, { password: pwd });
      log.ok(`created ${upn}`);
    }
    users[p.key] = { id: user.id, upn, displayName: p.displayName };
    azdEnvSet(`PERSONA_${p.key.toUpperCase()}_UPN`, upn);
    azdEnvSet(`PERSONA_${p.key.toUpperCase()}_ID`, user.id);

    if (sku && !user.assignedLicenses?.some((l) => l.skuId === sku.skuId)) {
      try {
        await graph(`/users/${user.id}`, { method: 'PATCH', body: { usageLocation } });
        await graph(`/users/${user.id}/assignLicense`, {
          method: 'POST',
          body: { addLicenses: [{ skuId: sku.skuId, disabledPlans: [] }], removeLicenses: [] },
        });
        log.ok(`licensed ${upn} (${sku.skuPartNumber})`);
      } catch (e) {
        log.warn(`could not license ${upn}: ${e.message.split('\n')[0]}`);
      }
    }

    for (const g of [...p.groups, 'GROUP_DEMO_USERS_ID']) {
      if (await addMember(env(g), user.id)) log.ok(`${p.key} added to ${g.replace(/^GROUP_|_ID$/g, '').toLowerCase()}`);
    }
  }

  if (issueTaps) {
    try {
      const maxLifetime = await ensureTapPolicy(env('GROUP_DEMO_USERS_ID'));
      for (const p of PERSONAS) {
        const upn = users[p.key].upn;
        const entry = credentials.get(upn) ?? {};
        entry.tap = await issueTap(users[p.key].id, maxLifetime);
        credentials.set(upn, entry);
      }
      log.ok(`Temporary Access Passes issued (reusable, ${env('DEMO_TAP_LIFETIME_MINUTES', '480')} minutes)`);
    } catch (e) {
      log.warn(`Temporary Access Pass not issued: ${e.message.split('\n')[0]}`);
    }
  }

  if (credentials.size) {
    const file = path.resolve('.azure', env('AZURE_ENV_NAME', 'local'), 'demo-credentials.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = [`# ${new Date().toISOString()} - local only, never commit`];
    for (const [upn, cr] of credentials) {
      lines.push([upn, cr.password && `password=${cr.password}`, cr.tap && `TAP=${cr.tap}`].filter(Boolean).join('\t'));
    }
    fs.appendFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    log.ok(`Persona sign-in details written to ${path.relative(process.cwd(), file)} (gitignored)`);
  }
  return users;
}
