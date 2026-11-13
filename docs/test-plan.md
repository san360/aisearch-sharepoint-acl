# Test plan: prompts, documents and expected outcomes

Use this to run the demo or to accept a deployment. Every row lists the exact prompt, the search mode, and what each
persona must (✅) or must not (⛔) see, with the SharePoint permission that explains it.

## 1. Documents and who can read them

| # | Site / folder | Document (as uploaded to SharePoint) | arXiv | Alice | Bob | Carol | Why |
|---|---|---|---|:-:|:-:|:-:|---|
| D1 | Research / Public | Access note - Public.md *(codeword BLUEBIRD)* | – | ✅ | ✅ | ✅ | Site permission: *All staff* Entra group = Read (folder inherits) |
| D2 | Research / Public | Calibrating Document-Local Boundaries for Contextual Chunk Retrieval | 2611.12097 | ✅ | ✅ | ✅ | same as D1 |
| D3 | Research / Public | Not All Branches Are Equal - Adaptive Semantic ID Construction for Generative Recommendation | 2611.11549 | ✅ | ✅ | ✅ | same as D1 |
| D4 | Research / Quantum | Access note - Quantum.md *(codeword AURORA)* | – | ✅ | ⛔ | ⛔ | Unique permissions: *Quantum team* Entra group only (Alice) |
| D5 | Research / Quantum | Beauty and charm jet identification with end-to-end training on a superconducting quantum processor | 2611.16607 | ✅ | ⛔ | ⛔ | same as D4 |
| D6 | Research / Quantum | Gatemon qubits based on in-situ ternary InAsSb-Al nanowire Josephson junctions | 2611.16595 | ✅ | ⛔ | ⛔ | same as D4 |
| D7 | Research / Bio | Access note - Bio.md *(codeword KESTREL)* | – | ⛔ | ⛔ | ✅ | Unique permissions: Carol as a **direct user** |
| D8 | Research / Bio | Understanding Gene Expression-to-Image Learning - Spatial Structure and Information Fidelity | 2610.17699 | ⛔ | ⛔ | ✅ | same as D7 |
| D9 | Research / Bio | CloneOT - predicting clone-specific perturbation responses … | 2610.16093 | ⛔ | ⛔ | ✅ | same as D7 |
| D10 | Finance / Reports | Access note - Reports.md *(codeword NIGHTJAR)* | – | ⛔ | ✅ | ⛔ | Site permission via the SharePoint **Members** site group (Bob added directly) |
| D11 | Finance / Reports | A Functional Representation of Credit Behavior for Probability of Default Modeling | 2610.07888 | ⛔ | ✅ | ⛔ | same as D10 |
| D12 | Finance / Reports | Comparing two approaches for modelling the loss given default of credit cards | 2610.05926 | ⛔ | ✅ | ⛔ | same as D10 |
| D13 | HR / Confidential | Access note - Confidential.md *(codeword OSPREY)* | – | ⛔ | ⛔ | ⛔ | All staff can read it **in SharePoint**, but the ingestion app has **no Sites.Selected grant** → never indexed |
| D14 | HR / Confidential | Owning What Can Quit | 2611.02302 | ⛔ | ⛔ | ⛔ | same as D13 |

The deploying admin is the site owner of all three sites, so admin@ sees D1–D12 (never D13–D14).

## 2. Search tab

**Keyword** mode is an exact match and the cleanest proof. **Hybrid** mode always returns the nearest chunks the user can
access, so a "no access" result shows up as *other* documents rather than an empty list.

| # | Prompt | Mode | Alice | Bob | Carol |
|---|---|---|---|---|---|
| S1 | `BLUEBIRD` | Keyword | D1 | D1 | D1 |
| S2 | `AURORA` | Keyword | D4 | 🔒 *No results for you* | 🔒 *No results for you* |
| S3 | `KESTREL` | Keyword | 🔒 | 🔒 | D7 |
| S4 | `NIGHTJAR` | Keyword | 🔒 | D10 | 🔒 |
| S5 | `OSPREY` | Keyword | 🔒 | 🔒 | 🔒 |
| S6 | `BLUEBIRD AURORA KESTREL NIGHTJAR OSPREY` | Keyword | D1, D4 | D1, D10 | D1, D7 |
| S7 | `superconducting qubits` | Hybrid | D5, D6 ranked first | **never** D5/D6 — only Public/Finance papers | **never** D5/D6 — only Public/Bio papers |
| S8 | `gene expression images` | Hybrid | never D8/D9 | never D8/D9 | D8 ranked first |
| S9 | `probability of default credit cards` | Hybrid | never D11/D12 | D11/D12 ranked first | never D11/D12 |
| S10 | `*` | Keyword | only documents from D1–D6 (first 20 chunks) | only D1–D3, D10–D12 | only D1–D3, D7–D9 |

## 3. Ask tab (ACL-trimmed RAG)

| # | Prompt | Alice | Bob | Carol |
|---|---|---|---|---|
| A1 | *Which codewords can I see, and which folders do they belong to?* | BLUEBIRD (Public), AURORA (Quantum) | BLUEBIRD (Public), NIGHTJAR (Finance Reports) | BLUEBIRD (Public), KESTREL (Bio) |
| A2 | *What does the superconducting quantum processor paper achieve?* | Answer cites D5 | "Not in my sources / may not have access" | same as Bob |
| A3 | *How do the finance papers model loss given default?* | No access | Answer cites D12 | No access |
| A4 | *Summarise the gene expression to image learning paper.* | No access | No access | Answer cites D8 |
| A5 | *What is the HR codeword?* | No access (OSPREY never appears) | same | same |

Each answer lists its sources with "N chunk(s) retrieved after ACL trimming" and the search it ran. A persona never sees
a citation to a document they can't open in SharePoint.

| # | Check | Expected |
|---|---|---|
| A6 | Ask A2, then *New conversation* | Chat clears; sample questions stay visible; the next question has no earlier context |
| A7 | Ask any question twice | Each answer shows "🔎 searched … as you": every question runs a new trimmed search, nothing is stored server-side |

## 3b. Raw request and response (Search tab)

| # | Prompt / mode | Expected in *Raw request & response* |
|---|---|---|
| R1 | `NIGHTJAR`, Keyword, as Alice | Request has `x-ms-query-source-authorization: <redacted>`, no `queryType`; response `"@odata.count": 0`, `"value": []` |
| R2 | `NIGHTJAR`, Keyword, as Bob | Same request; response contains *Access note - Reports.md* |
| R3 | `superconducting qubits`, Semantic | `"queryType": "semantic"`, `semanticConfiguration`, `captions`; response has `@search.rerankerScore` / `@search.captions` |
| R4 | `superconducting qubits`, Hybrid | Semantic settings plus `vectorQueries: [{ "kind": "text", … }]` |

Tokens are never echoed: `Authorization` and the user token are shown as `<… redacted>`.

## 3c. Live who-can-see-what (How it works tab)

| # | Signed in as | Expected |
|---|---|---|
| L1 | admin@ | One row per persona + you. Alice ✔ Public (👥 All staff) and Quantum (👥 Quantum team); Bob ✔ Public and Reports (🟦 Members); Carol ✔ Public and Bio (👤 direct); admin ✔ D1/D4/D7/D10 via 🟦 Owners. HR column: *not indexed — no Sites.Selected grant*. Persona rows show *matches design* |
| L2 | admin@, after X3 (Carol added to Quantum team) → **Re-run** | Carol ✔ AURORA via 👥 Quantum team and *differs from design*; remove her → back to *matches design* |
| L3 | a persona | Only your row is computed; every cell shows 🔎 found / hidden from a real trimmed query; other rows are labelled *design* |

## 4. Sites.Selected proof tab (any persona)

| Card | Site grant | Graph probe (app-only, as the ingestion app) | Indexer |
|---|---|---|---|
| Research | ✅ granted (`read`) | HTTP 200, lists `Public/ Quantum/ Bio/` | `success` |
| Finance | ✅ granted (`read`) | HTTP 200, lists `Reports/` | `success` |
| HR Confidential | ⛔ not granted | **HTTP 403** | `rejected` — Azure AI Search refused to create the indexer (`accessDenied`) |

Token strip: roles claim = `Sites.Selected`, obtained with a federated credential (no secret).

## 5. Admin tab (admin@ only)

| # | Action | Expected |
|---|---|---|
| X1 | *Who can see what* → `*` | Every chunk with its principals resolved to names: *All staff*, *Quantum team*, Carol (user), the Finance site's *Owners/Members/Visitors* SharePoint groups, … |
| X2 | Personas sign in → Admin tab hidden | Only members of the *Demo admins* group see the tab; `/api/admin/*` returns 403 for others |
| X3 | *Live membership change* → **Add to Quantum team** for Carol, then Carol runs S2 | Carol now sees D4 **immediately** (group resolved at query time, no re-index). Remove her again → 🔒 |
| X4 | In SharePoint add Bob to Research/Bio (folder with unique permissions), then **Run now** on `ixr-research` | After the run Bob sees D7 (`KESTREL`). Item-level ACL changes are incremental. Remove him + run → 🔒 |
| X5 | In SharePoint change a **site-level** permission (for example remove *All staff* from Research), then **Run now** | ⚠️ Not picked up by a normal run (parent scope). Click **Resync ACLs**, then **Run now** → the change applies |
| X6 | **Run now** for HR | Not offered: the indexer doesn't exist (`not granted`) |

## 6. Negative / security checks

| # | Check | Expected |
|---|---|---|
| N1 | Call `/api/search` without a token | 401 |
| N2 | Query the index with the app identity but **no** `x-ms-query-source-authorization` (`demo/queries.http` #1) | 0 results |
| N3 | Send `x-ms-enable-elevated-read` with the app's managed-identity token, or together with `x-ms-query-source-authorization` | Rejected: elevated read needs the caller's own user token and can't be combined with a query-source token |
| N4 | Look at the PDFs' sharing links: an "Anyone"/"People in your organization" link is **not** honoured | Document remains hidden from users who only have the link |
| N5 | Entra group nested inside a SharePoint group | Not expanded: users who reach a document only this way get no result |

## Recorded results

_See "Validation results" in [limitations.md](limitations.md)._
