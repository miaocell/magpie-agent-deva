import assert from "node:assert/strict"
import test from "node:test"
import {
  findGatewayProvider,
  restore,
  sameUrl,
  selectionFrom,
  syncSelection,
  validateConfig,
} from "../lib/deva-config.mjs"

const GATEWAY = "http://127.0.0.1:3425/v1"

// The shape Deva writes today: providers are a flat array, models live inside
// each one, and activeModelId is "<providerId>:<modelId>".
const sample = () => ({
  models: {
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        kind: "official",
        adapter: "anthropic",
        apiHost: "https://api.anthropic.com",
        enabled: false,
        models: [],
      },
      {
        id: "custom-1",
        name: "127.0.0.1:3425",
        kind: "custom",
        purpose: "llm",
        adapter: "openai",
        apiHost: "http://127.0.0.1:3425/v1",
        enabled: true,
        models: [{ id: "auto/deepseek-v4.1-flash", name: "auto/deepseek-v4.1-flash", enabled: true }],
      },
    ],
    activeModelId: "custom-1:auto/deepseek-v4.1-flash",
    activeEffort: "max",
  },
  profile: { avatar: "keep me" },
})

const picked = (...ids) => ids.map((id) => ({ id, name: id }))

test("sameUrl ignores a trailing slash and case", () => {
  assert.equal(sameUrl("HTTP://127.0.0.1:3425/v1/", "http://127.0.0.1:3425/v1"), true)
  assert.equal(sameUrl("", ""), false)
  assert.equal(sameUrl("http://a/v1", "http://b/v1"), false)
})

test("every ticked model goes into the existing gateway provider", () => {
  const config = sample()
  const { config: next, state } = syncSelection(config, {
    models: picked("group/fast", "group/slow"),
    gatewayUrl: GATEWAY,
  })

  assert.equal(next.models.providers.length, config.models.providers.length)
  assert.equal(state.created, false)
  assert.equal(state.providerId, "custom-1")

  const provider = findGatewayProvider(next, GATEWAY)
  assert.deepEqual(
    provider.models.map((m) => m.id),
    ["auto/deepseek-v4.1-flash", "group/fast", "group/slow"]
  )
  // Everything outside the one provider is untouched.
  assert.deepEqual(next.profile, { avatar: "keep me" })
  assert.equal(next.models.activeEffort, "max")
})

test("the model in use is left alone while it is still in the list", () => {
  const config = sample()
  const { config: next } = syncSelection(config, { models: picked("group/fast"), gatewayUrl: GATEWAY })
  assert.equal(next.models.activeModelId, "custom-1:auto/deepseek-v4.1-flash")
})

test("a provider is created when none points at the gateway", () => {
  const config = sample()
  const { config: next, state } = syncSelection(config, {
    models: picked("group/fast"),
    gatewayUrl: "http://127.0.0.1:9999/v1",
  })

  const created = next.models.providers.at(-1)
  assert.equal(created.id, "magpie")
  assert.equal(created.apiHost, "http://127.0.0.1:9999/v1")
  assert.equal(created.adapter, "openai")
  assert.equal(created.enabled, true)
  assert.deepEqual(created.models, [{ id: "group/fast", name: "group/fast", enabled: true }])
  assert.equal(state.created, true)
  // Nothing usable was in that provider before, so the model in use follows it.
  assert.equal(next.models.activeModelId, "magpie:group/fast")
})

test("unticking takes the models magpie added back out, the user's own stay", () => {
  const config = sample()
  const first = syncSelection(config, { models: picked("group/fast", "group/slow"), gatewayUrl: GATEWAY })
  const second = syncSelection(first.config, { models: picked("group/slow"), gatewayUrl: GATEWAY }, first.state)

  const provider = findGatewayProvider(second.config, GATEWAY)
  assert.deepEqual(
    provider.models.map((m) => m.id),
    ["auto/deepseek-v4.1-flash", "group/slow"]
  )
  assert.deepEqual(second.state.added, ["group/slow"])
})

test("the model in use moves when the one it named is taken out", () => {
  const config = sample()
  const first = syncSelection(config, { models: picked("group/fast"), gatewayUrl: GATEWAY })
  // Deva had this one in use; unticking it must not leave a dangling id.
  first.config.models.activeModelId = "custom-1:group/fast"
  const second = syncSelection(first.config, { models: picked("group/slow"), gatewayUrl: GATEWAY }, first.state)

  assert.equal(second.config.models.activeModelId, "custom-1:auto/deepseek-v4.1-flash")
})

test("an empty tick list leaves no dangling model", () => {
  const config = sample()
  const { config: next } = syncSelection(config, { models: [], gatewayUrl: GATEWAY })
  const provider = findGatewayProvider(next, GATEWAY)
  assert.deepEqual(provider.models.map((m) => m.id), ["auto/deepseek-v4.1-flash"])
  assert.equal(next.models.activeModelId, "custom-1:auto/deepseek-v4.1-flash")
})

test("the original list and model are kept for restore", () => {
  const config = sample()
  const { state } = syncSelection(config, { models: picked("group/fast"), gatewayUrl: GATEWAY })

  assert.equal(state.prevActiveModelId, "custom-1:auto/deepseek-v4.1-flash")
  assert.deepEqual(state.prevModels, [
    { id: "auto/deepseek-v4.1-flash", name: "auto/deepseek-v4.1-flash", enabled: true },
  ])
})

test("later syncs keep the first state", () => {
  const config = sample()
  const first = syncSelection(config, { models: picked("group/fast"), gatewayUrl: GATEWAY })
  const second = syncSelection(first.config, { models: picked("group/slow"), gatewayUrl: GATEWAY }, first.state)

  assert.equal(second.state.prevActiveModelId, first.state.prevActiveModelId)
  assert.deepEqual(second.state.prevModels, first.state.prevModels)
})

test("restore puts back a reused provider", () => {
  const config = sample()
  const { config: next, state } = syncSelection(config, { models: picked("group/fast"), gatewayUrl: GATEWAY })
  assert.deepEqual(restore(next, state), config)
})

test("restore removes a provider the plugin created", () => {
  const config = sample()
  const { config: next, state } = syncSelection(config, {
    models: picked("group/fast"),
    gatewayUrl: "http://127.0.0.1:9999/v1",
  })
  const back = restore(next, state)

  assert.equal(back.models.providers.length, config.models.providers.length)
  assert.equal(back.models.activeModelId, "custom-1:auto/deepseek-v4.1-flash")
})

test("no activeModelId before the first sync means none after disconnect", () => {
  const config = sample()
  delete config.models.activeModelId
  const { config: next, state } = syncSelection(config, { models: picked("group/fast"), gatewayUrl: GATEWAY })
  const back = restore(next, state)
  assert.equal("activeModelId" in back.models, false)
})

test("a model id with a colon is refused, Deva could not resolve it", () => {
  assert.throws(() => syncSelection(sample(), { models: picked("a:b"), gatewayUrl: GATEWAY }), /冒号/)
})

test("a config that is not Deva's is refused", () => {
  assert.equal(validateConfig(null), "config.json 不是对象")
  assert.equal(validateConfig({ models: { providers: {} } }), "config.models.providers 不是数组")
  assert.equal(validateConfig(sample()), null)
  assert.throws(() => syncSelection({ models: { providers: {} } }, { models: picked("x"), gatewayUrl: GATEWAY }))
})

test("duplicate ids are only added once", () => {
  const { config: next } = syncSelection(sample(), {
    models: [{ id: "group/fast", name: "Fast" }, { id: "group/fast", name: "Fast again" }],
    gatewayUrl: GATEWAY,
  })
  const provider = findGatewayProvider(next, GATEWAY)
  assert.equal(provider.models.filter((m) => m.id === "group/fast").length, 1)
})

test("selectionFrom reads the model list and ignores an empty one", () => {
  assert.equal(selectionFrom(null), null)
  assert.equal(selectionFrom({}), null)
  assert.equal(selectionFrom({ models: [] }), null)
  assert.deepEqual(
    selectionFrom({ models: [{ id: "group/fast", name: "Fast" }], "gateway.url": ` ${GATEWAY} ` }),
    { models: [{ id: "group/fast", name: "Fast" }], gatewayUrl: GATEWAY, gatewayKey: "" }
  )
})

test("selectionFrom reads gateway.url the way magpie nests it", () => {
  // connect returns "gateway.url", a dotted path, so magpie writes
  // {"gateway": {"url": …}} — not the literal key.
  assert.deepEqual(selectionFrom({ models: [{ id: "group/fast" }], gateway: { url: ` ${GATEWAY} ` } }), {
    models: [{ id: "group/fast", name: "group/fast" }],
    gatewayUrl: GATEWAY,
    gatewayKey: "",
  })
})

test("selectionFrom picks up the key the gateway expects", () => {
  // The gateway answers an unknown key with the whole catalogue and the issued
  // key with just the ticked models, so this has to reach Deva.
  const sel = selectionFrom({
    models: [{ id: "docode/gpt" }],
    gateway: { url: GATEWAY, key: " magpie-deva " },
  })
  assert.equal(sel.gatewayKey, "magpie-deva")
})

test("a disabled provider the plugin switched on goes back off", () => {
  const config = sample()
  const gateway = config.models.providers[1]
  gateway.enabled = false

  const { config: next, state } = syncSelection(config, { models: picked("group/fast"), gatewayUrl: GATEWAY })
  assert.equal(findGatewayProvider(next, GATEWAY).enabled, true)
  assert.equal(state.prevEnabled, false)
  assert.deepEqual(restore(next, state), config)
})

test("a created provider keeps the models the user added to it after the fact", () => {
  const config = sample()
  const first = syncSelection(config, { models: picked("group/fast"), gatewayUrl: "http://127.0.0.1:9999/v1" })
  const created = findGatewayProvider(first.config, "http://127.0.0.1:9999/v1")
  // The user opens Deva, adds a model of their own to the provider magpie made.
  created.models.push({ id: "mine", name: "mine", enabled: true })

  const back = restore(first.config, first.state)
  const rest = findGatewayProvider(back, "http://127.0.0.1:9999/v1")
  assert.notEqual(rest, null)
  assert.deepEqual(rest.models.map((m) => m.id), ["mine"])
})

test("the model in use is left alone once Deva points at another provider", () => {
  const config = sample()
  const { config: next, state } = syncSelection(config, { models: picked("group/fast"), gatewayUrl: GATEWAY })
  // While connected the user picks a model from a different provider in Deva.
  next.models.activeModelId = "anthropic:claude-sonnet"

  const back = restore(next, state)
  assert.equal(back.models.activeModelId, "anthropic:claude-sonnet")
})

test("the model in use is put back while Deva still points at magpie", () => {
  const config = sample()
  const { config: next, state } = syncSelection(config, { models: picked("group/fast"), gatewayUrl: GATEWAY })
  // While connected the user picks the magpie model in Deva's own list.
  next.models.activeModelId = "custom-1:group/fast"

  const back = restore(next, state)
  assert.equal(back.models.activeModelId, config.models.activeModelId)
})

test("a model added before magpie ever touched the provider stays the user's", () => {
  // It is in prevModels, so it is genuinely the user's. Ticking it in magpie
  // borrows it; unticking must not delete something they made themselves.
  const config = sample()
  findGatewayProvider(config, GATEWAY).models.push({ id: "group/hand-added", name: "hand", enabled: true })

  const first = syncSelection(config, { models: picked("group/hand-added"), gatewayUrl: GATEWAY })
  assert.deepEqual(first.state.added, [])

  const second = syncSelection(first.config, { models: picked("group/other"), gatewayUrl: GATEWAY }, first.state)
  const ids = findGatewayProvider(second.config, GATEWAY).models.map((m) => m.id)
  assert.equal(ids.includes("group/hand-added"), true)
})

test("bookkeeping follows the ticked list even when config.json did not move", () => {
  // The state file can be left stale by an earlier version or by Deva rewriting
  // its config. The next sync has to re-claim the ticked models, or unticking
  // them later would leave them in Deva for good.
  const config = sample()
  const first = syncSelection(config, { models: picked("group/fast", "group/slow"), gatewayUrl: GATEWAY })

  // Stale: config already matches, but nothing is recorded as magpie's.
  const stale = { ...first.state, added: ["group/long-gone"] }
  const second = syncSelection(first.config, { models: picked("group/fast", "group/slow"), gatewayUrl: GATEWAY }, stale)
  assert.deepEqual(second.state.added, ["group/fast", "group/slow"])
  assert.equal(second.changed, false)

  const untick = syncSelection(second.config, { models: picked("group/slow"), gatewayUrl: GATEWAY }, second.state)
  const ids = findGatewayProvider(untick.config, GATEWAY).models.map((m) => m.id)
  assert.equal(ids.includes("group/fast"), false)
})

test("a model the user had before magpie stays through unticking", () => {
  // The user's own model, never ticked, must survive every sync.
  const config = sample()
  const first = syncSelection(config, { models: picked("group/fast"), gatewayUrl: GATEWAY })
  const second = syncSelection(first.config, { models: picked("group/slow"), gatewayUrl: GATEWAY }, first.state)

  const ids = findGatewayProvider(second.config, GATEWAY).models.map((m) => m.id)
  assert.equal(ids.includes("auto/deepseek-v4.1-flash"), true)
  assert.equal(ids.includes("group/fast"), false)
})
