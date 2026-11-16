/**
 * Model selection for Telegram topics. The session's live agent owns its
 * model (`agent.model.current()`); the bot keeps no copy of it. The picker
 * reads the same catalog as the Web model picker
 * (`sessionController.modelCatalog()`), so every configured provider and
 * model shows up with its Web display name.
 */
import { createHash } from 'node:crypto'

/** Rows of providers or models shown per picker page, sized for a phone. */
export const MODEL_PAGE_SIZE = 8

/** How long one catalog read is reused for labels and menus. */
const CATALOG_TTL_MS = 60_000

/**
 * Short stable key for a provider or a provider/model pair, for callback data
 * (Telegram allows 64 bytes, and provider/model ids can be longer).
 * @param provider - provider id.
 * @param model - model id, or undefined for the provider itself.
 * @returns 12 hex characters.
 */
export function catalogKey(provider, model) {
  return createHash('sha256').update(`${provider}\n${model ?? ''}`).digest('hex').slice(0, 12)
}

/**
 * Copy a selection, dropping an absent effort.
 * @param selection - provider, model and optional effort.
 * @returns a detached selection.
 */
function toSelection({ provider, model, reasoningEffort }) {
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

/**
 * Read a session's current model: the live agent's own choice, or, for a
 * session that is not running, its recorded selection.
 * @param ctx - Host context.
 * @param sessionId - DSH session id.
 * @returns the selection, or undefined when the session has none recorded.
 */
export async function sessionModelOf(ctx, sessionId) {
  if (typeof sessionId !== 'string') return undefined
  const agent = ctx.get('agents')?.get(sessionId)
  if (typeof agent?.model?.current === 'function') {
    const current = agent.model.current()
    return current === undefined ? undefined : toSelection(current)
  }
  const query = ctx.get('sessionQuery')
  if (typeof query?.observeSession !== 'function') return undefined
  let observation
  try {
    observation = await query.observeSession(sessionId)
    // The modelSelection projection's view: `next` is the pending choice or
    // the route of the last request.
    const view = observation?.projections?.values?.modelSelection
    const recorded = view?.next ?? view?.pending ?? view?.lastUsed
    return typeof recorded?.provider === 'string' && typeof recorded?.model === 'string' ? toSelection(recorded) : undefined
  } catch {
    return undefined
  } finally {
    observation?.[Symbol.dispose]?.()
  }
}

/**
 * Read the deployment default model (the one the Web UI saves).
 * @param ctx - Host context.
 * @returns the selection, or undefined without a default-model service.
 */
export function defaultModelOf(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') return toSelection(selection)
  } catch {
    // No default configured.
  }
  return undefined
}

/**
 * Whether the catalog no longer offers a selection's provider or model, for
 * example after a provider was removed from the profile. A provider the
 * catalog reports as failing is not counted: its models are unknown now, not
 * gone. Without a catalog nothing is called gone.
 * @param catalog - loaded catalog, or undefined.
 * @param selection - provider and model, or undefined.
 * @returns true when the selection names something the catalog dropped.
 */
export function isGoneModel(catalog, selection) {
  if (catalog === undefined || typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return false
  if (catalog.failures.some((failure) => failure?.id === selection.provider)) return false
  return findModel(catalog, selection) === undefined
}

/**
 * Whether two selections name the same provider, model and effort.
 * @param left - first selection.
 * @param right - second selection.
 * @returns true when they agree.
 */
export function sameSelection(left, right) {
  return left?.provider === right?.provider && left?.model === right?.model && left?.reasoningEffort === right?.reasoningEffort
}

/**
 * Cached reader for the Web model catalog.
 * @param ctx - Host context.
 * @returns `load()` resolving the catalog, or undefined when it is unavailable.
 */
export function createModelCatalog(ctx) {
  let cached
  let loadedAt = 0
  let pending
  return {
    /**
     * @param fresh - skip the short-lived cache (used before applying a pick).
     * @returns `{ groups, failures }` as the Web picker gets it, or undefined.
     */
    async load(fresh = false) {
      if (!fresh && cached !== undefined && Date.now() - loadedAt < CATALOG_TTL_MS) return cached
      pending ??= (async () => {
        const controller = ctx.get('sessionController')
        if (typeof controller?.modelCatalog !== 'function') return undefined
        const catalog = await controller.modelCatalog()
        cached = { groups: Array.isArray(catalog?.groups) ? catalog.groups : [], failures: Array.isArray(catalog?.failures) ? catalog.failures : [] }
        loadedAt = Date.now()
        return cached
      })().finally(() => { pending = undefined })
      try {
        return await pending
      } catch {
        return cached
      }
    },
  }
}

/**
 * Find a catalog entry for a selection.
 * @param catalog - loaded catalog.
 * @param selection - provider and model.
 * @returns `{ group, model }`, or undefined.
 */
export function findModel(catalog, selection) {
  const group = catalog?.groups.find((entry) => entry.id === selection?.provider)
  const model = group?.models.find((entry) => entry.id === selection?.model)
  return model === undefined ? undefined : { group, model }
}

/**
 * Resolve a provider callback key.
 * @param catalog - loaded catalog.
 * @param key - `catalogKey(provider)`.
 * @returns the provider group, or undefined.
 */
export function providerByKey(catalog, key) {
  return catalog?.groups.find((group) => catalogKey(group.id) === key)
}

/**
 * Resolve a model callback key.
 * @param catalog - loaded catalog.
 * @param key - `catalogKey(provider, model)`.
 * @returns `{ group, model }`, or undefined.
 */
export function modelByKey(catalog, key) {
  for (const group of catalog?.groups ?? []) {
    const model = group.models.find((entry) => catalogKey(group.id, entry.id) === key)
    if (model !== undefined) return { group, model }
  }
  return undefined
}

/**
 * Display name of a selection's model, as the Web picker shows it.
 * @param catalog - loaded catalog, or undefined.
 * @param selection - provider and model.
 * @returns the name, or the raw model id.
 */
export function modelName(catalog, selection) {
  if (selection === undefined) return '?'
  return findModel(catalog, selection)?.model.name ?? selection.model
}

/**
 * Effort choices for one catalog model, the same list the Web picker builds:
 * a provider-default entry when the model has no default effort, then its
 * efforts. A model without reasoning has none.
 * @param model - catalog model entry.
 * @param defaultLabel - label for the provider default.
 * @returns `{ id, name }` entries; `id` undefined means the provider default.
 */
export function effortChoices(model, defaultLabel) {
  const reasoning = model?.reasoning
  if (reasoning === undefined) return []
  return [
    ...(reasoning.defaultEffort === undefined ? [{ id: undefined, name: defaultLabel }] : []),
    ...reasoning.efforts.map((effort) => ({ id: effort.id, name: effort.name })),
  ]
}

/**
 * Display name of a selection's effective effort.
 * @param catalog - loaded catalog, or undefined.
 * @param selection - current selection.
 * @param defaultLabel - label for the provider default.
 * @returns the name.
 */
export function effortName(catalog, selection, defaultLabel) {
  const reasoning = findModel(catalog, selection)?.model.reasoning
  const effective = selection?.reasoningEffort ?? reasoning?.defaultEffort
  if (effective === undefined) return defaultLabel
  return reasoning?.efforts.find((effort) => effort.id === effective)?.name ?? effective
}

/**
 * The selection a model pick makes, by the Web picker's rule: the same model
 * keeps its effort, another model starts at its default effort.
 * @param current - the session's current selection.
 * @param provider - picked provider id.
 * @param model - picked catalog model entry.
 * @returns the selection to apply.
 */
export function pickedSelection(current, provider, model) {
  const same = current?.provider === provider && current?.model === model.id
  const reasoningEffort = same ? current.reasoningEffort ?? model.reasoning?.defaultEffort : model.reasoning?.defaultEffort
  return toSelection({ provider, model: model.id, reasoningEffort })
}

/**
 * Cut one page out of a list.
 * @param items - all entries.
 * @param page - requested page, clamped to the valid range.
 * @returns the page's items, its index and the page count.
 */
export function pageOf(items, page) {
  const pages = Math.max(1, Math.ceil(items.length / MODEL_PAGE_SIZE))
  const index = Math.min(Math.max(0, Number.isSafeInteger(page) ? page : 0), pages - 1)
  return { items: items.slice(index * MODEL_PAGE_SIZE, (index + 1) * MODEL_PAGE_SIZE), page: index, pages }
}
