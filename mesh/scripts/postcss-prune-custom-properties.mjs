const CUSTOM_PROPERTY_REFERENCE = /var\((--[a-zA-Z0-9_-]+)/g

function referencedCustomProperties(value) {
  return [...value.matchAll(CUSTOM_PROPERTY_REFERENCE)].map((match) => match[1])
}

export function customPropertiesReferencedByRuntimeSource(source) {
  return new Set([...source.matchAll(/--[a-zA-Z0-9_-]+/g)].map((match) => match[0]))
}

export function pruneUnreachableCustomProperties(options = {}) {
  const retainedProperties = new Set(options.retainedProperties ?? [])

  return {
    postcssPlugin: 'mesh-prune-unreachable-custom-properties',
    OnceExit(root) {
      const definitions = new Map()
      const dependencies = new Map()
      const live = new Set(retainedProperties)

      root.walkDecls((declaration) => {
        const references = referencedCustomProperties(declaration.value)
        if (!declaration.prop.startsWith('--')) {
          references.forEach((property) => live.add(property))
          return
        }

        const propertyDefinitions = definitions.get(declaration.prop) ?? []
        propertyDefinitions.push(declaration)
        definitions.set(declaration.prop, propertyDefinitions)

        const propertyDependencies = dependencies.get(declaration.prop) ?? new Set()
        references.forEach((property) => propertyDependencies.add(property))
        dependencies.set(declaration.prop, propertyDependencies)
      })

      root.walkAtRules((atRule) => {
        referencedCustomProperties(atRule.params).forEach((property) => live.add(property))
      })

      let foundDependency = true
      while (foundDependency) {
        foundDependency = false
        for (const property of [...live]) {
          for (const dependency of dependencies.get(property) ?? []) {
            if (live.has(dependency)) continue
            live.add(dependency)
            foundDependency = true
          }
        }
      }

      for (const [property, propertyDefinitions] of definitions) {
        if (live.has(property)) continue
        propertyDefinitions.forEach((declaration) => declaration.remove())
      }

      root.walkRules((rule) => {
        if (rule.nodes.length === 0) rule.remove()
      })
    },
  }
}

pruneUnreachableCustomProperties.postcss = true
