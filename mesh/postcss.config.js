import autoprefixer from 'autoprefixer'
import tailwindcss from 'tailwindcss'

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
  plugins: [tailwindcss(), autoprefixer(), mergeTailwindBackdropDefaults],
}
