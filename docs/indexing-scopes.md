# What gets indexed: libraries, folders, subsites (and KQL)

A SharePoint data source in Azure AI Search points at **one site** (the `SharePointOnlineEndpoint` in the connection
string) and a **container** that decides which content of that site is crawled. The `Sites.Selected` grant is a separate
thing: it's set on the **site collection** and is the security boundary. The container only narrows *within* what the
ingestion app is allowed to read.

```
Site collection  /sites/acldemo-research          <- Sites.Selected grant (read) lives here
├── Documents (default library)
│   ├── Public    (inherits site)        BLUEBIRD
│   ├── Quantum   (unique: Quantum team) AURORA
│   └── Bio       (unique: Carol)        KESTREL
├── Archive (second library)
│   └── Notes     (inherits site)        WREN
└── llmlab (subsite, unique: Quantum team + Bob)
    └── Documents
        ├── Papers  (inherits subsite)   HERON
        └── Drafts  (unique: Bob)        MAGPIE
```

This demo's Research data source uses `{"name": "allSiteLibraries", "query": "includeSubsites=true"}` so both the
Archive library and the LLM Lab subsite are indexed by the **same** indexer (`ixr-research`). Finance and HR use
`defaultSiteLibrary`.

## Container options — tested

Every row below was run against the Research site in a test tenant with
[`scripts/setup/validate-scopes.mjs`](../scripts/setup/validate-scopes.mjs) (scratch data source + index + indexer per
scenario, metadata only; REST `2026-08-01-preview`). Paths are *library / folder*.

| # | `container.name` | `container.query` | Result | What was indexed |
|---|---|---|---|---|
| S1 | `defaultSiteLibrary` | `null` | ✅ 9 items | Documents/Public, Quantum, Bio — **not** Archive, **not** the subsite |
| S2 | `allSiteLibraries` | `null` | ✅ 10 items | Documents/\* **+ Archive/Notes** — still no subsite |
| S3 | `allSiteLibraries` | `includeSubsites=true` | ✅ 15 items | Same as S2 **plus every library of every subsite**: llmlab/Documents/Papers (3), Drafts (2). This demo's setting |
| S4 | `useQuery` | `includeLibrary=<site>/Archive` | ✅ 1 item | Archive/Notes only |
| S5 | `useQuery` | `includeLibrariesInSite=<site>;excludeLibrary=<site>/Archive` | ✅ 9 items | All libraries of the site except Archive |
| S6 | `useQuery` | `includeFolder=<site>/Shared Documents/Quantum` | ✅ 3 items | Documents/Quantum only (recursive) |
| S7 | `useQuery` | `includeFolder=…/Public;includeFolder=…/Bio` | ✅ 6 items | Two folders, repeated parameter |
| S8 | `useQuery` | `includeLibrary=<site>/Shared Documents;excludeFolder=…/Quantum` | ✅ 6 items | Documents without Quantum (exclude wins) |
| S9 | `useQuery` | `includeLibrariesInSite=<site>/llmlab` | ✅ 5 items | Only the subsite's libraries (Papers, Drafts). Rejected at creation ("site … not found") if the subsite doesn't exist |
| S10 | `useQuery` | `Path:"…/Quantum"` (KQL) | ❌ rejected | `Unexpected keyword … in query property` — the indexer doesn't accept KQL |

Notes:

* `includeFolder` / `excludeFolder` take the full folder URL (with `Shared Documents` for the default library) and apply
  recursively. Exclude wins over include.
* Library URLs can be the library root or the `…/Forms/AllItems.aspx` URL copied from the browser.
* `allSiteLibraries` crawls every document library of the site, which can include system libraries such as
  *Site Assets*. This demo's indexer only extracts `.pdf,.docx,.pptx,.md,.txt` (`indexedFileNameExtensions`), so images
  and other files are skipped (S2 found nothing besides Documents and Archive).
* Changing the container changes the set of items: **reset the indexer** so it re-crawls (the setup script does this
  automatically when it detects a container change).
* `allSiteLists`, `allSitePages` and `allSiteContent` (lists, modern pages, everything) need a different key field
  (`metadata_spo_site_asset_item_id`) and, for ACLs on list items and pages, Graph `User.Read.All`. Not used here.

## Choosing a scope

| You want to index… | Use |
|---|---|
| One site's main *Documents* library | `defaultSiteLibrary` |
| Every library of one site | `allSiteLibraries` |
| A site **and all its subsites** | `allSiteLibraries` + `includeSubsites=true` |
| Only some subsites | `useQuery` + `includeLibrariesInSite=<subsite 1>;includeLibrariesInSite=<subsite 2>` |
| One library | `useQuery` + `includeLibrary=<library URL>` |
| A few folders | `useQuery` + `includeFolder=<folder URL>` (repeat with `;`) |
| Everything except a library / folder | `useQuery` + `includeLibrariesInSite=…;excludeLibrary=…` / `includeLibrary=…;excludeFolder=…` |
| Several site collections | One data source + indexer **per site collection** (each needs its own `Sites.Selected` grant) |

Whatever the scope, **permissions are ingested per item** and enforced the same way at query time.

## Subsites

* A `Sites.Selected` grant on the site collection covers its subsites — no extra grant.
* SharePoint groups belong to the site collection, so query-time `spg:` resolution works for subsite content too, and the
  user only has to be in the **site collection's** user list once.
* Subsites can have unique permissions (LLM Lab does): they are ingested like any other item permissions.
* **Tenant prerequisite:** new tenants have subsite creation turned off ("New subsites are not available for your
  organization"). It can only be changed in the UI: SharePoint admin center → *Settings* → *classic settings page* →
  *Subsite Creation* → **Enable subsite creation for all sites**. There is no API or PowerShell for it. The setup script
  detects this, prints these steps and continues without the subsite; re-run
  `node scripts/setup/index.mjs --only sharepoint` and `--only search` afterwards.

## KQL

KQL (Keyword Query Language) is **not** supported by the SharePoint *indexer* (S10). It is supported by the **remote
SharePoint knowledge source** of agentic retrieval (Foundry IQ), which doesn't index at all: it queries SharePoint live
through the Microsoft 365 Copilot Retrieval API with the user's identity, and accepts a KQL `filterExpression` on the
knowledge source (for example `SiteID:"…"` or `Path:"…"`) plus a per-request `filterExpressionAddOn`. Each querying user
needs a Microsoft 365 Copilot licence or Retrieval API pay-as-you-go (which still needs at least one Copilot licence in the
tenant). It isn't part of this demo.

| | Indexed SharePoint (this demo) | Remote SharePoint knowledge source |
|---|---|---|
| Where content lives | Copied into your Azure AI Search index (chunks + vectors + ACLs) | Stays in SharePoint, queried live |
| Scope control | Data source `container` (table above) | KQL `filterExpression` |
| Permissions | Ingested per item, enforced at query time with the user's token | SharePoint enforces them live |
| Freshness | Indexer schedule (+ resync for parent-scope ACL changes) | Live |
| Licence | Azure AI Search | + Microsoft 365 Copilot (or Retrieval API pay-as-you-go) per user |

## Re-run the validation

```powershell
node scripts/setup/validate-scopes.mjs          # all scenarios (~10 minutes)
node scripts/setup/validate-scopes.mjs S3 S9    # only some
```

Results are written to `.azure/<env>/scope-validation.json` (local, not committed).
