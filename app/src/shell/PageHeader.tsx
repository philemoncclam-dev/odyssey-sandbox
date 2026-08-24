// The top bar over the Fabric Toolkit.
//
// Used to double as a mode switch between Modeling and the Fabric Toolkit —
// the mark was a button linking to the other mode's landing screen. There is
// only one mode left, so it's back to a plain mark.
import type { ReactNode } from 'react'
import { LogoMark } from './Logo'
import './pageHeader.css'

export function PageHeader({
  title,
  children,
}: {
  title: string
  /** Page actions, right-aligned. */
  children?: ReactNode
}) {
  return (
    <header className="ph-top">
      <span className="ph-brand" aria-hidden="true">
        <LogoMark />
      </span>
      <h1 className="ph-title">{title}</h1>
      <div className="ph-spacer" />
      {children}
    </header>
  )
}
