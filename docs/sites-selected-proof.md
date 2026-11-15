# Proving that admin consent for `Sites.Selected` does not grant site access

## The claim

`Sites.Selected` is a "permission to be granted permissions". Admin consent in Microsoft Entra ID lets the app *use*
site-scoped permissions, but gives it access to **no site at all** until a SharePoint/Graph site permission is assigned
for that specific site.

## How this repository proves it

1. **One app, one consent.** The `spo-ingest` app gets Graph `Sites.Selected` and SharePoint `Sites.Selected` /
   `User.Read.All` via `appRoleAssignedTo` resources in [`infra/modules/entra.bicep`](../infra/modules/entra.bicep).
   The consent is tenant-wide and identical for all sites.
2. **Two grants, not three.** The setup script ([`scripts/setup/steps/sharepoint.mjs`](../scripts/setup/steps/sharepoint.mjs))
   calls

   ```http
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   { "roles": ["read"], "grantedToIdentities": [{ "application": { "id": "<spo-ingest client id>", "displayName": "…" } }] }
   ```

   for **Research** and **Finance** only. For **HR Confidential** it actively *removes* any grant, so the invariant holds
   on every re-run.
3. **Three identical indexers.** `ixr-research`, `ixr-finance` and `ixr-hr` use the same app, the same federated
   credential and the same skillset. Only the site URL differs.
4. **Evidence, three ways:**
   * **Indexer creation is refused** — Azure AI Search validates data-source access when an indexer is created. For HR,
     `PUT /indexers('ixr-hr')` fails with `Error with data source: Code: accessDenied`, while `ixr-research` and
     `ixr-finance` are created and run successfully.
   * **Live Graph probe** (web app → *Sites.Selected proof* tab) — the web app's managed identity exchanges its token for an
     app-only `spo-ingest` token (second federated credential) and calls `GET /sites/{host}:/sites/{path}` for each site:
     `200` for Research/Finance, `403` for HR. The decoded `roles` claim (`Sites.Selected`) is shown next to it.
   * **Search** — the HR codeword `OSPREY` returns nothing for every persona, even though all of them can read the HR site
     in SharePoint.

## `read` is enough (validated)

The documentation's permission table pairs ACL ingestion with `Sites.FullControl.All` (or `Sites.Selected`). In our
end-to-end test a **`read`** site grant was sufficient:

| Test (grant = `read`) | Result |
|---|---|
| Re-index Finance from scratch (reset + run) | 3 items, 0 failures; ACLs include the SharePoint site groups (`spg:…:3/4/5`) |
| Add Bob to the Research/Bio folder (unique permissions), run `ixr-research` | 4 items re-processed incrementally; Bob's object ID appears in the Bio ACL |
| Remove Bob again, run | Bob's ID removed from the ACL |

So the default is `read`. To compare with `fullcontrol`:

```powershell
azd env set SITE_GRANT_ROLE fullcontrol
node scripts/setup/index.mjs --only sharepoint --skip-tap
```

## What about `Files.Read.All`?

The ACL permission table in the documentation lists Graph `Files.Read.All` alongside `Sites.Selected`. `Files.Read.All`
(application) is **tenant-wide** and would undo the least-privilege story, so this repository does **not** grant it by
default. See the result of the test in [limitations.md](limitations.md#filesreadall). To add it:

```powershell
azd env set GRANT_FILES_READ_ALL true
azd provision
```

## Try it yourself

* **API lab tab:** run every call above from the web app — as yourself, as the ingestion app, or (admin) grant and
  revoke HR and watch the app's `GET` on HR go 403 → 200 → 403. See [api-lab.md](api-lab.md).
* Grant HR: `POST /sites/{hr-site-id}/permissions` (or set `"granted": true` for `hr` in
  [`scripts/setup/content.json`](../scripts/setup/content.json) and re-run `--only sharepoint`), run `ixr-hr` from the
  Admin tab, and `OSPREY` appears for Alice, Bob and Carol.
* Revoke Finance: delete the permission (`DELETE /sites/{id}/permissions/{perm-id}`); the next `ixr-finance` run fails
  and the probe returns 403. Already-indexed chunks remain until you reset the indexer or delete the documents — revoking
  the *app's* access doesn't remove what it already indexed.
