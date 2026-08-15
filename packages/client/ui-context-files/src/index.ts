/**
 * Web context-and-files panel plugin, node half.
 *
 * Deliberately empty. The panel is pure browser presentation: it reads the
 * workspace directory browse capability and the session's already-logged
 * injected context, and submits nothing to the model. No host-side row or
 * service is needed for that surface.
 */

/** Host plugin body — all behavior lives in the browser half. */
export function apply(): void {}
