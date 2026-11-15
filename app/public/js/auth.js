/* global msal */
// MSAL Browser v5 (SPA + PKCE). Tokens live in sessionStorage so each browser
// tab/window can be a different persona.
let pca;
let cfg;
let account = null;

export async function initAuth(config) {
  cfg = config;
  pca = new msal.PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: `${location.origin}/redirect`,
      postLogoutRedirectUri: `${location.origin}/`,
    },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await pca.initialize();
  const res = await pca.handleRedirectPromise();
  account = res?.account ?? pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
  if (account) pca.setActiveAccount(account);
  return account;
}

export async function signIn() {
  // Full-page redirect: robust against popup blockers and COOP. The /redirect
  // bridge page returns the response to this page, handled in initAuth().
  // ?login_hint=<upn> forces that account (bypasses browser SSO to another account).
  const hint = new URLSearchParams(location.search).get('login_hint');
  await pca.loginRedirect({
    scopes: [cfg.searchScope],
    prompt: hint ? 'login' : 'select_account',
    ...(hint ? { loginHint: hint } : {}),
    redirectStartPage: `${location.origin}/`,
  });
}

export async function signOut() {
  const acc = account;
  account = null;
  await pca.logoutRedirect({ account: acc, postLogoutRedirectUri: `${location.origin}/` });
}

export function currentAccount() {
  return account;
}

export async function getToken(scopes = [cfg.searchScope]) {
  if (!account) throw new Error('Not signed in');
  try {
    return (await pca.acquireTokenSilent({ account, scopes })).accessToken;
  } catch {
    await pca.acquireTokenRedirect({ account, scopes, redirectStartPage: location.href });
    throw new Error('Redirecting to sign in…');
  }
}

// Silent only, never redirects: the API lab shows Entra's refusal (e.g. AADSTS65001, no consent for this user)
// as the result instead of sending the user to a consent page.
export async function tryToken(scopes) {
  if (!account) throw new Error('Not signed in');
  try {
    const r = await pca.acquireTokenSilent({ account, scopes, forceRefresh: false });
    return { token: r.accessToken, scopes: r.scopes };
  } catch (e) {
    return { error: { code: e.errorCode ?? e.name, message: e.errorMessage ?? e.message, subError: e.subError } };
  }
}
