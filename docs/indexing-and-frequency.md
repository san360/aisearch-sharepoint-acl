# Indexing and refresh frequency

## Schedule

Each site has its own indexer (`ixr-research`, `ixr-finance`, `ixr-hr`) with the same schedule:

```powershell
azd env set INDEXER_SCHEDULE PT15M     # ISO 8601 duration; minimum PT5M, maximum P1D
node scripts/setup/index.mjs --only search --no-run
```

| Interval | When to use |
|---|---|
| `PT5M` (minimum) | Demos, near-real-time requirements. Each run lists changes via SharePoint change tokens, so idle runs are cheap. |
| `PT15M` – `PT1H` (default `PT15M`) | Typical team sites. |
| `PT2H` – `P1D` | Large archives, cost-sensitive pipelines (every changed file is re-chunked and re-embedded). |

You can also run on demand: the Admin tab **Run now** button, or
`POST /indexers('ixr-research')/search.run?api-version=2026-08-01-preview`.

## What a run picks up

| Change in SharePoint | Picked up automatically on the next run? | Action |
|---|---|---|
| New or modified file | ✅ | – |
| Deleted file | ✅ (search document removed) | – |
| Permission change on a file/folder **with unique permissions** | ✅ (since 2026-05-01-preview) | – |
| Permission change on a **parent scope** (site, library, folder) inherited by children | ❌ | `POST /indexers('…')/search.resync` `{"options":["permissions"]}`, then run (Admin tab → **Resync ACLs**) |
| Renamed folder | ⚠️ treated as new content (incremental tracking breaks for that folder) | – |
| Entra group membership change (user added to / removed from a group) | not needed | Resolved at **query time** through Microsoft Graph — effective immediately |
| SharePoint site group membership change (for example, Members) | not needed | Resolved at query time via `sharePointConnectorAppRegistration` |

> If you change SharePoint permissions without a run (or a resync for parent scopes), the index serves **stale ACLs** for
> already-indexed files. Plan the schedule around how quickly permission revocations must take effect.

## Chunking and enrichment

* Text extraction: built-in document cracking (`dataToExtract: contentAndMetadata`).
* Split skill: pages of 2,000 characters with 300 overlap.
* Azure OpenAI embedding skill: `text-embedding-3-large` (3,072 dimensions), managed identity auth.
* Index projections write one search document per chunk and copy `UserIds`, `GroupIds` and `SharePointSiteUrl` onto every
  chunk (`skipIndexingParentDocuments`). Indexer field mappings are bypassed in this mode, so the ACL fields **must** be
  projected.

Features that drop ACLs when combined with SharePoint ACL ingestion (and are therefore not used here): custom Web API skill,
knowledge store, enrichment cache, debug sessions.

## Reprocessing cost

The indexer may re-process unchanged documents (for example after transient SharePoint errors or internal metadata updates).
Each re-processed document is re-embedded. Account for this when choosing the schedule and OpenAI capacity.
