# Prerequisites

## Tenant (Microsoft 365 + Entra ID)

| Requirement | Why |
|---|---|
| SharePoint in Microsoft 365 | The data source. OneDrive is not supported by the indexer. |
| An admin account with **Global Administrator** (or: Application Administrator + Privileged Role Administrator + SharePoint Administrator + User Administrator + Authentication Policy Administrator) | Bicep creates app registrations and grants admin consent; the setup script creates sites, users and site grants. |
| 3 spare licences that include SharePoint (for example Microsoft 365 E3/E5) | So Alice, Bob and Carol can open documents in SharePoint. Searching works without a licence. |
| Search and Azure resources in the **same tenant** as SharePoint | Simplest setup (cross-tenant is possible but not covered here). |

### Conditional Access

The SharePoint indexer documentation lists *"tenants with Microsoft Entra ID Conditional Access enabled"* as unsupported. This
demo uses **application** permissions with a federated credential; user-targeted Conditional Access policies (MFA, sign-in risk)
don't apply to that app-only flow. Policies that target **workload identities** (service principals) or block token issuance
by location could still break the indexer. Validate in your tenant; the *Sites.Selected proof* tab shows whether the indexer
can read the granted sites.

### MFA for the demo personas

Tenants with an "MFA for all users" policy require the personas to complete MFA. If the tenant also restricts *security
info registration* (for example, to trusted locations), new users cannot register an authenticator. The setup script
therefore issues a reusable **Temporary Access Pass** (TAP, default 8 hours) to each persona:

* If the TAP method is disabled, it is enabled **only for the `<prefix> Demo personas` group**.
* Disable with `azd env set DEMO_ISSUE_TAP false`; change the lifetime with `DEMO_TAP_LIFETIME_MINUTES`.
* Re-issue passes any time: `node scripts/setup/index.mjs --only users`.

Only the Temporary Access Passes (time-limited) are written to `.azure/<env>/demo-credentials.txt` (gitignored) — never
to the repository. Persona passwords are random, never shown and never stored. To use password + MFA instead, reset a
persona's password in the Entra admin center and register an authentication method with the TAP.

### Subsite creation (optional, LLM Lab subsite only)

New tenants have subsite creation disabled ("New subsites are not available for your organization"). The setting has
**no API or PowerShell**: SharePoint admin center → *Settings* → *classic settings page* (bottom) → *Subsite Creation* →
**Enable subsite creation for all sites** → OK. It's tenant-wide (users can then create subsites from the UI). Without it,
setup skips the LLM Lab subsite with a warning and everything else is deployed; enable it later and re-run
`node scripts/setup/index.mjs --only sharepoint` then `--only search`.

## Azure

| Requirement | Notes |
|---|---|
| Subscription **Owner** (or Contributor + User Access Administrator) | Role assignments for managed identities and the deploying user. |
| Region with Azure AI Search capacity | Default **France Central**. Sweden Central, West Europe, North Europe and Germany West Central are flagged as *"high demand, prevents the creation of new search services"* and are blocked by the preprovision hook. |
| Azure OpenAI quota | `gpt-4.1-mini` and `text-embedding-3-large`, GlobalStandard, 30K TPM each (configurable). Use `azd env set AOAI_DEPLOYMENT_SKU Standard` if GlobalStandard isn't available. |
| Azure AI Search **Basic** or higher | The SharePoint indexer is not available on Free. Semantic ranker uses the free plan. |

### SharePoint indexer preview

The SharePoint in Microsoft 365 indexer and ACL ingestion are **preview** features (REST `2026-08-01-preview`).
Microsoft asks you to complete the indexer preview registration form (auto-approved). If data source creation fails with a
"not enabled" error, register the subscription and re-run `node scripts/setup/index.mjs --only search`.

## Local tools

| Tool | Version |
|---|---|
| [Azure Developer CLI (azd)](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) | 1.15+ (Bicep extensions: Microsoft Graph) |
| [Node.js](https://nodejs.org/) | 20+ |
| A browser | For the admin sign-in during setup and for the demo |

Docker is **not** required: the image is built remotely in Azure Container Registry (`remoteBuild: true`).

### Signing in with the right account

azd must run as the tenant admin. If your Azure CLI holds several accounts for the same tenant (for example a guest
account), `azd` with `auth.useAzCliAuth` may pick the wrong one. Use an isolated azd login for this project:

```powershell
$env:AZD_CONFIG_DIR = "$HOME\.azd-acl-demo"   # bash: export AZD_CONFIG_DIR=~/.azd-acl-demo
azd config set auth.useAzCliAuth false
azd auth login --tenant-id <tenant-id>
```

Keep `AZD_CONFIG_DIR` set in that shell for every `azd` command.

### Package registries

`npm install` runs in the postprovision hook (for `scripts/`) and inside the container build (for `app/`), both against the
public npm registry.
