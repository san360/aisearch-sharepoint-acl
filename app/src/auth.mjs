import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.mjs';
import { isAdmin } from './graph.mjs';

const SEARCH_AUDIENCES = ['https://search.azure.com', '880da380-985e-4198-81b9-e05b1cc53158'];
let jwks;

// Validates the user's Azure AI Search access token. The same token is then
// forwarded unchanged in x-ms-query-source-authorization, so Azure AI Search
// itself decides which documents the user may see.
export async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in first.' });
    const token = header.slice(7);
    jwks ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`));
    const { payload } = await jwtVerify(token, jwks, {
      audience: SEARCH_AUDIENCES,
      issuer: [`https://sts.windows.net/${config.tenantId}/`, `https://login.microsoftonline.com/${config.tenantId}/v2.0`],
    });
    if (payload.appid && payload.appid !== config.webClientId && payload.azp !== config.webClientId) {
      return res.status(401).json({ error: 'Token was not issued to this application.' });
    }
    req.user = {
      oid: payload.oid,
      name: payload.name,
      upn: payload.upn ?? payload.preferred_username ?? payload.unique_name,
      token,
    };
    next();
  } catch (e) {
    res.status(401).json({ error: `Invalid token: ${e.message}` });
  }
}

export async function requireAdmin(req, res, next) {
  try {
    if (!(await isAdmin(req.user.oid))) return res.status(403).json({ error: 'Admin tab is limited to the demo admins group.' });
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
