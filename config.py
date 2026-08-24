"""Values you edit, not values you type into the UI every run.

Edit these two, save, restart `server.py`. Everything the UI needs beyond
this — the Solidatus base URL and API token — is entered in the browser and
never written here, because a token belongs in your head or your OS
credential store, not in a file that might get committed.
"""

# Your Azure AD tenant ID (a GUID, or a verified domain like "contoso.com").
# `az login --tenant <this> --allow-no-subscriptions` runs against this
# tenant when you click "Sign in" in the Explore tab.
AZURE_TENANT_ID = ""

# Optional: pre-fill the Solidatus panel so you don't retype it every run.
# The API token is never stored here — enter it in the browser each session.
SOLIDATUS_BASE_URL = ""
