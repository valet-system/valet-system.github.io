/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: scripts/check-undefined.mjs        run with `npm run check`     │
 * │                                                                     │
 * │ WHAT THIS IS                                                        │
 * │   Finds identifiers that are referenced but never bound anywhere —   │
 * │   the `no-undef` class of bug.                                       │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   `npm run build` does NOT catch this, and the gap is not obvious.   │
 * │   A bundler treats an unresolved name as a runtime global lookup,    │
 * │   which is perfectly legal JavaScript — `window.foo` is spelled      │
 * │   `foo`. So the build passes, and the page throws ReferenceError the │
 * │   instant React renders it, blanking the whole screen.               │
 * │                                                                     │
 * │   This is not hypothetical. StaffManager.jsx shipped referencing a   │
 * │   `credential` state variable that a refactor had deleted, plus a    │
 * │   `generatePin` import that was never added. Clean build, dead page, │
 * │   nothing in the terminal.                                           │
 * │                                                                     │
 * │   The project has no ESLint — this is the cheap 90% of what          │
 * │   `no-undef` would give us, using Babel's own scope analysis (the    │
 * │   same machinery the JSX transform already runs), so it understands  │
 * │   imports, hoisting, JSX and destructuring properly. A grep cannot:  │
 * │   it has no idea which scope a name belongs to.                      │
 * │                                                                     │
 * │ IF IT REPORTS A GLOBAL YOU ACTUALLY MEANT                            │
 * │   Add it to KNOWN below. That list is the allowlist of legitimate    │
 * │   free references; everything else is a bug.                         │
 * └─────────────────────────────────────────────────────────────────────┘
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'

const ROOT = process.argv[2] ?? 'src'
// Resolve Babel against the project rather than this file's directory, so the
// script still works if it is ever run from somewhere else.
const require = createRequire(resolve(process.cwd(), 'package.json'))
const { parse } = require('@babel/parser')
const _traverse = require('@babel/traverse')

const traverse = _traverse.default ?? _traverse

// Browser + JS builtins that are legitimately free references.
const KNOWN = new Set([
  'window', 'document', 'navigator', 'console', 'fetch', 'location', 'history',
  'localStorage', 'sessionStorage', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
  'Notification', 'AudioContext', 'webkitAudioContext', 'Audio', 'Image', 'Blob',
  'URL', 'URLSearchParams', 'FormData', 'Headers', 'Request', 'Response', 'Event',
  'CustomEvent', 'AbortController', 'IntersectionObserver', 'ResizeObserver',
  'MutationObserver', 'crypto', 'performance', 'matchMedia', 'alert', 'confirm',
  'structuredClone', 'reportError', 'globalThis', 'process', 'Buffer', '__dirname',
  'module', 'require', 'exports', 'React',
  // standard library
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math',
  'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'ReferenceError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy',
  'Reflect', 'Intl', 'NaN', 'Infinity', 'undefined', 'isNaN', 'isFinite',
  'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'TextEncoder', 'TextDecoder', 'atob', 'btoa',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array',
  'Int32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView',
])

function* walkDir(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walkDir(full)
    else if (/\.(js|jsx)$/.test(full)) yield full
  }
}

let failures = 0

for (const file of walkDir(ROOT)) {
  const code = readFileSync(file, 'utf8')
  let ast
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx'],
    })
  } catch (err) {
    console.log(`PARSE ERROR  ${relative(ROOT, file)}: ${err.message}`)
    failures++
    continue
  }

  traverse(ast, {
    Program(path) {
      // Babel records every reference it could not bind to a declaration.
      for (const [name, refPaths] of Object.entries(path.scope.globals)) {
        if (KNOWN.has(name)) continue
        const line = refPaths.loc?.start?.line ?? '?'
        console.log(`UNDEFINED    ${relative(ROOT, file)}:${line}  ${name}`)
        failures++
      }
    },
  })
}

console.log(failures === 0 ? '\nOK — no unbound identifiers.' : `\n${failures} problem(s).`)
process.exit(failures === 0 ? 0 : 1)
