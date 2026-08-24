// /fabric itself has no content — Explore is the toolkit's landing screen, the
// same way / lands on the Model Browser. The redirect lives here rather than in
// the mode toggle so that a typed URL, a bookmark and the toggle all agree.
import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/fabric/')({
  beforeLoad: () => {
    throw redirect({ to: '/fabric/explore', replace: true })
  },
})
