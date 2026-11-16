# Index integrity: who can tamper with permissions in the index, and the guardrails

Azure AI Search enforces SharePoint permissions at query time from the **ACL values stored in the index**
(`UserIds`, `GroupIds`, `SharePointSiteUrl`) and from index-level settings (`permissionFilterOption`,
`sharePointConnectorAppRegistration`). SharePoint isn't asked again at query time — except to resolve SharePoint
site-group membership. So anyone who can change those stored values or settings can change who sees what, **without
touching SharePoint**. This page lists the ways in, what was measured in the demo tenant, and the guardrails.

## Measured attacks

All run against the live demo index (REST `2026-08-01-preview`) and reverted afterwards.

| # | Attack | Needs | Result |
|---|---|---|---|
| A1 | Merge one chunk: `{"@search.action":"merge","chunk_id":"…","UserIds":["all"]}` | **Search Index Data Contributor** (`indexes/documents/write`) | Bob — not in the Quantum team — searched `AURORA`: **0 results before, 1 after** (the Quantum access note). `"all"` means *any user* |
| A2 | Set `permissionFilterOption` to `disabled` on the index | **Search Service Contributor** (`indexes/write`) | A query **without** a user token returned **445 of 445** chunks (0 when enabled). Queries **with** `x-ms-query-source-authorization` fail with *HTTP 400 … must set to 'enabled'*, so this app failed closed — any client using just *Search Index Data Reader* sees everything |
| A3 | Next scheduled/incremental indexer run after A1 | — | **0 items processed, tampered ACL stays.** The indexer only re-reads items that changed in SharePoint |
| A4 | `POST /indexers/ixr-research/search.resync {"options":["permissions"]}` + run | Search Service Contributor | 15 items processed, **original ACL restored** |
| A5 | `POST /indexers/ixr-research/search.resetdocs` (affected document key) + run | Search Service Contributor | 1 item processed, **original ACL restored** (chunk keys are regenerated) |
| A6 | `node scripts/setup/verify-acls.mjs` after A1 | Admin roles below | Flagged both `UserIds contains ["all"]` and the drift against SharePoint, exit code 1; `--fix` ran A4 and the next check was clean |
| A7 | `verify-acls.mjs --config` after A2 | — | Flagged `permissionFilterOption is 'disabled'`, exit code 1 |

Tampering is **silent and persistent**: nothing fails, and the scheduled indexer doesn't undo it (A3).

## Who can change what

| Path | Permission (Azure RBAC) | Built-in roles that have it | Effect on access |
|---|---|---|---|
| Push / merge / delete documents | `Microsoft.Search/searchServices/indexes/documents/write` · `…/delete` (DataActions) | Search Index Data Contributor | Rewrite `UserIds` / `GroupIds` (A1), inject documents with any ACL, delete documents |
| Change the index | `…/indexes/write` | Search Service Contributor, Contributor, Owner | `permissionFilterOption: disabled` (A2); remove `permissionFilter` from a field; drop `sharePointConnectorAppRegistration` |
| Change the pipeline | `…/skillsets/write`, `…/indexers/write`, `…/dataSources/write` | Search Service Contributor, Contributor, Owner | Project a constant or another field onto `UserIds` (skillset mapping, indexer `fieldMappings` / `outputFieldMappings`), remove `indexerPermissionOptions`, point a data source elsewhere. Takes effect on the next run |
| Re-enable keys | `Microsoft.Search/searchServices/write` (`disableLocalAuth: false`), then `listAdminKeys/action` | Search Service Contributor, Contributor, Owner | An admin key is full data-plane access (all of the above), with no identity in the request |
| Read everything | `…/indexes/contentSecurity/elevatedOperations/read` (DataAction) | Search Index Data Contributor | Not tampering, but bypasses trimming (`x-ms-enable-elevated-read`) — requires the caller's own user token |
| Change the source | SharePoint permissions, or the ingestion app's site grant | Site owners; `Sites.FullControl.All` | Legitimate path: changes flow into the index on the next run. Covered by SharePoint/M365 governance, not this page |
| Change the identity | Federated credentials / owners of the ingestion app | Application Administrator, app owners | Not index tampering, but a new credential on the ingestion app reads every granted site |

> Note: *Owner*, *Contributor* and *Search Service Contributor* can always re-enable keys. "Keys disabled" is a
> guardrail against leaked keys, not against these roles.

## Guardrails in this repo

| Guardrail | Where | Status |
|---|---|---|
| **No keys**: `disableLocalAuth: true` on Azure AI Search (and Azure OpenAI) | [`core.bicep`](../infra/modules/core.bicep) | ✅ |
| **Indexer-only ingestion**: no application pushes documents; ACLs come only from the SharePoint indexer | pipeline design | ✅ |
| **Least-privilege web app identity**: custom role *Search ACL demo web app* — `indexes/read`, `indexers/read`, `indexers/write` + DataAction `indexes/documents/read`. **No** `documents/write`, no index/skillset/data source write, no `searchServices/write` (keys, auth options). Replaced *Search Index Data Reader + Data Contributor + Service Contributor* | [`core.bicep`](../infra/modules/core.bicep) | ✅ new |
| **Elevated read with the user's own token**, admins group only — the app identity can't bypass trimming | [`search.mjs`](../app/src/search.mjs) | ✅ |
| **Fail-closed queries**: the app always sends the user token; with the permission filter disabled, Search rejects those queries (A2) instead of returning everything | [`search.mjs`](../app/src/search.mjs) | ✅ |
| **Diagnostic logs** (`allLogs`) to Log Analytics: index, indexer, data source and document operations | [`core.bicep`](../infra/modules/core.bicep) `searchDiagnostics` | ✅ new |
| **Integrity check** [`verify-acls.mjs`](../scripts/setup/verify-acls.mjs): configuration drift + ACL comparison with a fresh SharePoint crawl + `"all"`/`"none"` values + injected documents, `--fix` to resync | scripts | ✅ new |
| **Recovery**: `resync` (permissions) or `resetdocs` restores ACLs from SharePoint (A4, A5); Admin tab has *Resync ACLs* | Admin tab | ✅ |

Remaining **demo-only** privileges (remove or restrict in production):

* The web identity still has `indexers/write` so admins can *Run now* / *Resync ACLs*. The same permission can edit an
  indexer's mappings. In production run indexers on their schedule only and drop it (`indexers/read` is enough for
  status).
* The deploying admin keeps *Search Service Contributor* + *Search Index Data Contributor* (setup, elevated read, the
  tampering tests on this page). In production make them **PIM-eligible**, not standing.
* The web identity is a federated-credential subject on the ingestion app (Sites.Selected proof and API lab). In
  production remove `web-proof-mi` so only the search service can act as the ingestion app.

## Recommended controls

### Prevent

1. **No standing write access to documents.** Grant *Search Index Data Contributor* to nobody when an indexer is the
   only writer; the indexer writes as the search service, not as a user. For elevated read use a custom role with
   only `indexes/documents/read` + `indexes/contentSecurity/elevatedOperations/read`.
2. **Narrow app identities with custom roles** (as above). Query-only apps need only `indexes/documents/read`.
3. **Scope roles to one index** when several indexes share a service
   ([Grant access to a single index](https://learn.microsoft.com/azure/search/search-security-rbac#grant-access-to-a-single-index)).
4. **Treat Owner / Contributor / Search Service Contributor as privileged**: PIM with approval and MFA, short activation,
   access reviews. They can re-enable keys and rewrite everything.
5. **Azure Policy** (built-in):
   * *Azure AI Search services should have local authentication methods disabled* — **Deny** (or *Configure … to
     disable local authentication* — Modify) — stops A2-via-keys.
   * *Azure AI Search services should disable public network access* — Deny, with private endpoints for the app and
     admin workstations.
   * *Deploy Diagnostic Settings for Search Services* — DeployIfNotExists, so logging can't be quietly removed.
   * *Azure AI Search services should use customer-managed keys* — Audit (encryption at rest, not tampering).
6. **Network**: private endpoint + `publicNetworkAccess: disabled` makes a stolen token useless from outside the
   network. (This demo keeps public access for simplicity.)
7. **Conditional Access** on the *Azure AI Search* cloud app for human callers (compliant device, MFA).
8. **Resource lock** (`CanNotDelete`) against deletion of the service — doesn't prevent data-plane changes.
9. **Infrastructure as code**: keep the index, skillset, data source and indexer definitions in source control
   ([`scripts/search`](../scripts/search)) and deploy them from a pipeline; humans don't edit them in the portal.

### Detect

1. **Run the integrity check on a schedule** (pipeline, Container Apps job or Automation) and alert on exit code 1:

   ```powershell
   node scripts/setup/verify-acls.mjs --config   # fast: settings only
   node scripts/setup/verify-acls.mjs            # settings + ACLs vs SharePoint (temporary crawl, metadata only)
   ```

2. **Alert on control-plane changes** with the Activity Log: `Microsoft.Search/searchServices/write` (auth options,
   network), `listAdminKeys/action`, `regenerateAdminKey/action`, and role assignment writes on the service.
3. **Alert on data-plane changes** with the diagnostic logs (`AzureDiagnostics`, category `OperationLogs`). The logs
   don't name the caller (see below), so alert on the operation and look at the source IP:

   ```kusto
   // Index, skillset, data source and indexer definition changes — rare outside deployments
   AzureDiagnostics
   | where ResourceProvider == "MICROSOFT.SEARCH" and Category == "OperationLogs"
   | where OperationName in ("Indexes.Create", "Indexes.Update", "Indexes.Delete")
       or OperationName startswith "Skillsets." or OperationName startswith "DataSources."
       or OperationName in ("Indexers.Create", "Indexers.Update", "Indexers.Delete")
   | where OperationName !endswith ".Get" and OperationName !endswith ".List"
   | project TimeGenerated, OperationName, Description_s, CallerIPAddress, resultSignature_d

   // Document writes — the indexer writes too (Azure IPs); manual pushes come from client networks
   AzureDiagnostics
   | where ResourceProvider == "MICROSOFT.SEARCH" and OperationName == "Indexing.Index"
   | summarize writes = count(), docs = sum(Documents_d) by CallerIPAddress, bin(TimeGenerated, 1h)
   ```

   See [Logging what was measured](#logging-what-was-measured) for the fields available.
4. **Watch the indexer**: a sudden drop or jump in `itemsProcessed`, failures, or a changed schedule.

### Recover

| Situation | Action |
|---|---|
| ACLs on some documents altered | `POST /indexers/{name}/search.resetdocs` with the document keys, then run (A5) |
| Unknown extent | `POST /indexers/{name}/search.resync {"options":["permissions"]}`, then run (A4) — re-reads permissions for every item |
| Injected documents (not in SharePoint) | Delete them by key, or reset the indexer and delete the index's documents for a full rebuild |
| Index / pipeline settings changed | Re-apply the definitions from source control (`node scripts/setup/index.mjs --only search`) |
| Keys re-enabled | Set `disableLocalAuth: true` again (`azd provision`), regenerate both admin keys, delete query keys |

Then run `verify-acls.mjs` until it's clean. `verify-acls.mjs --fix` does the resync automatically for the affected
indexers.

## Logging what was measured

With the `allLogs` diagnostic setting, these operations from the tests above appeared in `AzureDiagnostics`
(`Category = OperationLogs`) about 10–15 minutes later; it can take longer right after enabling the setting:

| Test | `OperationName` | Logged fields of interest |
|---|---|---|
| Document merge (A1 / restore) | `Indexing.Index` | `Description_s = POST /indexes('…')/docs/search.index`, `Documents_d = 1`, `CallerIPAddress` = the client's IP |
| Indexer writing chunks | `Indexing.Index` | same operation, `Documents_d` = batch size, `CallerIPAddress` = an Azure datacenter IP |
| `permissionFilterOption` change (A2) | `Indexes.Update` | `Description_s = PUT /indexes('…')`, `resultSignature_d = 204` |
| Run / resync from the Admin tab | `Indexers.RunOnDemand`, `Indexers.Resync` | |
| Queries | `Query.Search` | `Query_s`, `Documents_d` |

What this means:

* **No caller identity.** Records carry the operation, index, document count, HTTP status, time and **IP address** —
  not the Entra principal. To attribute a change, correlate the time and IP with Entra sign-in logs of the principals
  that hold write roles (which is why that list should be short and PIM-activated).
* **Indexer writes are logged too.** `Indexing.Index` alone isn't an anomaly; manual writes stand out by the source IP
  (a client network instead of Azure) and by not coinciding with an indexer run. This makes the logs good for
  investigation and alerting on `Indexes.Update`, `Skillsets.*`, `DataSources.*` and `Indexers.Create/Update`, while
  `verify-acls.mjs` is the reliable detector for changed ACL values.

## How `verify-acls.mjs` works

1. **Configuration** (`--config`): `permissionFilterOption = enabled`; `UserIds` / `GroupIds` carry `permissionFilter`;
   `sharePointConnectorAppRegistration` points to the ingestion app; the skillset projects `UserIds` / `GroupIds` from
   `/document/metadata_user_ids` / `metadata_group_ids` and contains only the expected skills; every data source keeps
   `indexerPermissionOptions`; no indexer field mapping targets an ACL field.
2. **Stored ACLs**: reads every chunk with elevated read; flags `"all"` / `"none"`.
3. **Current SharePoint ACLs**: creates a temporary metadata-only data source + indexer per site (same container as the
   live data source) into a temporary index, then deletes them. Only permissions and paths are read — no content, no
   embeddings.
4. **Compare** per item path: ACL differences (tampering, or a SharePoint change not yet resynced) and chunks whose item
   no longer exists in SharePoint (injected or stale).

Writes `.azure/<env>/acl-verification.json` and exits 1 on any finding. A legitimate SharePoint change made since the
last run also shows up as drift — which is useful: it means the index is stale for that item.

## Sources

* [Connect to Azure AI Search using roles](https://learn.microsoft.com/azure/search/search-security-rbac) — built-in
  roles; Owner, Contributor and Search Service Contributor can retrieve admin keys
* [Azure permissions for Microsoft.Search](https://learn.microsoft.com/azure/role-based-access-control/permissions/ai-machine-learning#microsoftsearch)
  — actions vs data actions used in the custom role
* [Indexing ACLs with the push REST APIs](https://learn.microsoft.com/azure/search/search-index-access-control-lists-and-rbac-push-api)
  — special values `"all"` and `"none"`
* [Query-time ACL and RBAC enforcement](https://learn.microsoft.com/azure/search/search-query-access-control-rbac-enforcement)
  — elevated read permission
* [Use a SharePoint indexer to ingest permission metadata](https://learn.microsoft.com/azure/search/search-indexer-sharepoint-access-control-lists)
  — `resync` and `resetdocs`
* [Secure an Azure AI Search service](https://learn.microsoft.com/azure/search/search-security-best-practices) and
  [Azure Policy built-ins for Azure AI Search](https://learn.microsoft.com/azure/search/policy-reference)
* [Configure diagnostic logging](https://learn.microsoft.com/azure/search/search-monitor-enable-logging) and the
  [monitoring data reference](https://learn.microsoft.com/azure/search/monitor-azure-cognitive-search-data-reference)
