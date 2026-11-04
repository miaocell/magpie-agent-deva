// Pure helpers for Deva's ~/.deva/config.json. No file access here: index.mjs
// does the reading and writing, and the tests run these against a copy.

export const GATEWAY_PROVIDER_ID = "magpie"
const DEFAULT_ACCENT = "#8a8a94"

const normUrl = (value) => String(value ?? "").trim().replace(/\/+$/, "").toLowerCase()

export function sameUrl(a, b) {
  const left = normUrl(a)
  return left !== "" && left === normUrl(b)
}

/** The provider that already talks to this gateway, if there is one. */
export function findGatewayProvider(config, gatewayUrl) {
  const providers = config?.models?.providers
  if (!Array.isArray(providers)) return null
  return providers.find((p) => p && typeof p === "object" && sameUrl(p.apiHost, gatewayUrl)) ?? null
}

/** Why this config.json cannot be written, or null when it looks like Deva's. */
export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "config.json 不是对象"
  const models = config.models
  if (models !== undefined && (models === null || typeof models !== "object" || Array.isArray(models))) {
    return "config.models 不是对象"
  }
  if (models?.providers !== undefined && !Array.isArray(models.providers)) {
    return "config.models.providers 不是数组"
  }
  return null
}

function uniqueProviderId(providers, base) {
  const taken = new Set(providers.map((p) => p?.id).filter((id) => typeof id === "string"))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/**
 * Point Deva at the models ticked for it. Returns a new config, the state
 * needed to undo this later, and whether anything actually changed.
 *
 * The ticked models are added to the gateway provider's list; the ones magpie
 * added last time and no longer ticks are taken back out. Models the user put
 * there themselves stay, and so does the model in use unless it is one of the
 * ones being taken out: Deva shows no model at all while activeModelId names
 * something that is not in the list.
 *
 * `state` is only recorded the first time: later syncs keep the original
 * values so disconnecting restores what the user had before magpie.
 */
export function syncSelection(config, { models, gatewayUrl }, existingState = null) {
  if (!Array.isArray(models)) throw new Error("没有拿到模型列表")
  if (typeof gatewayUrl !== "string" || gatewayUrl.trim() === "") throw new Error("网关地址为空")

  const wanted = []
  for (const entry of models) {
    const id = typeof entry === "string" ? entry.trim() : String(entry?.id ?? "").trim()
    if (id === "") continue
    if (id.includes(":")) throw new Error(`模型 id 里不能有冒号，Deva 用它分隔供应商和模型：${id}`)
    if (!wanted.some((m) => m.id === id)) wanted.push({ id, name: String(entry?.name ?? id) })
  }

  const invalid = validateConfig(config)
  if (invalid) throw new Error(invalid)

  const next = structuredClone(config)
  next.models ??= {}
  next.models.providers ??= []
  const providers = next.models.providers

  const prevActiveModelId =
    typeof config.models?.activeModelId === "string" ? config.models.activeModelId : null

  let provider = findGatewayProvider(next, gatewayUrl)
  let created = false
  if (!provider) {
    provider = {
      id: uniqueProviderId(providers, GATEWAY_PROVIDER_ID),
      name: "magpie",
      kind: "custom",
      purpose: "llm",
      accent: DEFAULT_ACCENT,
      adapter: "openai",
      apiHost: gatewayUrl,
      enabled: true,
      models: [],
    }
    providers.push(provider)
    created = true
  }

  // The original values are recorded once, before anything is touched. Later
  // syncs keep them, so disconnecting goes back to what the user had before
  // magpie, not to the previous tick set.
  let state =
    existingState && existingState.providerId === provider.id
      ? existingState
      : {
          providerId: provider.id,
          created,
          prevActiveModelId,
          prevModels: created ? null : structuredClone(provider.models ?? []),
        }

  // A provider the user added themselves is only touched where it has to be:
  // it is enabled, its address stays as the user typed it, and the models they
  // put there stay.
  //
  // A provider that already existed is the user's, so the switch is recorded
  // before it is flipped: disconnecting has to put it back off, not leave it on.
  if (state.created !== true && state.prevEnabled === undefined) state = { ...state, prevEnabled: provider.enabled }

  if (typeof provider.adapter !== "string" || provider.adapter === "") provider.adapter = "openai"
  if (provider.enabled !== true) provider.enabled = true
  if (!Array.isArray(provider.models)) provider.models = []

  const added = Array.isArray(state.added) ? state.added : []
  const nextAdded = []

  // What the user had before magpie ever touched this provider. A model on this
  // list is theirs even while it is ticked, so unticking must not take it away.
  const theirs = new Set((Array.isArray(state.prevModels) ? state.prevModels : []).map((m) => m?.id))

  // Take back the models magpie added last time that are no longer ticked.
  provider.models = provider.models.filter((m) => !added.includes(m?.id) || wanted.some((w) => w.id === m.id))

  for (const model of wanted) {
    const existing = provider.models.find((m) => m?.id === model.id)
    if (existing) {
      if (typeof existing.name !== "string" || existing.name === "") existing.name = model.name
      if (existing.enabled !== true) existing.enabled = true
    } else {
      provider.models.push({ id: model.id, name: model.name, enabled: true })
    }
    // Ownership has to survive a model the user happened to add by hand before
    // ticking it. Recording only the ones that were new lost that, and then
    // unticking left the model behind forever.
    if (added.includes(model.id) || !theirs.has(model.id)) nextAdded.push(model.id)
  }

  state = { ...state, added: nextAdded }

  // Deva shows no model while activeModelId names one that is not in the list,
  // so it follows the list rather than pointing at something gone.
  const activeIsHere =
    typeof next.models.activeModelId === "string" &&
    next.models.activeModelId.startsWith(`${provider.id}:`) &&
    provider.models.some((m) => m?.id === next.models.activeModelId.slice(provider.id.length + 1))

  if (!activeIsHere) {
    if (provider.models.length > 0) next.models.activeModelId = `${provider.id}:${provider.models[0].id}`
    else delete next.models.activeModelId
  }

  const changed = JSON.stringify(next) !== JSON.stringify(config)
  return { config: next, state, changed }
}

/** Put back what was there before the first sync. Returns a new config. */
export function restore(config, state) {
  const next = structuredClone(config)
  const models = next.models
  if (!models || !state) return next

  const providers = Array.isArray(models.providers) ? models.providers : null
  if (providers && typeof state.providerId === "string") {
    const index = providers.findIndex((p) => p && p.id === state.providerId)
    if (index >= 0) {
      const provider = providers[index]
      if (state.created) {
        // The provider itself is magpie's, but the user may have added models of
        // their own to it since; those cannot be thrown away with it.
        const ours = new Set(Array.isArray(state.added) ? state.added : [])
        const theirs = (Array.isArray(provider.models) ? provider.models : []).filter((m) => !ours.has(m?.id))
        if (theirs.length === 0) providers.splice(index, 1)
        else provider.models = theirs
      } else {
        if (Array.isArray(state.prevModels)) provider.models = structuredClone(state.prevModels)
        if (state.prevEnabled !== undefined) provider.enabled = state.prevEnabled
      }
    }
  }

  // The model in use is only put back while Deva still points at magpie's
  // provider. Once the user has picked another provider's model in Deva, that
  // choice is theirs and magpie disconnecting has no business overriding it.
  const stillOnOurs =
    typeof state.providerId === "string" &&
    typeof models.activeModelId === "string" &&
    models.activeModelId.startsWith(`${state.providerId}:`)

  if (stillOnOurs) {
    if (typeof state.prevActiveModelId === "string") models.activeModelId = state.prevActiveModelId
    else delete models.activeModelId
  }

  return next
}

/** The models magpie recorded for Deva, or null when it is disconnected. */
export function selectionFrom(file) {
  if (!file || typeof file !== "object") return null
  const list = file.models
  if (!Array.isArray(list)) return null
  const models = list
    .map((m) =>
      typeof m === "string"
        ? { id: m.trim(), name: m.trim() }
        : { id: String(m?.id ?? "").trim(), name: String(m?.name ?? m?.id ?? "").trim() }
    )
    .filter((m) => m.id !== "")
  if (models.length === 0) return null
  // connect's "gateway.url" is a dotted path: magpie nests it, it does not
  // write the literal key. Read both shapes, in case that ever changes.
  const gateway = file.gateway
  const gatewayUrl =
    (gateway && typeof gateway === "object" ? gateway.url : undefined) ?? file["gateway.url"]
  const gatewayKey =
    (gateway && typeof gateway === "object" ? gateway.key : undefined) ?? file["gateway.key"]
  return {
    models,
    gatewayUrl: typeof gatewayUrl === "string" ? gatewayUrl.trim() : "",
    gatewayKey: typeof gatewayKey === "string" ? gatewayKey.trim() : "",
  }
}
