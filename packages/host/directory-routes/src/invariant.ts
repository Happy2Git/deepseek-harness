/** Package-owned invariant companion for the directory-routes backend. @module @deepseek-ai/dsh-host-directory-routes/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-directory-routes'

/** Cordis companion plugin name. */
export const name = 'host-directory-routes-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: each route is a stateless round trip; the filesystem itself is the authoritative state. */
const install: InvariantInstaller = () => {}

/**
 * Register the directory-routes invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
