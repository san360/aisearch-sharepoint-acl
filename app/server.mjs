import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, publicConfig, missingConfig } from './src/config.mjs';
import { requireUser, requireAdmin } from './src/auth.mjs';
import { searchAsUser, searchApi, indexerStatus, indexerDefinition, indexStats } from './src/search.mjs';
import { chat } from './src/chat.mjs';
import { proof } from './src/proof.mjs';
import { liveMatrix, peopleAccessContext } from './src/matrix.mjs';
import { userGroups, isAdmin, resolvePrincipals } from './src/graph.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, 'public');
const msalLib = path.join(here, 'node_modules', '@azure', 'msal-browser', 'lib');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// MSAL Browser v5 redirect bridge page.
app.get('/redirect', (_req, res) => res.sendFile(path.join(pub, 'redirect.html')));
app.get('/vendor/msal-redirect-bridge.min.js', (_req, res) => res.sendFile(path.join(msalLib, 'redirect-bridge', 'msal-redirect-bridge.min.js')));

// No Cross-Origin-Opener-Policy header: the app uses the full-page redirect flow,
// and a COOP boundary between /redirect and / would force a browsing-context swap.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.get('/vendor/msal-browser.min.js', (_req, res) => res.sendFile(path.join(msalLib, 'msal-browser.min.js')));
app.use(express.static(pub, { extensions: ['html'] }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message, ...(e.raw ? { raw: e.raw } : {}) });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, missing: missingConfig() }));
app.get('/api/config', (_req, res) => res.json(publicConfig()));

app.get('/api/me', requireUser, wrap(async (req, res) => {
  const [groups, admin] = await Promise.all([
    userGroups(req.user.oid).catch(() => []),
    isAdmin(req.user.oid).catch(() => false),
  ]);
  res.json({ ...req.user, token: undefined, groups, isAdmin: admin });
}));

app.post('/api/search', requireUser, wrap(async (req, res) => {
  const { q, mode = 'hybrid', top = 10 } = req.body ?? {};
  res.json(await searchAsUser(req.user.token, { q, mode, top: Math.min(Number(top) || 10, 50), raw: true }));
}));

app.post('/api/chat', requireUser, wrap(async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'messages required' });
  res.json(await chat(req.user.token, messages));
}));

app.get('/api/proof', requireUser, wrap(async (_req, res) => res.json(await proof())));

// Live "who can see what": stored ACLs + live group resolution, plus a real trimmed query for the caller.
app.get('/api/matrix', requireUser, wrap(async (req, res) =>
  res.json(await liveMatrix(req.user, { admin: await isAdmin(req.user.oid).catch(() => false) }))));

// ---------- Admin ----------
const admin = express.Router();
admin.use(requireUser, requireAdmin);

admin.post('/search', wrap(async (req, res) => {
  const { q, mode = 'keyword', top = 25 } = req.body ?? {};
  const data = await searchAsUser(req.user.token, { q, mode, top: Math.min(Number(top) || 25, 100), elevated: true, withAcl: true });
  const ids = data.results.flatMap((r) => [...r.userIds, ...r.groupIds]);
  res.json({ ...data, principals: await resolvePrincipals(ids) });
}));

admin.get('/people', wrap(async (_req, res) => res.json({ people: await peopleAccessContext() })));

admin.get('/indexers', wrap(async (_req, res) => {
  const items = await Promise.all(config.sites.map(async (s) => ({
    ...s,
    ...(await indexerStatus(s.key)),
    schedule: await indexerDefinition(s.key).then((d) => d.schedule).catch(() => null),
  })));
  const stats = await indexStats().catch(() => null);
  res.json({ indexers: items, stats });
}));

admin.post('/indexers/:key/:action', wrap(async (req, res) => {
  const { key, action } = req.params;
  if (!config.sites.some((s) => s.key === key)) return res.status(404).json({ error: 'unknown indexer' });
  if (action === 'run') await searchApi(`indexers('ixr-${key}')/search.run`, { method: 'POST' });
  else if (action === 'resync') await searchApi(`indexers('ixr-${key}')/search.resync`, { method: 'POST', body: { options: ['permissions'] } });
  else return res.status(400).json({ error: 'action must be run or resync' });
  res.json({ ok: true, key, action });
}));

app.use('/api/admin', admin);
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(pub, 'index.html')));

app.listen(config.port, () => {
  const missing = missingConfig();
  console.log(`ACL search demo listening on :${config.port}${missing.length ? ` (missing config: ${missing.join(', ')})` : ''}`);
});
