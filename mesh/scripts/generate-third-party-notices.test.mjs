import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  UNKNOWN_LICENSE,
  checkNoticeFile,
  collectJavaScriptPackages,
  createNoticeDocument,
  normalizeLicense,
  uniqueSorted,
} from './generate-third-party-notices.mjs'

async function withProject(run) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'mesh-third-party-notices-'))
  try {
    await run(projectRoot)
  } finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
}

async function writeManifest(projectRoot, relativePath, manifest) {
  const directory = join(projectRoot, relativePath)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest), 'utf8')
}

test('lockfile metadata stays canonical when a platform package is installed', async () => {
  await withProject(async (projectRoot) => {
    const relativePath = 'node_modules/example'
    await writeManifest(projectRoot, relativePath, {
      name: 'manifest-name',
      version: '1.2.3',
      license: 'Apache-2.0',
      repository: 'git+https://example.test/manifest.git',
    })
    const packages = await collectJavaScriptPackages(projectRoot, { packages: {
      '': {},
      [relativePath]: {
        version: '9.9.9',
        license: 'MIT',
        repository: 'https://example.test/lock.git',
      },
    } })

    assert.deepEqual(packages, [{
      name: 'example',
      version: '9.9.9',
      license: 'MIT',
      source: 'https://example.test/lock.git',
    }])
  })
})

test('missing optional manifest uses lockfile SPDX license and repository', async () => {
  await withProject(async (projectRoot) => {
    const packages = await collectJavaScriptPackages(projectRoot, { packages: {
      'node_modules/@example/linux-x64': {
        version: '4.5.6',
        license: 'MIT',
        optional: true,
        repository: { url: 'git+https://example.test/platform.git' },
        resolved: 'https://registry.example.test/platform.tgz',
      },
    } })

    assert.deepEqual(packages, [{
      name: '@example/linux-x64',
      version: '4.5.6',
      license: 'MIT',
      source: 'https://example.test/platform.git',
    }])
  })
})

test('installed manifest fills metadata that the lockfile does not contain', async () => {
  await withProject(async (projectRoot) => {
    const relativePath = 'node_modules/example'
    await writeManifest(projectRoot, relativePath, {
      name: 'example',
      version: '1.0.0',
      license: 'BSD-3-Clause',
      homepage: 'https://example.test/package',
    })
    const [dependency] = await collectJavaScriptPackages(projectRoot, { packages: {
      [relativePath]: { version: '1.0.0' },
    } })

    assert.equal(dependency.license, 'BSD-3-Clause')
    assert.equal(dependency.source, 'https://example.test/package')
  })
})

test('optional platform package output is independent of installation state', async () => {
  await withProject(async (projectRoot) => {
    const relativePath = 'node_modules/@example/platform-x64'
    const lock = { packages: {
      [relativePath]: {
        version: '4.5.6',
        license: 'MIT',
        optional: true,
        resolved: 'https://registry.example.test/platform-x64.tgz',
      },
    } }

    const missing = await collectJavaScriptPackages(projectRoot, lock)
    await writeManifest(projectRoot, relativePath, {
      name: '@example/platform-x64',
      version: '4.5.6',
      license: 'MIT',
      repository: 'https://example.test/upstream.git',
    })
    const installed = await collectJavaScriptPackages(projectRoot, lock)

    assert.deepEqual(installed, missing)
    assert.equal(
      createNoticeDocument(installed, []).document,
      createNoticeDocument(missing, []).document,
    )
  })
})

test('genuinely absent manifest and lockfile licenses remain release-blocking', async () => {
  await withProject(async (projectRoot) => {
    const [dependency] = await collectJavaScriptPackages(projectRoot, { packages: {
      'node_modules/example-platform': {
        version: '1.0.0',
        optional: true,
        resolved: 'https://registry.example.test/example-platform.tgz',
      },
    } })
    const result = createNoticeDocument([dependency], [])
    const noticesPath = join(projectRoot, 'THIRD_PARTY_NOTICES.md')
    await writeFile(noticesPath, result.document, 'utf8')

    assert.equal(dependency.license, UNKNOWN_LICENSE)
    assert.equal(result.unknown.length, 1)
    assert.match(result.document, /Entries requiring license review: 1/)
    assert.deepEqual(await checkNoticeFile(noticesPath, result.document, result.unknown.length), [
      'Third-party notice check blocked: 1 dependencies have unresolved licenses.',
    ])
  })
})

test('legacy license arrays are trimmed, deduplicated, and sorted deterministically', () => {
  assert.equal(normalizeLicense([
    { type: 'MIT' },
    ' Apache-2.0 ',
    { type: 'MIT' },
    {},
  ]), 'Apache-2.0 OR MIT')
})

test('lockfile source fallback prefers repository, then homepage, then resolved URL', async () => {
  await withProject(async (projectRoot) => {
    const packages = await collectJavaScriptPackages(projectRoot, { packages: {
      'node_modules/with-repository': {
        version: '1.0.0', license: 'MIT', optional: true,
        repository: 'https://example.test/repository',
        homepage: 'https://example.test/homepage',
        resolved: 'https://example.test/resolved.tgz',
      },
      'node_modules/with-homepage': {
        version: '1.0.0', license: 'MIT', optional: true,
        homepage: 'https://example.test/homepage',
        resolved: 'https://example.test/resolved.tgz',
      },
      'node_modules/with-resolved': {
        version: '1.0.0', license: 'MIT', optional: true,
        resolved: 'https://example.test/resolved.tgz',
      },
    } })

    assert.deepEqual(packages.map(({ name, source }) => ({ name, source })), [
      { name: 'with-repository', source: 'https://example.test/repository' },
      { name: 'with-homepage', source: 'https://example.test/homepage' },
      { name: 'with-resolved', source: 'https://example.test/resolved.tgz' },
    ])
  })
})

test('missing and stale notice files fail while a byte-identical notice passes', async () => {
  await withProject(async (projectRoot) => {
    const noticesPath = join(projectRoot, 'THIRD_PARTY_NOTICES.md')
    assert.deepEqual(await checkNoticeFile(noticesPath, 'expected', 0), [
      'THIRD_PARTY_NOTICES.md is missing. Run npm run generate:third-party-notices.',
    ])

    await writeFile(noticesPath, 'stale', 'utf8')
    assert.deepEqual(await checkNoticeFile(noticesPath, 'expected', 0), [
      'THIRD_PARTY_NOTICES.md is stale. Run npm run generate:third-party-notices and review the result.',
    ])

    await writeFile(noticesPath, 'expected', 'utf8')
    assert.deepEqual(await checkNoticeFile(noticesPath, 'expected', 0), [])
  })
})

test('output ordering and duplicate handling remain stable', () => {
  const source = [
    { name: 'zeta', version: '1.0.0', license: 'MIT', source: 'first' },
    { name: 'alpha', version: '2.0.0', license: 'MIT', source: 'alpha-two' },
    { name: 'alpha', version: '1.0.0', license: 'MIT', source: 'alpha-one' },
    { name: 'zeta', version: '1.0.0', license: 'MIT', source: 'duplicate' },
  ]

  assert.deepEqual(uniqueSorted(source), [source[2], source[1], source[3]])
})

test('malformed manifests and missing non-optional manifests fail closed', async () => {
  await withProject(async (projectRoot) => {
    const relativePath = 'node_modules/malformed'
    const directory = join(projectRoot, relativePath)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), '{not-json', 'utf8')

    await assert.rejects(
      collectJavaScriptPackages(projectRoot, { packages: {
        [relativePath]: { version: '1.0.0', license: 'MIT' },
      } }),
      /Unable to read dependency metadata/,
    )
    await assert.rejects(
      collectJavaScriptPackages(projectRoot, { packages: {
        'node_modules/missing': { version: '1.0.0', license: 'MIT' },
      } }),
      /Unable to read dependency metadata/,
    )
  })
})

test('invalid lockfile package metadata fails closed', async () => {
  await withProject(async (projectRoot) => {
    await assert.rejects(
      collectJavaScriptPackages(projectRoot, { packages: null }),
      /valid packages object/,
    )
    await assert.rejects(
      collectJavaScriptPackages(projectRoot, { packages: {
        'node_modules/example': null,
      } }),
      /Invalid lockfile metadata/,
    )
  })
})
