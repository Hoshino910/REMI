import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BasicCompactionEngine as Engine } from '@deepseek-ai/dsh-compaction-basic'

/** File-loaded Desktop plugins must use the host's transaction implementation.
 * A workspace's development peers can have a different surfaceOp wire format.
 * Never rewrite session.append or guess replacement positions across versions.
 */
export function resolveHarnessPackageRoot(): string | undefined {
  const explicit = process.env.REMI_DSH_PACKAGE_ROOT
  if (explicit !== undefined) {
    if (!isAbsolute(explicit) || !existsSync(resolve(explicit, 'package.json'))) {
      throw new Error('REMI_DSH_PACKAGE_ROOT must be an absolute Harness package root')
    }
    return explicit
  }
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const resourceRoot = resources ?? resolve(dirname(process.execPath), 'resources')
  // Electron's filesystem/ESM loader can read the virtual app.asar paths.
  // A leftover unpacked directory may belong to an older Desktop release.
  const candidates = [resolve(resourceRoot, 'app.asar'), resolve(resourceRoot, 'app.asar.unpacked')]
  return candidates.find(root => existsSync(resolve(root, 'node_modules/@deepseek-ai/dsh-compaction-basic/package.json')))
}

const root = resolveHarnessPackageRoot()
const hostRequire = root === undefined ? undefined : createRequire(resolve(root, 'package.json'))
const backend = root === undefined
  ? await import('@deepseek-ai/dsh-compaction-basic')
  : await import(pathToFileURL(hostRequire!.resolve('@deepseek-ai/dsh-compaction-basic')).href)
if (typeof backend.BasicCompactionEngine !== 'function') throw new Error('Harness compaction backend is unavailable')
export const BasicCompactionEngine: typeof Engine = backend.BasicCompactionEngine
export const COMPACTION_BACKEND = root === undefined
  ? 'installed-peer'
  : `desktop-host:${hostRequire!('@deepseek-ai/dsh-compaction-basic/package.json').version}`
