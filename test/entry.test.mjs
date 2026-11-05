import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// index.mjs only runs inside magpie's Bun host, so a typo in it never reaches
// the unit tests — and it fails silently there: the tick throws, magpie logs
// it, and nothing is written. These checks catch the two ways that happened.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sourceFiles = ["index.mjs", "lib/deva-config.mjs", "lib/deva-files.mjs", "lib/deva-secrets.mjs"].map(
  (relative) => ({ relative, code: fs.readFileSync(path.join(root, relative), "utf8") })
)

// Every identifier called or used as a value in each module must be declared
// there, imported, or a language/global builtin. Deliberately rough: it hits
// `readProviderSecret is not defined` without needing a parser.
test("every file only uses names it declares, imports or gets from a global", () => {
  const declared = (code) => {
    const names = new Set()
    for (const re of [
      /(?:^|\n)\s*(?:import|export)\s+(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/g,
      /(?:^|\n)\s*(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g,
      /import\s*\{([^}]*)\}/g,
      /import\s+([A-Za-z_$][\w$]*)\s+from/g,
    ]) {
      for (const match of code.matchAll(re)) {
        const group = match[1] ?? ""
        for (const piece of group.split(",")) {
          const name = piece.split(/\s+as\s+/).pop()?.trim()
          if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
        }
      }
    }
    return names
  }

  for (const { relative, code } of sourceFiles) {
    const names = declared(code)
    // Comments and strings mention words that look like calls; only code counts.
    const bare = code
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    const called = new Set([...bare.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))
    const builtins = new Set([
      "if", "for", "while", "switch", "catch", "function", "return", "typeof", "await",
      "new", "delete", "void", "do", "else", "try", "throw", "import", "super", "async",
      "String", "Number", "Boolean", "Object", "Array", "JSON", "Math", "Promise",
      "Buffer", "Error", "Set", "Map", "Symbol", "RegExp", "Date", "parseInt",
      "parseFloat", "isNaN", "decodeURIComponent", "encodeURIComponent", "structuredClone",
      "setTimeout", "setInterval", "clearInterval", "clearTimeout", "console", "require",
    ])
    const declaredFns = new Set(
      [...code.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
    )
    const missing = [...called].filter(
      (name) => !names.has(name) && !declaredFns.has(name) && !builtins.has(name)
    )
    assert.deepEqual(missing, [], `${relative} calls undeclared names: ${missing.join(", ")}`)
  }
})
