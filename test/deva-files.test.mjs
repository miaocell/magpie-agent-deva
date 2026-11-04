import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { deleteProviderSecret, readProviderSecret, setProviderSecret } from "../lib/deva-files.mjs"
import { decodeSecret, encodeSecret } from "../lib/deva-secrets.mjs"

const key = Buffer.alloc(32, 7)

const tmpFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deva-files-"))
  return path.join(dir, "secrets.json")
}

test("a key goes in and comes back out, others untouched", () => {
  const file = tmpFile()
  fs.writeFileSync(file, JSON.stringify({ someone: encodeSecret("theirs", key) }), "utf8")

  assert.equal(setProviderSecret(file, "magpie", "magpie-deva", key).written, true)

  const store = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.deepEqual(Object.keys(store).sort(), ["magpie", "someone"])
  assert.equal(decodeSecret(readProviderSecret(file, "magpie"), key), "magpie-deva")
  assert.equal(decodeSecret(store.someone, key), "theirs")
})

test("reading a missing key yields null, not an error", () => {
  const file = tmpFile()
  assert.equal(readProviderSecret(file, "nope"), null)
  fs.writeFileSync(file, JSON.stringify({ other: "x" }), "utf8")
  assert.equal(readProviderSecret(file, "nope"), null)
})

test("deleting only removes the one provider's key", () => {
  const file = tmpFile()
  fs.writeFileSync(file, JSON.stringify({ magpie: encodeSecret("a", key), other: encodeSecret("b", key) }), "utf8")

  assert.equal(deleteProviderSecret(file, "magpie"), true)
  const store = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.deepEqual(Object.keys(store), ["other"])

  // Idempotent, and a missing file is not an error.
  assert.equal(deleteProviderSecret(file, "magpie"), false)
  assert.equal(deleteProviderSecret(path.join(os.tmpdir(), "deva-files-nope", "secrets.json"), "x"), false)
})

test("without a key nothing is written", () => {
  const file = tmpFile()
  assert.equal(setProviderSecret(file, "magpie", "value", null).written, false)
  assert.equal(fs.existsSync(file), false)
})
