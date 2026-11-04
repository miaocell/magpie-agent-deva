// Deva's config.json and secrets.json, as far as this plugin is concerned.
//
// Both paths follow DEVA_HOME (Deva's own override for portable installs), and
// the safeStorage key lives in Electron's Local State under the app's userData —
// AppData/Roaming/@deva/desktop on Windows, ~/Library/Application Support/@deva
// on a Mac.
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { encodeSecret, safeStorageKey } from "./deva-secrets.mjs"

const run = promisify(execFile)

/** Deva's data directory: DEVA_HOME if set, otherwise ~/.deva — same rule as Deva's services/config.ts. */
export function devaHome() {
  const override = process.env.DEVA_HOME?.trim()
  return override && override.length > 0 ? override : path.join(os.homedir(), ".deva")
}

/** Where magpie writes what was picked. Its own `~` expansion lands here regardless of DEVA_HOME. */
export function magpieDir() {
  return path.join(os.homedir(), ".deva")
}

export function files() {
  const home = devaHome()
  return {
    home,
    selection: path.join(magpieDir(), ".magpie-agent.json"),
    state: path.join(home, ".magpie-agent.state.json"),
    backup: path.join(home, ".magpie-agent.config-backup.json"),
    config: path.join(home, "config.json"),
    secrets: path.join(home, "secrets.json"),
  }
}

export function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) }
  } catch (error) {
    return { ok: false, missing: error?.code === "ENOENT" }
  }
}

export function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  fs.renameSync(tmp, file)
}

export async function devaRunning() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("tasklist", ["/FI", "IMAGENAME eq Deva.exe", "/NH"], {
        windowsHide: true,
        timeout: 5000,
      })
      return /Deva\.exe\s+\d+/i.test(stdout)
    }
    const { stdout } = await run("pgrep", ["-x", "Deva"], { timeout: 5000 })
    return stdout.trim() !== ""
  } catch {
    return false
  }
}

// --- the safeStorage key -----------------------------------------------------

/** Where Electron keeps the wrapped safeStorage key. */
function localStateCandidates() {
  const out = []
  const name = process.env.DEVA_USER_DATA || "@deva/desktop"
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    out.push(path.join(roaming, name, "Local State"))
  } else if (process.platform === "darwin") {
    out.push(path.join(os.homedir(), "Library", "Application Support", name, "Local State"))
  } else {
    const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
    out.push(path.join(config, name, "Local State"))
  }
  return out
}

/** Unwrap the OS-encrypted safeStorage key with DPAPI / Keychain / libsecret via Electron's own rules. */
async function unwrapSafeStorageKey(wrapped) {
  if (process.platform === "win32") {
    return unwrapWithDpapi(wrapped)
  }
  // macOS and Linux wrap the key differently; unsupported for now rather than
  // guessing wrong and writing something Deva cannot read.
  return null
}

async function unwrapWithDpapi(blob) {
  // Base64 of the DPAPI-wrapped 32 bytes, minus Electron's "DPAPI" marker.
  const raw = Buffer.from(blob, "base64")
  if (raw.subarray(0, 5).toString("ascii") !== "DPAPI") return null
  const payload = raw.subarray(5)
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$bytes=[Convert]::FromBase64String('${payload.toString("base64")}')
$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,'CurrentUser')
[Convert]::ToBase64String($plain)
`
  try {
    const { stdout } = await run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15000 }
    )
    return safeStorageKey(Buffer.from(stdout.trim(), "base64"))
  } catch {
    return null
  }
}

/** The safeStorage key, or null when it cannot be read (encryption unavailable / other OS). */
export async function safeStorageKeyFromDisk() {
  for (const file of localStateCandidates()) {
    const state = readJson(file)
    const wrapped = state.ok ? state.value?.os_crypt?.encrypted_key : null
    if (typeof wrapped !== "string" || wrapped === "") continue
    const key = await unwrapSafeStorageKey(wrapped)
    if (key) return key
  }
  return null
}

// --- what Deva has stored for a provider -------------------------------------

/**
 * Put `value` under `providerId` in secrets.json, the way Deva's own setSecret
 * does. Returns:
 *   { written: true }   — the file now holds it
 *   { written: false }  — could not encrypt here (other OS, no key); caller leaves it be
 */
export function setProviderSecret(file, providerId, value, key) {
  if (!key) return { written: false }
  const current = readJson(file)
  const store = current.ok && current.value && typeof current.value === "object" ? current.value : {}
  store[providerId] = encodeSecret(value, key)
  writeJson(file, store)
  return { written: true }
}

/** Remove a provider's key, leaving everyone else's alone. */
export function deleteProviderSecret(file, providerId) {
  const current = readJson(file)
  if (!current.ok || !current.value || typeof current.value !== "object") return false
  if (!(providerId in current.value)) return false
  delete current.value[providerId]
  writeJson(file, current.value)
  return true
}

/** The stored (still encrypted) value for a provider, or null when there is none. */
export function readProviderSecret(file, providerId) {
  const current = readJson(file)
  if (!current.ok || !current.value || typeof current.value !== "object") return null
  const value = current.value[providerId]
  return typeof value === "string" ? value : null
}
