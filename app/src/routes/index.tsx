// `/` has no content of its own — the only mode left is the Fabric Toolkit,
// so `/` lands straight on its Explore level.
import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/fabric/explore', replace: true })
  },
})
