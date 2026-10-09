#!/usr/bin/env node
/**
 * 随身 Agent 盘 · 体检与修复
 *
 * 用法:
 *   node tools/doctor.mjs            体检
 *   node tools/doctor.mjs --clean    体检并清理 macOS 的 ._* 边车文件
 *   node tools/doctor.mjs --probe    额外做一次供应商真实探活(会消耗极少量 token)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getSecret } from './secrets.mjs'
import { probe, ensureProvidersConfig } from './launch.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const USB = path.resolve(HERE, '..')

// 干净克隆的第一次运行也要能体检:先把配置从模板补齐
ensureProvidersConfig()
const DATA = path.join(USB, 'data')
const PHOME = path.join(DATA, 'home')

const OS = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const PLAT = `${OS}-${ARCH}`
const IS_WIN = OS === 'win32'

const clean = process.argv.includes('--clean')
const doProbe = process.argv.includes('--probe')

const results = []
function check(name, level, detail, fix) {
  // level: ok | warn | fail | info
  results.push({ name, level, detail, fix })
}
const g = (s) => `\x1b[32m${s}\x1b[0m`
const y = (s) => `\x1b[33m${s}\x1b[0m`
const r = (s) => `\x1b[31m${s}\x1b[0m`
const d = (s) => `\x1b[2m${s}\x1b[0m`

// ── 1. 平台 ──
check('平台识别', 'ok', `${PLAT}  ·  node ${process.version}`)

// ── 2. 盘可写 + 空间 ──
try {
  fs.mkdirSync(path.join(USB, 'tmp'), { recursive: true })
  const t = path.join(USB, 'tmp', '.write-test')
  fs.writeFileSync(t, 'x'); fs.unlinkSync(t)
  const s = fs.statfsSync(USB)
  const freeGB = (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3
  check('盘可写 / 剩余空间', freeGB < 1 ? 'warn' : 'ok', `剩余 ${freeGB.toFixed(1)} GB`,
    freeGB < 1 ? '空间不足,清理 data/logs、data/cache' : null)
} catch (e) {
  check('盘可写', 'fail', e.message, '检查移动盘是否被写保护')
}

// ── 3. 运行时(noexec 探测:真的执行一次) ──
const nodeBin = path.join(USB, 'runtime', 'node', PLAT, 'bin', IS_WIN ? 'node.exe' : 'node')
if (fs.existsSync(nodeBin)) {
  const t0 = Date.now()
  const p = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' })
  if (p.status === 0) check('运行时 node', 'ok', `${p.stdout.trim()}  (${Date.now() - t0}ms)`)
  else check('运行时 node 无法执行', 'fail',
    (p.error && p.error.code) || `退出码 ${p.status}`,
    '若为 EACCES/EPERM,说明该挂载点了 noexec。兜底:把 runtime 拷到本地临时目录再跑')
} else {
  check('运行时 node 缺失', 'fail', `没有 ${path.relative(USB, nodeBin)}`, '跑 tools/build-local.sh 构建后拷入')
}

// ── 4. Claude Code ──
const cc = path.join(USB, 'app', 'claude', 'node_modules', '@anthropic-ai', `claude-code-${PLAT}`, IS_WIN ? 'claude.exe' : 'claude')
if (fs.existsSync(cc)) {
  const p = spawnSync(cc, ['--version'], { encoding: 'utf8' })
  const ver = fs.existsSync(path.join(USB, 'app', 'claude', 'VERSION'))
    ? fs.readFileSync(path.join(USB, 'app', 'claude', 'VERSION'), 'utf8').trim() : '?'
  if (p.status === 0) check('Claude Code', 'ok', `${p.stdout.trim()}  (VERSION 记录 ${ver})`)
  else check('Claude Code 无法执行', 'fail', (p.error && p.error.code) || `退出码 ${p.status}`, '重新构建')
  // 本平台之外还带了哪些平台
  const others = fs.readdirSync(path.join(USB, 'app', 'claude', 'node_modules', '@anthropic-ai'))
    .filter((n) => n.startsWith('claude-code-') && n !== `claude-code-${PLAT}`)
  check('跨平台产物', others.length ? 'ok' : 'warn',
    others.length ? others.map((n) => n.replace('claude-code-', '')).join(', ') : '只有本平台,插到别的系统会跑不起来',
    others.length ? null : 'build-local.sh 里加上目标平台再构建')
} else {
  check('Claude Code 缺失', 'fail', `没有 ${path.relative(USB, cc)}`, '跑 tools/build-local.sh 构建后拷入')
}

// ── 5. 软链接扫描(exFAT 上必须为 0) ──
function collectSymlinks(dir) {
  const out = []
  const walk = (p) => {
    let ents = []
    try { ents = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const full = path.join(p, e.name)
      try { if (fs.lstatSync(full).isSymbolicLink()) { out.push(full); continue } } catch { continue }
      if (e.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return out
}
try {
  const links = ['app', 'runtime', 'data'].flatMap((d) => collectSymlinks(path.join(USB, d)))
  if (links.length === 0) {
    check('软链接扫描', 'ok', '0 个(exFAT 要求)')
  } else if (clean) {
    let n = 0
    for (const l of links) { try { fs.unlinkSync(l); n++ } catch {} }
    check('软链接扫描', 'ok', `已清除 ${n} 个 —— 多为 Claude Code 自建的 macOS URL 处理程序`)
  } else {
    check('软链接扫描', 'fail', `${links.length} 个 —— 跨到 Windows/Linux 会全部失效`,
      'node tools/doctor.mjs --clean 清除(盘上本不该有任何软链接)')
  }
} catch (e) { check('软链接扫描', 'warn', e.message) }

// ── 6. Home 重定向验证 ──
const probeFile = path.join(PHOME, '.doctor-write-test')
try {
  fs.mkdirSync(PHOME, { recursive: true })
  fs.writeFileSync(probeFile, 'x'); fs.unlinkSync(probeFile)
  check('配置目录在盘上', 'ok', path.relative(USB, PHOME))
} catch (e) {
  check('配置目录不可写', 'fail', e.message, '检查盘权限')
}

// ── 7. 宿主机污染 ──
const realHome = os.userInfo().homedir
const hostClaude = path.join(realHome, '.claude')
const hostJson = path.join(realHome, '.claude.json')
const polluted = fs.existsSync(hostClaude) || fs.existsSync(hostJson)
check('宿主机污染', polluted ? 'warn' : 'ok',
  polluted
    ? `宿主 ${realHome} 下存在 .claude / .claude.json(可能是你系统里其它工具留下的)`
    : `宿主 ${realHome} 干净,没有 .claude / .claude.json`,
  polluted ? '若确认是本盘造成:关掉启动器后手动删除宿主这两个路径' : null)

// ── 8. 密钥库 ──
const vault = path.join(DATA, 'config', 'secrets.json')
const passfile = path.join(DATA, 'config', 'passphrase')
if (fs.existsSync(vault)) {
  const v = JSON.parse(fs.readFileSync(vault, 'utf8'))
  const names = Object.keys(v.entries || {})
  check('密钥库', names.length ? 'ok' : 'warn', names.length ? `已录入:${names.join(', ')}` : '密钥库为空',
    names.length ? null : 'node tools/secrets.mjs set <name>')
  if (fs.existsSync(passfile)) {
    check('口令保护', 'warn', '快捷模式:口令就放在盘上(data/config/passphrase),等同于明文',
      '想更安全:记住口令 → 删除 data/config/passphrase → 以后每次启动会提示输入')
  } else {
    check('口令保护', 'ok', '每次都需输入口令')
  }
  // 实际解密验证
  for (const n of names) {
    const res = await getSecret(n)
    check(`解密 "${n}"`, res.ok ? 'ok' : 'fail', res.ok ? `明文长度 ${res.value.length}` : res.reason,
      res.ok ? null : '重新录入:node tools/secrets.mjs set ' + n)
  }
} else {
  check('密钥库', 'warn', '还没有密钥', 'node tools/secrets.mjs set deepseek')
}

// ── 9. AppleDouble 边车文件 ──
function countAppleDouble(dir) {
  let n = 0
  const walk = (p) => {
    let ents = []
    try { ents = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith('._')) { n++; continue }
      if (e.isDirectory()) walk(path.join(p, e.name))
    }
  }
  walk(dir)
  return n
}
const junk = countAppleDouble(DATA) + countAppleDouble(path.join(USB, 'app'))
if (junk === 0) {
  check('macOS 边车文件', 'ok', '没有 ._* 垃圾文件')
} else if (clean) {
  const wipe = (p) => {
    let ents = []
    try { ents = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const full = path.join(p, e.name)
      try {
        if (e.name.startsWith('._')) { fs.unlinkSync(full); continue }
        if (e.isDirectory()) wipe(full)
      } catch {}
    }
  }
  wipe(DATA); wipe(path.join(USB, 'app'))
  check('macOS 边车文件', 'ok', `已清理 ${junk} 个 ._* 文件`)
} else {
  check('macOS 边车文件', 'warn', `${junk} 个 ._* 文件 —— 拿到 Windows/Linux 上会显示成垃圾文件`,
    'node tools/doctor.mjs --clean 清理(建议搬去别的系统前跑一次)')
}

// ── 10. 真实探活 ──
if (doProbe) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config', 'providers.json'), 'utf8'))
    for (const p of cfg.providers) {
      const sec = p.key_ref ? await getSecret(p.key_ref) : { ok: true, value: null }
      if (!sec.ok) { check(`探活 ${p.id}`, 'warn', `取不到密钥:${sec.reason}`); continue }
      const res = await probe(p, sec.value)
      if (res.ok) check(`探活 ${p.id}`, 'ok', `${res.ms}ms  ·  ${p.model}`)
      else check(`探活 ${p.id}`, 'fail', `[HTTP ${res.status || '-'}] ${res.reason}` + (res.hint ? `  — ${res.hint}` : ''))
    }
  } catch (e) { check('探活', 'fail', e.message) }
}

// ── 输出 ──
const icon = { ok: g('✓'), warn: y('!'), fail: r('✗'), info: d('·') }
console.log('\n' + '\x1b[36m  随身 Agent 盘 · 体检报告\x1b[0m  ' + d(PLAT) + '\n')
for (const x of results) {
  console.log(`  ${icon[x.level]} ${x.name.padEnd(22)} ${d(x.detail || '')}`)
  if (x.fix && x.level !== 'ok') console.log(`    ${y('→')} ${x.fix}`)
}
const bad = results.filter((x) => x.level === 'fail').length
const warn = results.filter((x) => x.level === 'warn').length
console.log(`\n  ${bad ? r(`${bad} 项失败`) : g('无失败项')}  ·  ${warn ? y(`${warn} 项提醒`) : '无提醒'}\n`)
process.exit(bad ? 1 : 0)
