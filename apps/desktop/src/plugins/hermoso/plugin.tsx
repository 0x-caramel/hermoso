/**
 * Hermoso, in the window: a status-bar chip for Teleport, a page, a sidebar row and a command. A bundled
 * desktop plugin (the same door the app's own optional features use), so nothing upstream is edited for it.
 * The protection itself runs in the app's main process and in the agent's plugin; this is how it is seen.
 */

import {
  type HermesPlugin,
  host,
  PALETTE_AREA,
  type PaletteContribution,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution,
  STATUSBAR_AREAS
} from '@hermes/plugin-sdk'

import { GhostChip } from './ghost-chip'
import { HermosoPage } from './page'
import { ShieldChip } from './shield-chip'
import { startHermoso } from './store'
import { STRINGS } from './strings'
import { TeleportChip } from './teleport-chip'

const PATH = '/hermoso'

const plugin: HermesPlugin = {
  description:
    'The shield, the guardian, the Time Machine, Teleport and the protections that ride along with the agent.',
  id: 'hermoso',
  name: 'Hermoso',
  register(ctx) {
    ctx.onDispose(startHermoso())

    ctx.registerMany([
      {
        area: ROUTES_AREA,
        data: { path: PATH } satisfies RouteContribution,
        id: 'page',
        render: () => <HermosoPage />,
        title: STRINGS.nav
      },
      {
        area: STATUSBAR_AREAS.right,
        id: 'ghost',
        order: 83,
        render: () => <GhostChip />
      },
      {
        area: STATUSBAR_AREAS.right,
        id: 'shield',
        order: 84,
        render: () => <ShieldChip />
      },
      {
        area: STATUSBAR_AREAS.right,
        id: 'teleport',
        order: 85,
        render: () => <TeleportChip />
      },
      {
        area: SIDEBAR_NAV_AREA,
        data: { codicon: 'shield', label: STRINGS.nav, path: PATH } satisfies SidebarNavContribution,
        id: 'nav',
        order: 40
      },
      {
        area: PALETTE_AREA,
        data: {
          id: 'hermoso.open',
          keywords: [
            'hermoso',
            'protect',
            'shield',
            'guardian',
            'time machine',
            'rewind',
            'snapshot',
            'teleport',
            'vpn'
          ],
          label: STRINGS.palette.open,
          run: () => host.navigate(PATH)
        } satisfies PaletteContribution,
        id: 'open'
      },
      {
        area: PALETTE_AREA,
        data: {
          id: 'hermoso.teleport',
          keywords: ['teleport', 'country', 'vpn', 'mullvad', 'exit'],
          label: STRINGS.palette.teleport,
          run: () => host.navigate(PATH)
        } satisfies PaletteContribution,
        id: 'teleport'
      }
    ])
  }
}

export default plugin
