/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-context-files`.
 * @module @deepseek-ai/dsh-client-ui-context-files/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-context-files'

/** Cordis companion plugin name. */
export const name = 'client-ui-context-files-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the panel registers through the slot registry (whose
 * own effect accounting owns that relationship) and reads existing runtime
 * session and workspace facts; it owns no independent event stream or mutable
 * domain to check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
