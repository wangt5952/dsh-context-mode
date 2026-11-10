// DSH host plugin: keeps large tool output out of the context window.
//
// Registers the ctx_* tool family and a `tools/post-execute` hook that replaces
// oversized results with a compact digest while indexing the whole text into a
// local, searchable store.

import os from 'node:os'
import path from 'node:path'
import { Store } from './lib/store.js'
import { createTools } from './lib/tools.js'
import { installHook } from './lib/hook.js'
import { setDefaultWorkdir } from './lib/exec.js'

export const inject = ['tools']

const VERSION = '0.1.0'

const DEFAULTS = {
  enabled: true,
  dataDir: '',
  workdir: '',
  externalizeOverBytes: 4096,
  digestBytes: 1200,
  outputCapBytes: 16384,
  maxChunkBytes: 4096,
  maxSources: 4000,
  maxStoreBytes: 64 * 1024 * 1024,
  skipTools: [],
  enableHook: true,
}

function num(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

export function resolveConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const dataDir =
    typeof input.dataDir === 'string' && input.dataDir.trim()
      ? path.resolve(input.dataDir.trim())
      : path.join(os.homedir(), '.dsh-context-mode')
  return {
    version: VERSION,
    enabled: input.enabled !== false,
    dataDir,
    workdir: typeof input.workdir === 'string' ? input.workdir.trim() : '',
    externalizeOverBytes: num(input.externalizeOverBytes, DEFAULTS.externalizeOverBytes, 512, 1024 * 1024),
    digestBytes: num(input.digestBytes, DEFAULTS.digestBytes, 200, 8192),
    outputCapBytes: num(input.outputCapBytes, DEFAULTS.outputCapBytes, 512, 65536),
    maxChunkBytes: num(input.maxChunkBytes, DEFAULTS.maxChunkBytes, 512, 32768),
    maxSources: num(input.maxSources, DEFAULTS.maxSources, 1, 100000),
    maxStoreBytes: num(input.maxStoreBytes, DEFAULTS.maxStoreBytes, 1024 * 1024, 8 * 1024 * 1024 * 1024),
    skipTools: Array.isArray(input.skipTools) ? input.skipTools.map(String) : [],
    enableHook: input.enableHook !== false,
  }
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return

  const store = new Store(cfg.dataDir, {
    maxSources: cfg.maxSources,
    maxBytes: cfg.maxStoreBytes,
    maxChunkBytes: cfg.maxChunkBytes,
  })
  if (cfg.workdir) setDefaultWorkdir(cfg.workdir)

  ctx.effect(() => {
    const disposers = []
    const definitions = createTools({ store, cfg })
    for (const definition of definitions) {
      try {
        disposers.push(ctx.tools.register(definition))
      } catch (err) {
        // a failing tool must not take the whole plugin down
        ctx.logger?.warn?.(`[context-mode] failed to register ${definition.name}: ${err?.message ?? err}`)
      }
    }
    if (cfg.enableHook) {
      try {
        disposers.push(installHook({ ctx, cfg, store }))
      } catch (err) {
        ctx.logger?.warn?.(`[context-mode] failed to install post-execute hook: ${err?.message ?? err}`)
      }
    }
    // The hook also learns a sensible default working directory from tools
    // that name one; nothing else is registered here.
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
      try {
        store.close?.()
      } catch {
        /* ignore */
      }
    }
  })
}
