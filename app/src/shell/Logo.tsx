// The Lineage Studio mark. Abstract, not a wordmark — it renders at 20-24px in
// the rail, the Model Browser header, and the Model Viewer's top bar, and text
// does not survive that size.
//
// Lifted out of ModeMenu when the Model Viewer and the Model Browser both grew
// their own logo: three copies of the same path is how they drift apart.
export function LogoMark() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 17V9l8-5 8 5v8l-8 5-8-5Z" />
      <path d="M4 9l8 5 8-5M12 14v8" />
    </svg>
  )
}
