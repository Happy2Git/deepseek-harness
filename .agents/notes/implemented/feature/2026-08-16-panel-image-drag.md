# Agent Note: Panel image drag with model-capability intake

Status: implemented

English | [中文](2026-08-16-panel-image-drag.zh.md)

## Problem

The composer's whole-page drop intake reads OS-dragged files in the browser, which exposes content, not paths. A file row dragged out of the context-files panel is the opposite: the panel knows the absolute host path, and the browser never sees the bytes. For an OCR-capable model (deepseek-v4-pro), the design calls for the model API to receive the image content directly; for any other model, the drop should degrade to a path sentence the agent can act on with its own tools. Nothing may be copied into the workspace — the original path is the reference.

## Decision

**Panel rows carry a path payload; the composer resolves capability and reads lazily.** `FileTree` file rows are `draggable` and set the custom drag type `application/x-dsh-path` (literal duplicated in ui-context-files and ui-conversation; the two packages may not import each other) to the absolute path. The composer's document-level drop handler reads that type before the `Files` branch, then:

- probes the session's current model through a new `sessions.imageInput` RPC (`boolean | null`: `ctx.llm.resolveModelInfo(...).inputModalities` includes `image`; unknown/unresolvable routes answer `null`, and the client treats `null` as not capable);
- for an image-capable session, reads the bytes through the new plugin-owned route `/dir/read-image` and attaches them as an ordinary draft image, then folds `已拖入图片 <path>，图片内容已附在本条消息中。` into the draft;
- otherwise (or on any read/capability failure) folds `已拖入图片 <path>。` alone; a route failure that names a bound (413) toasts the existing per-file limit copy instead.

**`readImage` on the browse seam, fail-closed.** `DirectoryPickerBrowseCapability.readImage(path, signal)` returns exact raw bytes (`DirectoryImageRead { path, data }`) with a backend `maxImageBytes` config (default 8 MiB, above the 5 MiB attachment admission default); past the bound it throws the new closed code `file-too-large`, never a cut read. The route enforces the composed `attachments.imageLimits.maxImageBytes` first (413), sniffs the raster magic bytes to one of PNG/JPEG/WebP/GIF (415 otherwise — the extension never decides), and answers canonical base64. Prompt admission still re-validates the decoded raster, so the route is transport, not the authority.

**Model-visible ⟺ logged.** Both outcomes write the intake sentence through the ordinary draft machine (`keyboard.setDraft`), so the message is a normal `user/message`; the attached image rides the existing draft-image path with its durable attachment record.

## Alternatives considered

**Attach by path server-side.** Rejected: it needs a new prompt-content part type and a second durable-image save path; fetching bytes to the browser and reusing the existing draft-image flow adds only one read route.

**Reuse `/dir/read-text` with base64.** Rejected: the text route is a bounded *cut* read for previews, while image intake must be exact bytes or nothing.

**Admit images regardless of model and let the provider refuse.** Rejected: the user approved a two-mode intake; a non-image model must receive the path sentence, not a mid-turn provider failure.

## Consequences

Panel-originated image drops work on any model: direct multimodal attach for image-capable routes, path reference otherwise, never a workspace copy. The capability probe is a UX fallback probe (fail closed to `null`), not configuration. The route stays loopback-only like the other `/dir/*` routes and carries the panel's transport with it, so the standalone dsh-compass bundle mirrors `read-image` in its own directory-routes.

## Testing

- `packages/host/directory-picker-browse/tests/service.spec.ts`: exact read, `file-too-large` at the bound, unqualified paths, aborts, missing files.
- `packages/host/directory-routes/tests/routes.spec.ts`: base64 + magic-byte sniffing per format, 415 for unknown content, 413 under a composed attachment limit, 400 validation.
- `packages/host/apiproxy/tests/api-proxy-models.spec.ts`: `imageInput` true/false/null, unresolvable routes, unknown sessions.
- `packages/client/ui-context-files/tests/panel.client.spec.tsx`: the file row drag sets the path payload.
- `packages/client/ui-conversation/tests/input-bar.client.spec.tsx`: capable attach + sentence, not-capable sentence only, 413/415 toasts, transport-failure degrade.
- `packages/client/ui-conversation/tests/apply-inject.client.spec.tsx`: the two injected faces against the connection RPC and the route fetch.
