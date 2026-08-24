// Fabric Toolkit layout — the shared top bar and the outlet.
//
// Sections are the shell's left rail (Explore, Integrations), the way they
// were before the port: they are destinations, which is what a rail is for.
// This layout deliberately carries NO tab strip of its own — two sets of the
// same links, one in the rail and one under the title, is the "second door to
// the same room" the rail config already warns about.
//
// The bar itself is shared with the Model Browser, so the mark sits in the
// same place on both landing screens and toggles between them.
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { PageHeader } from '../../shell/PageHeader'
import './fabricShell.css'

export const Route = createFileRoute('/fabric')({
  component: FabricLayout,
})

function FabricLayout() {
  return (
    <div className="fxs">
      <PageHeader title="Fabric Toolkit" />
      <div className="fxs-body">
        <Outlet />
      </div>
    </div>
  )
}
