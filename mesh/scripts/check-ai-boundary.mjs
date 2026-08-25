#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeAiBoundary,
  formatAiBoundaryViolations,
} from './check-ai-boundary-lib.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')
const violations = analyzeAiBoundary(projectRoot)

if (violations.length > 0) {
  console.error('On-device AI boundary violations:')
  console.error(formatAiBoundaryViolations(violations))
  process.exitCode = 1
} else {
  console.log('On-device AI boundary check passed.')
}
