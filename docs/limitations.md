# Limitations and caveats

## Preview status

* The SharePoint in Microsoft 365 indexer, SharePoint ACL ingestion, SharePoint site group resolution and query-time ACL
  enforcement are **preview** (REST `2026-08-01-preview`). No SLA; behaviour and API shapes can change.
* The Azure portal can't configure ACL ingestion; everything is done through REST (see `scripts/search/`).

## Security model gaps (by design of the preview)

| Not supported | Effect in this demo |
|---|---|
| "Anyone" and "People in your organization" sharing links | Documents shared only through such links are not visible to anyone through search. Only "Specific people" links are honoured. |
| External / guest users | Never matched. |
| Entra groups **nested inside SharePoint groups** | Not expanded: users who only reach a document that way get no results. This demo puts Bob **directly** in the Finance *Members* group and assigns Entra groups **directly** to sites/folders. |
| SharePoint Information Management policies | Not evaluated. |
| Purview sensitivity labels | Separate feature (not enabled here). |
| More than 1,000 permission entries on one item | Entries beyond the limit might not be enforced. |
| Custom Web API skill, knowledge store, enrichment cache, debug sessions | Drop ACLs; not used. |

## Freshness

* ACLs are as fresh as the last indexer run. Item-level changes on items with unique permissions are incremental;
  **parent-scope changes need a resync** (`/resync` with `permissions`). Until then the index serves stale ACLs.
* Revoking the ingestion app's site grant stops future runs but does **not** remove chunks that were already indexed.
  Reset the indexer, or delete the documents, to purge them.
* Entra and SharePoint group membership is resolved at query time and is effectively immediate (subject to caching in the
  service).

## Identity and tenant

* **Conditional Access**: the documentation lists tenants with Conditional Access as unsupported. The app-only federated
  flow is not subject to user-targeted policies, but workload-identity policies could block it. Check the
  *Sites.Selected proof* tab.
* **Private endpoints** aren't supported for the SharePoint indexer; use the search service firewall instead.
* If ACL evaluation fails (Graph or SharePoint unavailable) queries return **5xx**, never partial results — design your
  UI for it.
* The first ACL-filtered queries can be slower while permissions are resolved and cached.
* <a id="site-user-list"></a>**Users must exist in every indexed site's user list.** To resolve SharePoint site groups
  (`spg:` entries) at query time, Azure AI Search looks the signed-in user up in each indexed site
  (`/_api/web/siteusers/getbyemail`). If the user isn't in one site's *User Information List*, the **whole query fails**
  ("User cannot be found", 404), even for documents on other sites. That is common when access comes only through an
  Entra group and the user has never opened the site. The setup script registers the personas with `ensureuser`
  (no permission granted). In production, plan for it: register users (or the Entra groups' members) on each
  indexed site, or ask users to open the sites once. The web app explains this error when it happens.

## Scope: site collection, site, library or folder

* **`Sites.Selected` is granted per site collection** (`/sites/{id}/permissions`). A grant covers that site collection,
  including its subsites. The granular `Lists.SelectedOperations.Selected`, `ListItems.SelectedOperations.Selected` and
  `Files.SelectedOperations.Selected` permissions exist in Graph, but the indexer documentation doesn't list them and
  they weren't tested here.
* **What gets indexed** can be narrower or wider than one site, independent of the grant. The data source points at a
  site URL and `container.name` selects `defaultSiteLibrary`, `allSiteLibraries` (add `includeSubsites=true` for subsites),
  or `useQuery` with `includeLibrariesInSite=<site or subsite URL>`, `includeLibrary=` / `excludeLibrary=`,
  `includeFolder=` / `excludeFolder=` (recursive). So you can index one subsite, one library or one folder while the
  grant stays at site-collection level.
* **Permissions are always per item**: whatever the scope, each chunk carries its own document's users/groups.

## <a id="filesreadall"></a>`Files.Read.All`

The documentation's permission table lists Microsoft Graph `Files.Read.All` (application) together with
`Sites.FullControl.All` or `Sites.Selected`. `Files.Read.All` is tenant-wide: granting it gives the app read access to
**every** file in the tenant and makes `Sites.Selected` pointless as a boundary.

This repository runs **without** `Files.Read.All` by default (`GRANT_FILES_READ_ALL=false`) and relies on a per-site
`read` grant. That was enough in our test tenant (see *Validation results* below). If the indexer fails in your
tenant with an authorization error on files, set `GRANT_FILES_READ_ALL=true` and `azd provision` — but be aware that the HR
negative proof then becomes meaningless for Graph-based reads.

## Cost

Azure AI Search Basic (always on), Azure OpenAI tokens for embeddings (re-embedding on reprocessing) and chat, Container
Apps (1 replica), Container Registry Basic, Log Analytics. Run `azd down --purge` when done.

## Validation results

End-to-end run in a Microsoft 365 E5 test tenant with Microsoft-managed Conditional Access policies (MFA for all users),
Azure AI Search Basic in France Central, REST `2026-08-01-preview`. Personas signed in with Temporary Access Passes in a
real browser; queries ran through the web app with the user's token. Detailed prompts: [test-plan.md](test-plan.md).

| Check | Result |
|---|---|
| Admin consent alone (HR site, no `Sites.Selected` grant) | Graph probe **403**. Azure AI Search **refuses to create the indexer** (`accessDenied`): access is validated at creation time |
| `read` site grant, no `Files.Read.All` | Enough for content, ACL metadata and incremental item-level permission changes |
| App-only federated credential (no secret) under Conditional Access | Worked; no policy blocked the indexer or the probe |
| Alice — Entra group on a folder with unique permissions | ✅ BLUEBIRD + AURORA; hybrid "superconducting qubits" → both Quantum papers |
| Bob — direct member of the SharePoint *Members* site group | ✅ BLUEBIRD + NIGHTJAR; hybrid "superconducting qubits" → only Public papers |
| Carol — direct user on a folder with unique permissions | ✅ BLUEBIRD + KESTREL; hybrid → Bio and Public papers only |
| OSPREY (HR, ungranted site) | Never returned to anybody |
| RAG chat | Each persona's answer lists only its own codewords and cites only accessible documents |
| No user token | 0 results (index queried without `x-ms-query-source-authorization`) |
| Request without sign-in | 401 from the app |
| Elevated read | Requires a **user** token with the elevated-read permission as `Authorization` (app-only tokens are rejected: *"requires an AAD user access token"*) and can't be combined with `x-ms-query-source-authorization`. The app sends the signed-in admin's token |
| Users not in an indexed site's user list | Whole query fails with 404 "User cannot be found" (see [above](#site-user-list)) — fixed by `ensureuser` |
| Index schema | A field named `metadata_spo_item_path` is required; the `sharepointSiteUrl` field must be **filterable**, otherwise every write fails ("Unable to complete aggregations search request") |
| Temporary Access Pass | Issuance returns 400 for a few minutes after the method is enabled (the script retries) |
