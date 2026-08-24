"""Whether a credential is reachable from inside a sandbox child.

The observable half of the runner's safety guarantee. It reports on the process
it runs in, so it is the child's own answer rather than the parent's claim
about it — and it must always come back False.

It checks two things, because the earlier version checked one and missed the
larger one:

  * the **environment**, for a `PURVIEW_*`/`AZURE_*` secret. This was always
    covered — the runner scrubs it before spawning.
  * the **home directory**, for a credential cache on disk. This is the hole.
    `DefaultAzureCredential` needs no environment variable whatsoever: it finds
    `~/.azure/msal_token_cache.json` and authenticates from it. So a child with
    the real `USERPROFILE` had a working Azure token while an env-only probe
    reported, perfectly truthfully, that it had seen no credential. The
    assertion was narrower than the risk it existed to assert on.

The runner now points every home variable at a throwaway directory, so this
probe reads an empty tree and the False it returns finally means what it says.
Left in as a live check rather than deleted along with the hole: it is the
thing that notices if that redirection ever regresses.

Pure stdlib — imported by both children, which are launched by path with a
scrubbed environment and must not reach `app`.
"""

from __future__ import annotations

import os
from pathlib import Path

_ENV_PREFIXES = ("PURVIEW_", "AZURE_", "FABRIC_", "AWS_")
_ENV_SUBSTRINGS = ("SECRET", "TOKEN", "PASSWORD")

#: Credential caches, relative to a home directory. Each is a path a client
#: library will authenticate from with no configuration at all.
_HOME_CACHES = (
    ".azure",  # Azure CLI profile + MSAL token cache
    ".IdentityService",  # MSAL extension cache (Linux/macOS)
    ".aws",
    ".config/gcloud",
    "AppData/Local/.IdentityService",
    "AppData/Roaming/Microsoft/Azure",
)


def _homes() -> list[Path]:
    """Every directory this process would resolve as "home".

    More than `Path.home()`: libraries read `USERPROFILE`, `HOME` and the
    Windows `HOMEDRIVE`+`HOMEPATH` pair independently of each other, and a
    redirection that missed one of them would leave a route the probe should
    still see.
    """
    seen: list[Path] = []
    candidates = [os.environ.get("HOME"), os.environ.get("USERPROFILE")]
    drive, tail = os.environ.get("HOMEDRIVE"), os.environ.get("HOMEPATH")
    if drive and tail:
        candidates.append(drive + tail)
    try:
        candidates.append(str(Path.home()))
    except (RuntimeError, OSError):  # No home resolvable — nothing to probe.
        pass
    for value in candidates:
        if not value:
            continue
        try:
            path = Path(value).resolve()
        except (OSError, ValueError):
            continue
        if path not in seen:
            seen.append(path)
    return seen


def reachable_credentials() -> list[str]:
    """Every credential this process can reach, named — env vars and cache paths.

    Names, never values: this list is written into the run log, which is shown
    in the UI and is exactly the wrong place to echo a secret back out.
    """
    found: list[str] = []
    for key in os.environ:
        up = key.upper()
        if up.startswith(_ENV_PREFIXES) or any(s in up for s in _ENV_SUBSTRINGS):
            found.append(f"env:{key}")
    for home in _homes():
        for rel in _HOME_CACHES:
            candidate = home / rel
            try:
                if candidate.exists():
                    found.append(f"path:{candidate}")
            except OSError:  # A permission error IS the isolation working.
                continue
    return found


def saw_credentials() -> bool:
    return bool(reachable_credentials())
