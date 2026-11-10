// Runs a snippet of code or a shell command and captures its output.
// Only a capped digest of that output is ever returned to the model; the caller
// indexes the full text and prints a short header.
//
// Two capture modes: pipes (normal) and temporary files (fallback). The file
// mode exists because some sandboxes refuse to hand a child a pipe; retrying
// with file handles keeps ctx_execute working there.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WIN = process.platform === 'win32'
const HARD_CAP = 16 * 1024 * 1024

export const LANGUAGES = WIN
  ? ['powershell', 'cmd', 'node', 'python', 'bash']
  : ['bash', 'sh', 'node', 'python3', 'python']

let defaultDir = ''

export function setDefaultWorkdir(dir) {
  try {
    if (typeof dir === 'string' && dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) defaultDir = dir
  } catch {
    /* ignore */
  }
}

export function getDefaultWorkdir() {
  if (defaultDir) return defaultDir
  try {
    const cwd = process.cwd()
    if (cwd && fs.existsSync(cwd)) return cwd
  } catch {
    /* ignore */
  }
  return os.homedir()
}

function decode(buf) {
  if (!buf.length) return ''
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

function killTree(child) {
  if (!child || !child.pid) return
  try {
    if (WIN) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {
    /* ignore */
  }
}

function commandFor(language, command) {
  const lang = language || (WIN ? 'powershell' : 'bash')
  if (lang === 'powershell') {
    const prefix = '$ProgressPreference = "SilentlyContinue"; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
    return { file: WIN ? 'powershell.exe' : 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', prefix + command] }
  }
  if (lang === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  if (lang === 'bash' || lang === 'sh') return { file: lang, args: ['-c', command] }
  if (lang === 'node') return { file: process.execPath, args: [], useTempFile: 'mjs' }
  if (lang === 'python' || lang === 'python3') return { file: lang, args: [], useTempFile: 'py' }
  throw new Error(`unsupported language: ${lang}`)
}

function attempt({ runner, args, cwd, timeoutMs, mode }) {
  return new Promise((resolve) => {
    let outFd = null
    let errFd = null
    let outPath = ''
    let errPath = ''
    let stdio = ['ignore', 'pipe', 'pipe']
    if (mode === 'files') {
      outPath = path.join(os.tmpdir(), `dsh-ctx-out-${crypto.randomUUID()}.log`)
      errPath = path.join(os.tmpdir(), `dsh-ctx-err-${crypto.randomUUID()}.log`)
      outFd = fs.openSync(outPath, 'w')
      errFd = fs.openSync(errPath, 'w')
      stdio = ['ignore', outFd, errFd]
    }
    let outBytes = 0
    let errBytes = 0
    const outChunks = []
    const errChunks = []
    let timedOut = false
    let settled = false

    const child = spawn(runner.file, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      stdio,
      windowsHide: true,
      detached: !WIN,
    })

    const take = (buf, which) => {
      const capLeft = HARD_CAP - outBytes - errBytes
      if (capLeft <= 0) return
      const slice = buf.length > capLeft ? buf.subarray(0, capLeft) : buf
      if (which === 'out') {
        outChunks.push(slice)
        outBytes += slice.length
      } else {
        errChunks.push(slice)
        errBytes += slice.length
      }
    }
    if (mode === 'pipes') {
      child.stdout?.on('data', (b) => take(b, 'out'))
      child.stderr?.on('data', (b) => take(b, 'err'))
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, Math.max(1000, Math.min(Number(timeoutMs) || 120000, 600000)))
    timer.unref?.()

    const finish = (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (mode === 'files') {
        try {
          if (outFd != null) fs.closeSync(outFd)
          if (errFd != null) fs.closeSync(errFd)
          if (fs.existsSync(outPath)) outChunks.push(fs.readFileSync(outPath).subarray(0, HARD_CAP))
          if (fs.existsSync(errPath)) errChunks.push(fs.readFileSync(errPath).subarray(0, HARD_CAP))
        } catch {
          /* ignore */
        }
        for (const p of [outPath, errPath]) {
          try {
            if (p) fs.unlinkSync(p)
          } catch {
            /* ignore */
          }
        }
      }
      resolve({ code, error, timedOut, out: Buffer.concat(outChunks), err: Buffer.concat(errChunks) })
    }

    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code, null))
  })
}

/**
 * @returns {Promise<{code:number|null, timedOut:boolean, stdout:string, stderr:string,
 *   totalBytes:number, durationMs:number, language:string, workdir:string}>}
 */
export async function runScript({ command, language, workdir, timeoutMs = 120000 }) {
  const text = String(command ?? '')
  if (!text.trim()) throw new Error('command is empty')
  const runner = commandFor(language, text)
  const cwd = path.resolve(workdir || getDefaultWorkdir())
  let stat = null
  try {
    stat = fs.statSync(cwd)
  } catch {
    throw new Error(`workdir does not exist: ${cwd}`)
  }
  if (!stat.isDirectory()) throw new Error(`workdir is not a directory: ${cwd}`)

  let tempFile = ''
  const args = [...runner.args]
  if (runner.useTempFile) {
    tempFile = path.join(os.tmpdir(), `dsh-ctx-${crypto.randomUUID()}.${runner.useTempFile}`)
    fs.writeFileSync(tempFile, text, 'utf8')
    args.push(tempFile)
  }

  const started = Date.now()
  let res = await attempt({ runner, args, cwd, timeoutMs, mode: 'pipes' })
  if (res.error && (res.error.code === 'EPERM' || res.error.code === 'EACCES')) {
    res = await attempt({ runner, args, cwd, timeoutMs, mode: 'files' })
  }
  if (tempFile) {
    try {
      fs.unlinkSync(tempFile)
    } catch {
      /* ignore */
    }
  }
  if (res.error) throw res.error

  const stdout = decode(res.out)
  const stderr = decode(res.err)
  return {
    code: res.code,
    timedOut: res.timedOut || Boolean(res.error),
    stdout,
    stderr,
    totalBytes: res.out.length + res.err.length,
    durationMs: Date.now() - started,
    language: language || (WIN ? 'powershell' : 'bash'),
    workdir: cwd,
  }
}
