import autoprefixer from 'autoprefixer'
import tailwindcss from 'tailwindcss'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  customPropertiesReferencedByRuntimeSource,
  pruneUnreachableCustomProperties,
} from './scripts/postcss-prune-custom-properties.mjs'

function rendererRuntimeSource(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) return rendererRuntimeSource(entryPath)
      return ['.ts', '.tsx'].includes(extname(entry.name))
        ? [readFileSync(entryPath, 'utf8')]
        : []
    })
    .join('\n')
}

const runtimeCustomProperties = customPropertiesReferencedByRuntimeSource(
  rendererRuntimeSource(fileURLToPath(new URL('./src/', import.meta.url))),
)

function declarationSignature(rule) {
  return rule.nodes
    .filter((node) => node.type === 'decl')
    .map((node) => `${node.prop}\u0000${node.value}\u0000${node.important ? '1' : '0'}`)
    .join('\u0001')
}

const mergeTailwindBackdropDefaults = {
  postcssPlugin: 'mesh-merge-tailwind-backdrop-defaults',
  OnceExit(root) {
    const topLevelRules = root.nodes.filter((node) => node.type === 'rule')
    const backdropIndex = topLevelRules.findIndex((rule) => rule.selector === '::backdrop')
    if (backdropIndex <= 0) return

    const baseRule = topLevelRules[backdropIndex - 1]
    const backdropRule = topLevelRules[backdropIndex]
    const normalizedBaseSelector = baseRule.selector.replace(/\s+/g, '')
    const baseSignature = declarationSignature(baseRule)
    const backdropSignature = declarationSignature(backdropRule)

    // Tailwind emits these adjacent rules with the same 51 custom-property
    // defaults. Combining their selectors is cascade-equivalent in WebView2
    // and avoids carrying the full reset block twice in every renderer build.
    if (
      normalizedBaseSelector !== '*,::before,::after'
      || baseRule.nodes.some((node) => node.type !== 'decl')
      || backdropRule.nodes.some((node) => node.type !== 'decl')
      || baseSignature.length === 0
      || baseSignature !== backdropSignature
    ) {
      return
    }

    baseRule.selector = `${baseRule.selector}, ::backdrop`
    backdropRule.remove()
  },
}

export default {
  plugins: [
    tailwindcss(),
    // The first beta ships only in Chromium-based Windows WebView2. Keep
    // explicit Tauri/WebView prefixes in source, but do not emit Firefox,
    // Opera, or obsolete Chromium compatibility declarations.
    autoprefixer({ overrideBrowserslist: ['Chrome >= 105'] }),
    mergeTailwindBackdropDefaults,
    pruneUnreachableCustomProperties({ retainedProperties: runtimeCustomProperties }),
  ],
}
