// Rail-bottom cluster: the Cmd+K search trigger, and Fabric sign-in status.
//
// No MSAL here — Fabric access goes through the local Python bridge's own
// `az login`, so this only reflects and triggers that (GET/POST
// /fabric/status, /fabric/login on the bridge), rather than holding an
// account/token of its own.
import { type ReactNode, useEffect, useState } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { fetchFabricStatus } from '../fabric/api'

const BRIDGE_URL = (import.meta.env['VITE_SANDBOX_URL'] as string | undefined) || 'http://127.0.0.1:8765'

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
  )
}

function AccountIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" strokeLinecap="round" />
    </svg>
  )
}

function RailBottomButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button type="button" className="rail-bottom-btn" onClick={onClick}>
          {children}
          <VisuallyHidden>{label}</VisuallyHidden>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="rail-tooltip" side="right" sideOffset={8}>
          {label}
          <Tooltip.Arrow className="rail-tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export default function RailBottomCluster({ onOpenSearch }: { onOpenSearch: () => void }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [signingIn, setSigningIn] = useState(false)

  const refresh = () => {
    fetchFabricStatus()
      .then((s) => setSignedIn(s.configured))
      .catch(() => setSignedIn(false))
  }
  useEffect(refresh, [])

  const signIn = async () => {
    setSigningIn(true)
    try {
      await fetch(`${BRIDGE_URL}/fabric/login`, { method: 'POST' })
    } finally {
      setSigningIn(false)
      refresh()
    }
  }

  const label = signingIn
    ? 'Signing in…'
    : signedIn
      ? 'Signed in to Fabric (az CLI)'
      : signedIn === false
        ? 'Sign in to Fabric (az login)'
        : 'Checking Fabric sign-in…'

  return (
    <div className="rail-bottom">
      <RailBottomButton label="Search (⌘K)" onClick={onOpenSearch}>
        <SearchIcon />
      </RailBottomButton>
      <RailBottomButton label={label} onClick={signedIn ? refresh : signIn}>
        <AccountIcon />
      </RailBottomButton>
    </div>
  )
}
