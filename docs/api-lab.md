# API lab: granting and validating Sites.Selected

The web app's **API lab** tab runs the Microsoft Graph, SharePoint REST and Azure AI Search calls behind this demo:
finding a site, granting the ingestion app, checking what a user and the app can read, and confirming the result in
the index. Every call shows the request (tokens redacted), the raw response and the expected result for each persona.
IDs returned by one call (site, library, folder, grant, SharePoint group) fill the next.

## Three identities

| | Runs | Token | Can do |
|---|---|---|---|
| 👤 **You** | in your browser, straight to `graph.microsoft.com` | your delegated token for the *web* app registration | Only what SharePoint and Entra let **you** do. URL and body are editable (a small Graph Explorer) |
| 🤖 **Ingestion app** | on the server (`POST /api/lab/run`) | app-only token for the *spo-ingest* app, through its federated credential (no secret) | A fixed list of read-only calls. Never a free-form URL: the app can read every granted site whatever your own permissions are |
| 🔎 **Azure AI Search** | through this app (`/api/search`, `/api/admin/search`) | app identity + your token in `x-ms-query-source-authorization` | ACL-trimmed search; elevated read for admins |

Who may run what:

* **Everyone**: all 👤 calls (bounded by their own rights), and the 🤖 calls that reveal no more than the *Sites.Selected
  proof* tab already does (token claims, site lookup, top-level folder names, SharePoint group names).
* **Admins only** (demo admins group, checked on the server): 🤖 folder permissions, SharePoint group members and role
  assignments — they would reveal permissions a user can't see in SharePoint — and elevated read.
* **Granting** (`/sites/{id}/permissions`) needs Graph `Sites.FullControl.All`, which the web app has **only for the
  deploying admin** (`consentType: Principal` in [`entra.bicep`](../infra/modules/entra.bicep)). Anyone else can press
  *Run*: Entra refuses to issue the token (`AADSTS65001`), so the request is never sent. That refusal is the lesson.

Each 👤 call can be copied as HTTP, PowerShell (`Invoke-MgGraphRequest`), `az rest`, or opened in Graph Explorer.

## Operations and measured results

Results from the demo tenant (`read` grants on Research and Finance, none on HR). A = Alice, B = Bob, C = Carol.

### 1 · Who am I (👤)

| Operation | Request | Result |
|---|---|---|
| Who am I | `GET /me` | 200 for everyone — your object ID is what `UserIds` is matched against |
| My groups | `GET /me/transitiveMemberOf/microsoft.graph.group` | 200, group **IDs** (`displayName` is null with only `User.Read`) — matched against `GroupIds` |
| Decode my Graph token | — (in the browser) | `scp` of the web app for you; only the admin's includes `Sites.FullControl.All` |

### 2 · Discover the site (👤, delegated, trimmed by SharePoint)

| Operation | Request | Research | LLM Lab | Finance | HR |
|---|---|---|---|---|---|
| Get the site | `GET /sites/{host}:/sites/{path}` | 200 all | A, B 200 · C **403** | B 200 · A, C **403** | 200 all |
| List document libraries | `GET /sites/{siteId}/drives` | Documents, Archive | Documents | Documents | Documents |
| List folders | `GET /sites/{siteId}/drive/root/children` | A: Public, Quantum · B: Public · C: Public, Bio | A: Papers · B: Papers, Drafts | B: Reports | Confidential |
| Folder permissions | `GET /drives/{driveId}/items/{itemId}/permissions` | readers: `[]` | readers: `[]` | B (Edit): full list | readers: `[]` |
| List subsites | `GET /sites/{siteId}/sites` | A, B: LLM Lab · C: `[]` | `[]` | `[]` | `[]` |

### 3 · Grant Sites.Selected (👤 admin, `Sites.FullControl.All`)

| Operation | Request | Admin | Alice, Bob, Carol |
|---|---|---|---|
| List app grants | `GET /sites/{siteId}/permissions` | Research, Finance: ingestion app `read` · HR: `[]` · LLM Lab: **400 notSupported** (grants exist only on site collections) | no token (AADSTS65001) |
| Get one grant | `GET /sites/{siteId}/permissions/{permId}` | 200 | no token |
| Grant the ingestion app | `POST /sites/{siteId}/permissions` `{"roles":["read"],"grantedToIdentities":[{"application":{"id":"<ingestion app ID>"}}]}` | 201 | no token |
| Change the role | `PATCH /sites/{siteId}/permissions/{permId}` `{"roles":["write"]}` | 200 | no token |
| Revoke | `DELETE /sites/{siteId}/permissions/{permId}` | 204 | no token |

Granting HR and revoking it again was tested: the ingestion app's `GET` on HR went from **403 → 200 → 403**. Re-running
`node scripts/setup/index.mjs --only sharepoint` restores the demo state (it removes any HR grant).

### 4 · Validate as the ingestion app (🤖 app-only)

The result is the same for every user — the app doesn't know who is asking.

| Operation | Request | Research / LLM Lab / Finance | HR (no grant) |
|---|---|---|---|
| Ingestion app token | client credentials + federated assertion | `roles: ["Sites.Selected"]` | same |
| Get the site | `GET /sites/{host}:/sites/{path}` | 200 | **403** |
| List folders | `GET /sites/{siteId}/drive/root/children` | **all** folders (Public, Quantum, Bio …) — not trimmed | 403 |
| Read the site's grants | `GET /sites/{siteId}/permissions` | 403 — a `read` grant can't see or change grants | 403 |
| Folder permissions *(admins)* | `GET /sites/{siteId}/drive/items/{itemId}/permissions` | 200 — what the indexer writes to `UserIds` / `GroupIds` | 403 |
| SharePoint site groups | `GET {site}/_api/web/sitegroups` | Owners = 3, Visitors = 4, Members = 5 | **200** (see below) |
| SharePoint group members *(admins)* | `GET {site}/_api/web/sitegroups/getbyid({id})/users` | Finance group 5: Bob | **200** (see below) |
| Site role assignments *(admins)* | `GET {site}/_api/web/roleassignments` | 403 — a `read` grant can't enumerate them | 403 |

> **SharePoint `User.Read.All` is not site-scoped.** The ingestion app can list SharePoint site groups and their
> members on **every** site, including HR, which has no `Sites.Selected` grant. It can't read any content there. This
> application permission is what the documentation requires for query-time SharePoint group resolution
> (`sharePointConnectorAppRegistration`). If you don't need SharePoint-group ACLs (only Entra users and groups), leave
> out the SharePoint permissions entirely.

### 5 · Validate in Azure AI Search (🔎)

| Operation | Result |
|---|---|
| Search the index as you (`AURORA`) | Alice: 1 hit · Bob, Carol: 0 — change `q` to any codeword |
| Stored ACLs (elevated read) *(admins)* | chunks with `UserIds` / `GroupIds`; needs *Search Index Data Contributor* |

## Implementation

* Catalog and UI: [`app/public/js/lab.js`](../app/public/js/lab.js). Delegated calls use a silent-only MSAL token request
  (`tryToken` in [`auth.js`](../app/public/js/auth.js)) so a missing consent shows up as a result instead of a redirect.
* App-only calls: [`app/src/lab.mjs`](../app/src/lab.mjs) — an allow-list of operations; site keys come from the app's
  configuration, item and group IDs are validated, and admin-only operations are checked on the server.
* No new permissions were added for the lab: it uses the web app's existing delegated scopes and the ingestion app's
  existing federated credential.
