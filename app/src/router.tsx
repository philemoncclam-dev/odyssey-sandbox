import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export const router = createRouter({
  routeTree,
  // No `context`: the root route no longer preloads a graph to hand down, so
  // there is nothing for descendants to read.
  //
  // And no `defaultPendingComponent`. RootPending renders its own <AppShell>,
  // which is right for the ROOT's fallback slot (where nothing else has
  // mounted) and wrong everywhere else: a child route's pending state renders
  // beneath RootComponent's shell, so a global default would nest a second
  // shell inside the first. Routes that load own their own pending UI.
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
