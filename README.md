# Odyssey Sandbox

A local-only tool: run a notebook through the Spark lineage sandbox, look at
what it reads/writes/column-maps, then push the result into a Solidatus model
— no build step, no cloud backend, one Python process.

Ported out of [Odyssey](https://github.com/philemoncclam-dev/Odyssey), keeping
only the sandbox engine and the Fabric Explore page. Everything else —
model builder/viewer, branching and merge, the catalog, MSAL, the Cosmos DB
server — is gone, not stubbed.

## What changed from Odyssey

- **Auth**: no MSAL app registration. Fabric access goes through the Azure
  CLI (`az login --tenant <id> --allow-no-subscriptions`), which this process
  shells out to. Set your tenant once in `config.py`.
- **Frontend**: one static HTML file (`web/index.html`), vanilla JS, no
  npm/Vite/React. Open it via the Python server below.
- **Solidatus**: a new step. After a sandbox run, fill in a Solidatus base
  URL + API token (scopes: *Create model*, *View model*) in the UI and either
  create a new model or replace an existing one's content — both go through
  Solidatus's documented `POST /api/v1/models` and
  `POST /api/v1/models/{id}/update` (`ReplaceModel`) endpoints.

## Setup

Requires Python 3.12+ and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
(only needed for the Explore tab — the Sandbox tab works without it if you
paste in cell source directly).

```bash
pip install -r requirements.txt
```

Edit `config.py`:

```python
AZURE_TENANT_ID = "your-tenant-guid-or-domain"
```

## Run

```bash
python server.py        # opens http://127.0.0.1:8765
```

- **Explore**: sign in (`az login`), browse workspaces → notebooks and
  pipelines. Click a pipeline to see its full activity graph — nested
  `ExecutePipeline`/`InvokePipeline` children are fetched and spliced in
  recursively (`pipelines.py`, ported from lineage-studio-v2's
  `backend/app/fabric/pipelines.py`), all the way to the lowest level, with
  dependency edges preserved.
- **Run whole pipeline in Sandbox**: runs every notebook activity through the
  sandbox in dependency order (Kahn's algorithm), carrying each step's output
  schemas into the next — so a silver notebook reading a table its bronze
  predecessor just wrote still resolves columns. A Copy activity isn't
  executed; its source/sink and column mapping are read straight out of the
  pipeline definition (declarative, no JVM needed). Results from every
  activity — notebook runs and Copy lineage alike — are merged into one
  combined result, ready to push to Solidatus.
- **Sandbox** (single notebook): paste/edit cells (separate multiple cells
  with a `# --- cell ---` line), run. Uses the stub (sqlglot) engine unless a
  pinned PySpark venv is present — see `sandbox/runner.py`.
- **Port to Solidatus**: after a run, enter your Solidatus base URL and API
  token, choose create-new or update-existing, push.

## Security notes (same as upstream)

- This is a loopback dev server with no authentication. Don't expose it
  beyond `127.0.0.1`.
- The sandbox executes whatever cell text it's given, isolated by process
  (scrubbed env, throwaway home/workdir) but **not** by OS sandbox — see
  `sandbox/runner.py`'s docstring for exactly what that does and doesn't
  cover. Don't run this on a host that holds secrets in its environment.
- The Solidatus API token is entered in the browser each session and is
  never written to disk by this app.

## Tests

```bash
python -m pytest tests/ -q          # Solidatus mapping check
```

The engine's own test suite (Odyssey's `tests/`) wasn't ported — only
`sandbox/` itself was copied. Pull it from upstream if you want it.
