/** Package-owned invariant companion for the local git backend. @module @deepseek-ai/dsh-host-git-local/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-git-local'

/** Cordis companion plugin name. */
export const name = 'host-git-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: each call is a stateless git round trip; the repository itself is the authoritative state. */
const install: InvariantInstaller = () => {}

/**
 * Register the local git invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
