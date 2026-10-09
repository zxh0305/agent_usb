#!/usr/bin/env node
/**
 * 随身 Agent 盘 · 交互面板(TUI)
 *
 * 零依赖:只用 Node 内置模块 + ANSI 转义序列。
 * 之所以不用 blessed / ink 之类的库:那样会在盘上产生 node_modules,
 * 而 exFAT 不支持软链接,npm 装不上。零依赖是最稳的路。
 *
 * 直接用:node tools/tui.mjs
 * 单帧渲染(调试布局用):node tools/tui.mjs --render-only [宽] [高]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  USB, DATA, PHOME, PLAT, IS_WIN,
  claudeBinary, buildEnv, probe, loadProviders, freeSpace, C,
  authHeaders, normalizeBaseUrl,
  resolveWorkdir, readDaemon, writeDaemon, expandHome,
  loadAgents, saveAgents, prepareAgent, purgeStaleAichatConfig, appName,
  syncSkills, applyMcp, listSkills,
} from './launch.mjs'
import {
  getSecret, setSecretEntry, removeSecretEntry, listSecretNames, hasPassfile,
} from './secrets.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROVIDERS_FILE = path.join(DATA, 'config', 'providers.json')
const RENDER_ONLY = process.argv.includes('--render-only')   // 单帧预览模式:render() 应为空操作

// ───────────────────────── 终端原语 ─────────────────────────
const OUT = process.stdout
const IN = process.stdin
const w = (s) => OUT.write(s)

let rawOn = false
let inScreen = false
const state = {
  screen: 'main',
  cursor: 0,
  pCursor: 0,
  kCursor: 0,
  message: null,          // { t, lv }
  scroll: 0,
  doctorOut: null,
  probing: false,
  models: null,           // 模型选择界面:{ providerId, list, url, cursor }
  workdir: null,          // { dir, src } 这次会话在哪工作
  agents: null,           // agent 注册表(loadAgents 读出)
  appName: null,          // 面板显示的名字(默认 REMON,可被 daemon.json 的 title 覆盖)
  inputLock: false,       // 正在用 readline 提问时,忽略自己的按键处理
  active: false,
  cfg: null,
}

function enterScreen() {
  if (!inScreen) w('\x1b[?1049h')      // 进入备用屏幕缓冲
  w('\x1b[?25l\x1b[2J')                // 隐藏光标 + 清屏
  inScreen = true
  if (IN.isTTY && !rawOn) { try { IN.setRawMode(true); rawOn = true } catch {} }
  IN.resume()
  state.active = true
}
function exitScreen() {
  state.active = false
  if (!inScreen) return                 // 幂等:可被 exit/信号处理器重复调用
  if (rawOn && IN.isTTY) { try { IN.setRawMode(false) } catch {} }
  rawOn = false
  try { IN.pause() } catch {}
  w('\x1b[?25h\x1b[?1049l')             // 显示光标 + 回到主屏幕缓冲
  inScreen = false
}

// ★ 关键:无论怎么退出都必须恢复终端。
//   漏了这些,进程被信号杀掉时会把终端留在 raw 模式,导致外层脚本的
//   `read` 不阻塞、shell 直接退出,看起来就像"卡在面板上"。
process.on('exit', () => { try { exitScreen() } catch {} })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { exitScreen() } catch {} ; process.exit(0) })
}
process.on('uncaughtException', (e) => {
  try { exitScreen() } catch {}
  console.error('\n面板异常退出:', e && e.message ? e.message : e)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  try { exitScreen() } catch {}
  console.error('\n面板异常退出(未处理的 Promise):', e && e.message ? e.message : e)
  process.exit(1)
})

// ───────────────────────── 排版工具 ─────────────────────────
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

/**
 * 单个码点的显示宽度。
 *
 * ★ 这里是排版的地基,踩过一次大坑:最初用"码点个数"当可见宽度,
 *   但中日韩文字是**双宽**字符 —— 算 1 列、终端实际占 2 列。
 *   于是每行都比以为的宽,超出终端宽度就自动折行,多出来的行把面板顶乱
 *   (顶部边框被挤出屏幕、右边框出现在奇怪的位置)。而当时的"宽度自检"
 *   用的是同一个错误算法,所以一直是"通过"的。
 *
 *   制表符/方块/几何图形(─│┌█░●▸)在东亚宽度里属 Ambiguous,
 *   本终端实测按 1 列渲染,因此这里也按 1 计。
 */
function dwidth(cp) {
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x200b || (cp >= 0x200e && cp <= 0x200f) || cp === 0xfeff) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||   // 韩文字母
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK 部首 ~ CJK 标点
    (cp >= 0x3041 && cp <= 0x33ff) ||   // 假名 ~ CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK 基本区
    (cp >= 0xa000 && cp <= 0xa4cf) ||   // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK 兼容表意
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||   // 全角
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK 扩展 B+
  ) return 2
  return 1
}

const vlen = (s) => {
  let n = 0
  for (const ch of stripAnsi(s)) n += dwidth(ch.codePointAt(0))
  return n
}
const padE = (s, n) => s + ' '.repeat(Math.max(0, n - vlen(s)))
const padS = (s, n) => ' '.repeat(Math.max(0, n - vlen(s))) + s

/** 按显示宽度截断,保留 ANSI 颜色(截断时补重置,避免颜色外溢) */
function trunc(s, n) {
  let out = '', w = 0, i = 0
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*[A-Za-z]/.exec(s.slice(i))
      if (m) { out += m[0]; i += m[0].length; continue }
    }
    const cp = s.codePointAt(i)
    const cw = dwidth(cp)
    if (w + cw > n) return out + '\x1b[0m'
    out += String.fromCodePoint(cp)
    w += cw
    i += cp > 0xffff ? 2 : 1
  }
  return out
}
const cut = trunc   // 同名保留,便于阅读

/** 把家目录缩写显示,省地方 */
const shortenHome = (p) => {
  if (!p) return ''
  const h = os.homedir()
  return p.startsWith(h) ? '~' + p.slice(h.length) : p
}
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const sel = (s) => `\x1b[1;36m${s}\x1b[0m`

// ───────────────────────── 点阵字模 ─────────────────────────
// 自己画 5×6 点阵,而不是抄网上的艺术字 —— 抄来的容易错位。
const FONT = {
  C: ['██████', '██    ', '██    ', '██    ', '██████'],
  L: ['██    ', '██    ', '██    ', '██    ', '██████'],
  A: ['██████', '██  ██', '██████', '██  ██', '██  ██'],
  U: ['██  ██', '██  ██', '██  ██', '██  ██', '██████'],
  D: ['█████ ', '██  ██', '██  ██', '██  ██', '█████ '],
  E: ['██████', '██    ', '████  ', '██    ', '██████'],
  R: ['█████ ', '██  ██', '█████ ', '██ ██ ', '██  ██'],
  M: ['██  ██', '██████', '██  ██', '██  ██', '██  ██'],
  O: ['██████', '██  ██', '██  ██', '██  ██', '██████'],
  N: ['██  ██', '███ ██', '██ ███', '██  ██', '██  ██'],
}
function bigText(str) {
  const rows = ['', '', '', '', '']
  for (const ch of str.toUpperCase()) {
    const g = FONT[ch]
    if (!g) { for (let i = 0; i < 5; i++) rows[i] += '  '; continue }   // 没有的字模留空,不至于崩
    for (let i = 0; i < 5; i++) rows[i] += g[i] + ' '
  }
  return rows.map((r) => r.replace(/\s+$/, ''))
}

const CUBE = [
  '   ░░░░░░░░   ',
  ' ░░████████░░ ',
  '░░██▒▒▒▒▒▒██░░',
  '░░██▒▒▒▒▒▒██░░',
  ' ░░████████░░ ',
]

// ───────────────────────── 状态采集 ─────────────────────────
function ccVersion() {
  try { return fs.readFileSync(path.join(USB, 'app', 'claude', 'VERSION'), 'utf8').trim() }
  catch { return '未安装' }
}
function hostOS() {
  return osVersion()
}

/**
 * 宿主系统的**产品版本**。
 *
 * ⚠ 不能用 os.release():在 macOS 上它是 Darwin **内核**版本(如 25.5.0),
 * 而 macOS 产品版本是另一回事(如 26.5.1)。曾经把内核版本当成系统版本显示,
 * 被用户一眼看出来不对。os.version() 给的也是内核字符串,同样不行。
 */
let _osVer = null
function osVersion() {
  if (_osVer) return _osVer
  const p = os.platform()
  if (p === 'darwin') {
    try {
      const r = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' })
      if (r.status === 0 && r.stdout.trim()) return (_osVer = `macOS ${r.stdout.trim()}`)
    } catch {}
    _osVer = `macOS(内核 ${os.release()})`
  } else if (p === 'win32') {
    _osVer = os.version() || `Windows ${os.release()}`
  } else if (p === 'linux') {
    try {
      const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8'))
      if (m) return (_osVer = m[1])
    } catch {}
    _osVer = `Linux ${os.release()}`
  } else {
    _osVer = `${p} ${os.release()}`
  }
  return _osVer
}

/** 当前代码对应的提交(比手写的版本号可靠) */
let _git = null
function gitInfo() {
  if (_git) return _git
  try {
    const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: USB, encoding: 'utf8' })
    if (sha.status === 0 && sha.stdout.trim()) {
      const d = spawnSync('git', ['log', '-1', '--format=%cd', '--date=short'], { cwd: USB, encoding: 'utf8' })
      return (_git = { sha: sha.stdout.trim(), date: d.status === 0 ? d.stdout.trim() : '' })
    }
  } catch {}
  return (_git = { sha: '', date: '' })
}
function memInfo() {
  const t = os.totalmem() / 1024 ** 3
  return `${t.toFixed(0)} GB`
}
function currentProvider() {
  const cfg = state.cfg
  return cfg.providers.find((p) => p.id === cfg.current) || cfg.providers[0]
}
function keyNames() {
  try { return listSecretNames() } catch { return [] }
}
function saveProviders(cfg) {
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(cfg, null, 2) + '\n')
}

// ───────────────────── 第三方接口:自己配 URL / 密钥 / 拉模型 ─────────────────────
const PASSWORD_FILE = path.join(DATA, 'config', 'passphrase')

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)

const fmtCtx = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` : `${Math.round(n / 1000)}K`)

/**
 * base_url → 若干候选的"列模型"地址,挨个试。
 *
 * 实测(DeepSeek):Anthropic 兼容路径下**没有**列模型的接口
 * (`/anthropic/models` 与 `/anthropic/v1/models` 都是 404),
 * 但同一域名的根路径可以(`/v1/models`、`/models` 返回 200)。
 * 各家实现不一,所以这里同时试 base_url 本身和它的 origin。
 */
function modelsUrlCandidates(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '')
  let origin = ''
  try { const u = new URL(b); origin = `${u.protocol}//${u.host}` } catch {}
  const out = []
  if (b) {
    out.push(`${b}/models`)
    if (!/\/v\d+$/.test(b)) out.push(`${b}/v1/models`)
  }
  if (origin && origin !== b) {
    out.push(`${origin}/v1/models`)
    out.push(`${origin}/models`)
  }
  return [...new Set(out)]
}

/** 拉模型列表 → { ok, list:[{id,label,context}], url } 或 { ok:false, reason } */
async function fetchModels(provider, secret) {
  const headers = { 'anthropic-version': '2023-06-01' }
  if (secret) headers.authorization = `Bearer ${secret}`
  let lastReason = '没有可用的列模型地址(需要该接口支持 /models)'
  for (const url of modelsUrlCandidates(provider.base_url)) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
      if (!r.ok) { lastReason = `${url} → HTTP ${r.status}`; continue }
      const j = await r.json()
      // Anthropic 与 OpenAI 两种返回都是 { data: [...] },个别是 { models: [...] }
      const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null
      if (!arr || !arr.length) { lastReason = `${url} → 返回里没有模型列表`; continue }
      const list = arr
        .map((m) => (typeof m === 'string'
          ? { id: m, label: '', context: null }
          : {
              id: m.id || m.name || m.model,
              label: m.name || m.display_name || m.description || '',
              context: m.context_window || m.context_length || m.max_context_tokens || null,
            }))
        .filter((m) => m.id)
      if (list.length) return { ok: true, list, url }
      lastReason = `${url} → 列表为空`
    } catch (e) {
      lastReason = `${url} → ${e && e.message ? e.message : e}`
    }
  }
  return { ok: false, reason: lastReason }
}

/** 取密钥库口令;若还没设过,则询问并落盘(快捷模式) */
async function currentPassphrase() {
  if (hasPassfile()) return fs.readFileSync(PASSWORD_FILE, 'utf8').trim()
  const p = await prompt('设置密钥库口令(用于加密,请记住):', { hidden: true })
  if (!p) return null
  fs.writeFileSync(PASSWORD_FILE, p + '\n', { mode: 0o600 })
  return p
}

// ───────────────────────── 余额查询 ─────────────────────────
// providers.json 里的 balance 字段描述怎么查:
//   { "url": "...", "total": "balance_infos.0.total_balance", "currency": "balance_infos.0.currency" }
// 各家接口不一样,所以做成数据驱动;没配 balance 的供应商显示 "—"。
const balCache = new Map()   // providerId -> { at, text, ok }
const BAL_TTL = 60 * 1000

const pickPath = (obj, pathStr) =>
  pathStr.split('.').reduce((a, k) => (a == null ? a : a[k]), obj)

function balanceText(p) {
  if (!p.balance) return dim('—')
  const c = balCache.get(p.id)
  if (!c) return dim('查询中…')
  if (!c.ok) return yellow('查询失败')
  return green(c.text)
}

async function ensureBalance(force = false) {
  const p = currentProvider()
  if (!p.balance) return
  const c = balCache.get(p.id)
  if (!force && c && Date.now() - c.at < BAL_TTL) return
  balCache.set(p.id, { at: Date.now(), text: '查询中…', ok: true })
  render()
  let secret = null
  if (p.key_ref) {
    const r = await getSecret(p.key_ref)
    if (r.ok) secret = r.value
  }
  try {
    const r = await fetch(p.balance.url, { headers: authHeaders(p, secret) })
    const j = await r.json()
    const total = pickPath(j, p.balance.total)
    const cur = p.balance.currency ? pickPath(j, p.balance.currency) : ''
    const sym = { CNY: '¥', USD: '$' }[cur] || (cur ? cur + ' ' : '')
    balCache.set(p.id, { at: Date.now(), text: `${sym}${total}`, ok: r.ok && total != null })
  } catch {
    balCache.set(p.id, { at: Date.now(), text: '查询失败', ok: false })
  }
  render()
}

// ───────────────────────── 各屏内容 ─────────────────────────
function innerWidth(W) { return W - 4 }

/** 主屏:返回恰好 IH 行。空间不够时逐级降级 logo,但绝不丢菜单项 */
/** 当前供应商的余额(纯文本,拿不到就是空 —— 菜单里不显示"查询中"这种噪音) */
function balancePlain(p) {
  if (!p || !p.balance) return ''
  const c = balCache.get(p.id)
  return c && c.ok ? c.text : ''
}

/**
 * 主菜单的**单一数据来源**。
 * 分成两组:上面是 agent(干什么活),下面是配置(怎么配)。
 * bodyMain / doMain / handleKey 都从它取,避免三处各写一份不一致。
 */
function mainItems() {
  const p = currentProvider()
  const keys = keyNames()
  return [
    ...(state.agents || []).map((a) => ({
      id: 'agent:' + a.id, name: a.name, right: a.desc || '', agent: a,
    })),
    { id: 'providers', name: '供应商与模型', right: `${cut(p.name, 20)} · ${p.model || '(未选模型)'}` },
    { id: 'workdir', name: '工作目录', right: shortenHome(state.workdir?.dir || '') },
    { id: 'keys', name: '密钥管理', right: `${keys.length} 个已录入` },
    { id: 'doctor', name: '体检与修复', right: '运行时 · 二进制 · 网络 · 密钥' },
    { id: 'about', name: '关于 / 版本', right: '' },
  ]
}

/**
 * 主屏。分区 + 固定列宽对齐。
 * 之前是 7 项平铺 + 5 行密集状态,没有分组、每个菜单项的值都甩到最右边,
 * 看着很散。现在:上面 logo 与状态并排,下面按 AGENT / 配置 分组,
 * 每行「序号 → 名称 → 说明」对齐成固定列。
 */
function bodyMain(IW, IH) {
  const p = currentProvider()
  const items = mainItems()
  const agentCount = (state.agents || []).length
  const numW = 4
  const nameW = 18

  const rowOf = (i, it) => {
    const on = i === state.cursor
    const num = `[${i + 1}]`
    const left = `${on ? sel('▸') : ' '} ${on ? sel(padE(num, numW)) : dim(padE(num, numW))} ` +
      `${on ? sel(padE(cut(it.name, nameW), nameW)) : padE(cut(it.name, nameW), nameW)}`
    if (!it.right) return cut(left, IW)
    const room = IW - vlen(left) - 2
    return room > 6 ? `${left}  ${dim(cut(it.right, room))}` : cut(left, IW)
  }
  const section = (label) => {
    const t = `── ${label} `
    return dim(t + '─'.repeat(Math.max(0, IW - vlen(t))))
  }

  const menuRows = []
  items.forEach((it, i) => {
    if (i === 0) menuRows.push(section('AGENT'))
    if (i === agentCount) menuRows.push(section('配置'))
    menuRows.push(rowOf(i, it))
  })

  // 右侧状态栏:和 logo 并排
  const status = [
    ['宿主', osVersion()],
    ['平台', PLAT || '?'],
    ['内存', memInfo()],
    ['盘剩余', freeSpace()],
    ['余额', balancePlain(p) || '—'],
    ['运行时', `node ${process.version}`],
  ].map(([k, v]) => `${dim(padE(k, 8))} ${v}`)

  const big = bigText(state.appName || 'REMON')
  const bigW = Math.max(...big.map(vlen))
  const hb = IH - menuRows.length - 3          // 空行 + 分隔线 + 页脚
  let header = []
  if (hb >= 6 && bigW + 30 <= IW) {
    const rows = Math.min(Math.max(big.length, status.length), hb)
    for (let i = 0; i < rows; i++) header.push(padE(big[i] ? cyan(big[i]) : '', bigW + 3) + (status[i] || ''))
  } else if (hb >= 2) {
    const sp = (state.appName || 'REMON').split('').join(' ')
    header = [`${bold(cyan(sp))}  ${dim('随身 Agent 盘')}   ${status[0] || ''}`]
  }

  // 多余行分一半放在状态与菜单之间、一半放在菜单与底栏之间,免得中间一个空洞
  const blanks = Math.max(0, IH - (header.length + menuRows.length + 3))
  const top = Math.ceil(blanks / 2)
  return [
    ...header,
    ...Array(top).fill(''),
    ...menuRows,
    ...Array(blanks - top).fill(''),
    dim('─'.repeat(IW)),
    footer(IW),
  ].slice(0, IH)
}

/** 供应商屏 */
function bodyProviders(IW) {
  const out = []
  out.push(dim(`${state.cfg.providers.length} 个供应商 · 密钥存于 data/config/secrets.json`))
  out.push('')
  const keys = keyNames()
  state.cfg.providers.forEach((p, i) => {
    const on = i === state.pCursor
    const isCur = p.id === state.cfg.current
    const hasKey = p.key_ref ? keys.includes(p.key_ref) : true
    const mark = isCur ? green('●') : ' '
    const idW = 16, nameW = 16, keyW = 8, verW = 7
    // 前缀是:选择标记(1) + 空格 + 当前标记(1) + 空格 = 4 个可见字符
    const fixed = 4 + idW + 1 + nameW + 1 + keyW + 1 + verW + 1
    const modelW = Math.max(8, IW - fixed)
    const name = padE(trunc(p.name, nameW), nameW)
    const keyCol = p.key_ref ? (hasKey ? green('密钥✓') : red('密钥✗')) : dim('无需')
    const ver = p.verified ? green('实测') : p.custom ? cyan('自建') : yellow('未验证')
    const modelTxt = p.model || '(未选模型 · 按 M)'
    const line = `${on ? sel('▸') : ' '} ${mark} ${on ? sel(padE(p.id, idW)) : padE(p.id, idW)} ${name} ${padE(keyCol, keyW)} ${padE(ver, verW)} ${dim(trunc(modelTxt, modelW))}`
    out.push(line)
  })
  out.push('')
  const cur = state.cfg.providers[state.pCursor]
  if (cur) {
    out.push(dim('─'.repeat(IW)))
    out.push(`  ${dim('端点')}  ${cut(cur.base_url, IW - 8)}`)
    out.push(`  ${dim('主模型')} ${cur.model || '(未选)'}    ${dim('小模型')} ${cur.haiku_model || cur.model || '(未选)'}`)
    out.push(`  ${dim('模型列表')} ${Array.isArray(cur.models) && cur.models.length
      ? cur.models.length + ' 个 · 按 m 直接选'
      : dim('未记录 · 按 n 手填一个,之后就会被记住')}`)
    out.push(`  ${dim('鉴权')}   ${cur.auth === 'x-api-key' ? 'x-api-key 头' : 'Authorization: Bearer'}   ${dim('(按 x 切换)')}    ${dim('请求路径')} ${cut(`${cur.base_url}/v1/messages`, Math.max(10, IW - 46))}`)
    if (cur.note) out.push(`  ${yellow('注意')}  ${cut(cur.note, IW - 8)}`)
    if (cur.doc) out.push(`  ${dim('文档')}  ${dim(cut(cur.doc, IW - 8))}`)
  }
  return out
}

/** 密钥屏 */
function bodyKeys(IW) {
  const out = []
  out.push('')
  const keys = keyNames()
  const rows = state.cfg.providers.filter((p) => p.key_ref)
  rows.forEach((p, i) => {
    const on = i === state.kCursor
    const has = keys.includes(p.key_ref)
    const line = `${on ? sel('▸') : ' '} ${on ? sel(padE(p.id, 16)) : padE(p.id, 16)} ${padE(cut(p.name, 18), 18)} ${has ? green('● 已录入') : dim('○ 未录入')}`
    out.push(line)
  })
  out.push('')
  out.push(dim('─'.repeat(IW)))
  out.push(`  ${dim('存储')}   ${dim(cut(path.join('data/config', 'secrets.json'), IW - 22))}   ${dim('AES-256-GCM')}`)
  out.push(`  ${dim('口令')}   ${hasPassfile() ? yellow('快捷模式 —— 口令就放在盘上,等同于明文') : green('每次启动需输入口令')}`)
  out.push(`  ${dim('')}     ${dim(hasPassfile() ? '想更安全:记住口令后删除 data/config/passphrase' : '')}`)
  return out
}

/** 模型选择屏。第 0 行固定是"手动输入模型名" ——
 *  很多第三方网关(如自建中转)并不提供列模型接口,只能手填,
 *  这和某些客户端里的"+ 添加模型"是一个意思。 */
function bodyModels(IW, IH) {
  const M = state.models
  const out = []
  if (!M) return out
  const p = state.cfg.providers.find((x) => x.id === M.providerId)
  out.push(dim(`接口     ${cut(p ? p.base_url : '', IW - 10)}`))
  out.push(dim(`列表来源 ${M.url ? cut(M.url, IW - 10) : '(该接口不提供模型列表,请手填)'}`))
  out.push('')

  const ctxW = 6
  const idW = Math.max(18, Math.min(38, Math.floor(IW * 0.42)))
  const labW = Math.max(6, IW - idW - ctxW - 6)
  const view = Math.max(3, IH - 7)
  const list = M.list
  const total = list.length + 1          // +1 是手动输入那一行
  const top = Math.max(0, Math.min(M.cursor - Math.floor(view / 2), total - view))
  for (let i = top; i < Math.min(total, top + view); i++) {
    const on = i === M.cursor
    if (i === 0) {
      const label = '✎ 手动输入模型名'
      out.push(`${on ? sel('▸') : ' '}   ${on ? sel(padE(label, IW - 8)) : dim(padE(label, IW - 8))}`)
      continue
    }
    const m = list[i - 1]
    const isCur = p && p.model === m.id
    out.push(
      `${on ? sel('▸') : ' '} ${isCur ? green('●') : ' '} ` +
      `${on ? sel(padE(cut(m.id, idW), idW)) : padE(cut(m.id, idW), idW)} ` +
      `${padE(dim(cut(m.label, labW)), labW)} ` +
      `${padS(m.context ? dim(fmtCtx(m.context)) : '', ctxW)}`
    )
  }
  if (total > view) {
    out.push(dim(`  … 共 ${list.length} 个模型,当前 ${top + 1}-${Math.min(top + view, total)}`))
  }
  return out
}

/** 关于屏 */
function bodyAbout(IW) {
  const out = []
  out.push(...bigText(state.appName || 'REMON').map((l) => cyan(l)))
  out.push('')
  out.push(`${dim('P O R T A B L E   A S S I S T A N T')}`)
  out.push('')
  out.push(dim('─'.repeat(IW)))
  const g = gitInfo()
  out.push(`  ${dim('版本')}    随身 Agent 盘${g.sha ? `  ${dim('·')}  提交 ${g.sha}${g.date ? `(${g.date})` : ''}` : ''}`)
  out.push(`  ${dim('平台')}    ${PLAT || '?'}   ${dim('·  宿主')} ${osVersion()}`)
  out.push(`  ${dim('运行时')}  node ${process.version}   ${dim('·')}   claude-code ${ccVersion()}`)
  out.push(`  ${dim('盘根')}    ${cut(USB, IW - 12)}`)
  out.push(`  ${dim('数据')}    ${cut(PHOME, IW - 12)}`)
  out.push('')
  out.push(`  ${dim('跨平台')}  macOS / Windows / Linux ${dim('·  不使用软链接(exFAT 不支持,所以全用普通文件)')}`)
  out.push(`  ${dim('零依赖')}  面板与启动器只用 Node 内置模块,不引入任何第三方库`)
  out.push(`  ${dim('')}        ${dim('(Claude Code 自己的依赖在 app/claude/node_modules,与本项目无关)')}`)
  out.push('')
  out.push(`  ${dim('文档')}    README.md`)
  return out
}

/** 体检屏 */
function bodyDoctor(IW, IH) {
  const out = []
  out.push('')
  if (!state.doctorOut) {
    out.push(dim('  正在运行体检…'))
    return out
  }
  const lines = state.doctorOut.split('\n').filter((l) => l.length)
  const view = IH - 8
  const max = Math.max(0, lines.length - view)
  const s = Math.min(state.scroll, max)
  for (const l of lines.slice(s, s + view)) out.push('  ' + cut(l, IW - 2))
  if (max > 0) out.push(dim(`  … 共 ${lines.length} 行,已显示 ${s + 1}-${Math.min(s + view, lines.length)}`))
  return out
}

// ───────────────────────── 边框与输出 ─────────────────────────
function box(body, W, H, title) {
  const IW = innerWidth(W)
  const lines = []
  lines.push(cyan('┌' + '─'.repeat(W - 2) + '┐'))
  const t = title ? ` ${title} ` : ''
  if (t) {
    // '┌─' + 标题 + 破折号 + '┐' 必须正好等于 W:破折号 = W - 2 - 标题宽 - 1
    lines[0] = cyan('┌─') + dim(t) + cyan('─'.repeat(Math.max(0, W - 3 - vlen(t))) + '┐')
  }
  for (const l of body) lines.push(cyan('│') + ' ' + padE(trunc(l, IW), IW) + ' ' + cyan('│'))
  // 补足高度
  const need = H - 2 - lines.length
  for (let i = 0; i < need; i++) lines.push(cyan('│') + ' '.repeat(IW + 2) + cyan('│'))
  lines.push(cyan('└' + '─'.repeat(W - 2) + '┘'))
  return lines.slice(0, H)
}

/**
 * 每个屏自己的按键提示。
 * 这里统一用小写:大写在终端惯例里意味着"需要按 Shift",而实际上
 * 所有动作键大小写都接受(见 handleKey),写大写会误导人。
 */
const HINTS = {
  main: '↑↓ 选择   Enter 启动/进入   a 加 agent   e 改   x 删   q 退出',
  providers: 'Enter 当前   m 选模型   n 手填   x 鉴权   t 探活   a 新增   e 改   d 删   Esc 返回',
  models: '↑↓ 选择   Enter 使用   i 手动输入   Esc 返回',
  keys: '↑↓ 选择   a 录入   d 删除   Esc 返回',
  doctor: '↑↓ 滚动   r 重跑   Esc 返回',
  about: 'Esc 返回',
}

function footer(IW) {
  const ver = `claude ${ccVersion()}`
  if (state.message) {
    const lv = state.message.lv
    const col = lv === 'ok' ? green : lv === 'fail' ? red : yellow
    return col(' ' + trunc(state.message.t, IW - 2))
  }
  const hint = HINTS[state.screen] || ''
  // 放得下就带版本号;放不下就舍掉版本号,而不是把提示尾部截掉(截掉会看不到 Esc 返回)
  if (vlen(hint) + vlen(ver) + 2 <= IW) return padE(dim(' ' + hint), IW - vlen(ver) - 1) + dim(ver)
  return dim(' ' + trunc(hint, IW - 2))
}

function render() {
  if (RENDER_ONLY) return
  // ★ 正在输入时绝不重绘:否则会把刚显示的输入提示擦掉,
  //   用户看不到任何提示、以为卡死(曾经就是这样)。
  //   注意 render() 会被 resize / ensureBalance 等多处调用,必须在这里统一拦住。
  if (state.inputLock) return
  const { W, H } = size()
  const IW = innerWidth(W)
  // 尺寸变了先整屏清一次:否则新旧尺寸混在一起会留下残影和错位的边框
  if (W !== lastW || H !== lastH) { w('\x1b[2J'); lastW = W; lastH = H }
  if (W < 60 || H < 18) {
    paint([red('终端太小,请放大到至少 60×18')])
    return
  }
  const IH = H - 2
  const title = state.screen === 'main' ? 'P O R T A B L E   A S S I S T A N T'
    : state.screen === 'providers' ? '供应商'
    : state.screen === 'models' ? '选择模型'
    : state.screen === 'keys' ? '密钥'
    : state.screen === 'doctor' ? '体检'
    : '关于'
  let body
  if (state.screen === 'main') {
    body = bodyMain(IW, IH)          // 已经含分隔线与页脚,且正好 IH 行
  } else {
    body = state.screen === 'providers' ? bodyProviders(IW)
      : state.screen === 'models' ? bodyModels(IW, IH)
      : state.screen === 'keys' ? bodyKeys(IW)
      : state.screen === 'doctor' ? bodyDoctor(IW, IH)
      : bodyAbout(IW)
    while (body.length < IH - 2) body.push('')
    body.push(dim('─'.repeat(IW)))
    body.push(footer(IW))
  }
  const lines = box(body, W, H, title)
  paint(lines)
}

let lastW = 0, lastH = 0

function paint(lines) {
  // ★ 最后一行之后不要再写换行:正好铺满整屏时,多余的换行会触发滚动,
  //   把画面整体顶掉一行,再叠加下一次重绘就出现错位残影。
  w('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\n') + '\x1b[0J')
}

function size() {
  // 上限 110:再宽行长就不好读了。窗口明显更宽时先整屏清一次,避免旧尺寸的残影
  const W = Math.max(50, Math.min(OUT.columns || 80, 110))
  const H = Math.max(16, OUT.rows || 24)
  return { W, H }
}

// ───────────────────────── 动作 ─────────────────────────
async function prompt(question, { hidden = false, hint = null } = {}) {
  state.inputLock = true
  const wasRaw = rawOn
  if (rawOn && IN.isTTY) { try { IN.setRawMode(false) } catch {} ; rawOn = false }
  let rl = null
  try {
    // 输入模式独占整个屏幕:清屏 + 明确提示,和面板区分开。
    // 此时 render() 被 inputLock 拦住,不会被面板覆盖。
    OUT.write('\x1b[2J\x1b[H')
    OUT.write(`\n  ${bold(question)}\n`)
    // 提示语必须和实际行为一致:有的输入空回车是"取消",有的是"不修改"、"先留空"。
    // 曾出现过提示写着"回车=取消"、实际却把供应商加进去的情况。
    const hintText = hint || (hidden
      ? '输入内容不回显,粘贴后按回车提交 · 直接回车 = 取消'
      : '直接回车 = 取消')
    OUT.write(`  ${dim(hintText)}\n\n  `)
    rl = readline.createInterface({ input: IN, output: OUT, terminal: true })
    if (hidden) {
      rl._writeToOutput = function (s) { if (s.includes('\n')) OUT.write('\n') }
    }
    const ans = await new Promise((res) => rl.question('', res))
    return ans.trim()
  } finally {
    // 一定要释放:否则 inputLock 卡住会导致面板对所有按键无响应
    try { if (rl) rl.close() } catch {}
    if (wasRaw && IN.isTTY) { try { IN.setRawMode(true) } catch {} ; rawOn = true }
    state.inputLock = false
    // ★ 必须恢复 stdin 的流动模式。readline 关闭时会把 input 暂停,
    //   而本进程**只有 stdin 在维持事件循环** —— 一旦被暂停,事件循环就空了,
    //   Node 会静默退出(表现为"输入完密钥就直接进程已完成、窗口关掉")。
    try { IN.resume() } catch {}
  }
}

/**
 * 启动一个 agent。所有 agent 共用同一套环境重定向与供应商注入,
 * 只是"启动命令"不同(见 launch.mjs 的 agentCommand)。
 */
async function actionLaunchAgent(agent) {
  const p = currentProvider()
  if (!p.model) {
    state.message = { t: `${p.name} 还没选模型 —— 进「供应商与模型」按 m 获取或 n 手填`, lv: 'fail' }
    return
  }
  let secret = null
  if (p.key_ref) {
    const r = await getSecret(p.key_ref)
    if (!r.ok) { state.message = { t: `取不到密钥:${r.reason} —— 进「密钥管理」录入`, lv: 'fail' }; return }
    secret = r.value
  }
  const spec = prepareAgent(agent, { provider: p, secret })
  if (!spec.bin) {
    state.message = { t: `agent「${agent.name}」没有可用的启动命令(检查它的 command 字段)`, lv: 'fail' }
    return
  }
  state.message = null
  exitScreen()                       // 把终端交给它
  const env = buildEnv(p, secret)
  const wd = state.workdir?.dir || path.join(DATA, 'workspace')
  try { fs.mkdirSync(wd, { recursive: true }) } catch {}
  const child = spawn(spec.bin, spec.args, { cwd: wd, env, stdio: 'inherit' })
  // 必须同时监听 error:否则 spawn 失败时 exit 不触发,面板会永久挂起
  let spawnErr = null
  await new Promise((res) => {
    child.on('exit', (code) => res(code ?? 0))
    child.on('error', (e) => { spawnErr = e; res(-1) })
  })
  try { if (spec.cleanup) spec.cleanup() } catch {}   // 收尾:删掉含密钥的临时配置
  enterScreen()
  state.message = spawnErr
    ? { t: `启动失败:${spawnErr.message}`, lv: 'fail' }
    : { t: `${agent.name} 已退出`, lv: 'ok' }
  render()   // 异步动作返回后必须自己重绘:handleKey 里的那次 render 早就跑完了
}

/** a:添加一个自定义 agent(任意命令行) */
async function actionAddAgent() {
  try {
    const name = await prompt('新 agent · 名称:')
    if (!name) { state.message = { t: '已取消', lv: 'warn' }; return }
    const desc = await prompt('新 agent · 一句话说明(会显示在菜单里):', { hint: '直接回车 = 留空' })
    const command = await prompt('新 agent · 命令:', {
      hint: '会在当前工作目录、带着盘上的环境变量执行;例:aichat 或 python3 ~/my_agent.py',
    })
    if (!command) { state.message = { t: '命令为空,已取消', lv: 'warn' }; return }
    const base = slug(name) || 'agent'
    const used = new Set((state.agents || []).map((a) => a.id))
    let id = base, n = 1
    while (used.has(id)) id = `${base}-${++n}`
    state.agents = [...(state.agents || []), { id, name, desc, kind: 'cmd', command, custom: true }]
    saveAgents(state.agents)
    state.cursor = (state.agents.length - 1)
    state.message = { t: `已添加「${name}」`, lv: 'ok' }
  } catch (e) {
    state.message = { t: '添加失败:' + (e && e.message ? e.message : e), lv: 'fail' }
  } finally { render() }
}

/** e:改选中 agent 的名称/说明/命令(内置的也能改说明,但不能改启动方式) */
async function actionEditAgent() {
  const it = mainItems()[state.cursor]
  const a = it && it.agent
  if (!a) { state.message = { t: '请先把光标移到某个 agent 上', lv: 'warn' }; render(); return }
  try {
    const name = await prompt(`新名称(当前 ${a.name}):`, { hint: '直接回车 = 不修改' })
    const desc = await prompt(`新说明(当前 ${a.desc || '无'}):`, { hint: '直接回车 = 不修改' })
    const command = a.kind === 'cmd'
      ? await prompt(`新命令(当前 ${a.command || '无'}):`, { hint: '直接回车 = 不修改' })
      : null
    if (!name && !desc && !command) { state.message = { t: '没有改动', lv: 'warn' }; return }
    const list = (state.agents || []).map((x) => x.id === a.id
      ? { ...x, ...(name ? { name } : {}), ...(desc ? { desc } : {}), ...(command ? { command } : {}) }
      : x)
    state.agents = list
    saveAgents(list)
    state.message = { t: `已更新「${name || a.name}」`, lv: 'ok' }
  } catch (e) {
    state.message = { t: '更新失败:' + (e && e.message ? e.message : e), lv: 'fail' }
  } finally { render() }
}

/** x:删除选中 agent(只允许删自己加的) */
function actionDeleteAgent() {
  const it = mainItems()[state.cursor]
  const a = it && it.agent
  if (!a) { state.message = { t: '请先把光标移到某个 agent 上', lv: 'warn' }; render(); return }
  if (a.builtin) { state.message = { t: `「${a.name}」是内置 agent,不能删;可以按 e 改说明`, lv: 'warn' }; render(); return }
  const list = (state.agents || []).filter((x) => x.id !== a.id)
  state.agents = list
  saveAgents(list)
  state.cursor = Math.max(0, Math.min(state.cursor, list.length - 1))
  state.message = { t: `已删除「${a.name}」`, lv: 'ok' }
  render()
}

async function actionProbe() {
  const p = currentProvider()
  state.probing = true
  state.message = { t: `探活 ${p.name} …`, lv: 'info' }
  render()
  let secret = null
  if (p.key_ref) {
    const r = await getSecret(p.key_ref)
    if (!r.ok) { state.probing = false; state.message = { t: `取不到密钥:${r.reason}`, lv: 'fail' }; render(); return }
    secret = r.value
  }
  const res = await probe(p, secret)
  state.probing = false
  if (res.ok && res.switched) {
    // 探活发现另一种鉴权方式才通 —— 直接记住,免得用户自己猜
    p.auth = res.authUsed
    saveProviders(state.cfg)
  }
  state.message = res.ok
    ? {
        t: res.switched
          ? `连通 ${res.ms}ms —— 该接口需要 ${res.authUsed === 'x-api-key' ? 'x-api-key 头' : 'Bearer 头'},已自动改好并保存`
          : `连通 ${res.ms}ms —— 端点、密钥、模型名都正确  ·  ${p.model}`,
        lv: 'ok',
      }
    : {
        t: `探活失败${res.status ? ' [HTTP ' + res.status + ']' : ''}:${cut(res.reason, 70)}${res.hint ? '  — ' + res.hint : ''}`,
        lv: 'fail',
      }
  render()
}

async function actionSetKey() {
  const rows = state.cfg.providers.filter((p) => p.key_ref)
  const p = rows[state.kCursor]
  if (!p) return
  try {
    let pass = hasPassfile()
      ? fs.readFileSync(path.join(DATA, 'config', 'passphrase'), 'utf8').trim()
      : null
    const created = !pass
    if (!pass) {
      pass = await prompt('设置密钥库口令(用于加密,请记住):', { hidden: true })
      if (!pass) { state.message = { t: '口令为空,已取消', lv: 'fail' }; return }
    }
    const val = await prompt(`粘贴 ${p.name} 的密钥(${p.key_ref}):`, { hidden: true })
    if (!val) { state.message = { t: '已取消,未做改动', lv: 'warn' }; return }
    setSecretEntry(p.key_ref, val, pass)
    // 报出读到的字符数:隐藏输入没有回显,这是用户唯一能核对粘贴是否完整的依据
    const len = [...val].length
    if (created) {
      // 把口令也存到盘上 = 快捷模式。明确告知,不要静默降级。
      fs.writeFileSync(path.join(DATA, 'config', 'passphrase'), pass + '\n', { mode: 0o600 })
      state.message = { t: `${p.key_ref} 已加密写入(读到 ${len} 字符)· 口令已存盘(快捷模式)`, lv: 'warn' }
    } else {
      state.message = { t: `${p.key_ref} 已加密写入(读到 ${len} 字符)`, lv: 'ok' }
    }
  } catch (e) {
    state.message = { t: '写入失败:' + (e && e.message ? e.message : e), lv: 'fail' }
  } finally {
    // 必须用 finally:输入提示会清屏,任何 return 路径(含取消)漏掉重绘
    // 都会把界面留在空白状态,看起来像卡死。
    render()
  }
}

function actionDelKey() {
  const rows = state.cfg.providers.filter((p) => p.key_ref)
  const p = rows[state.kCursor]
  if (!p) return
  try {
    removeSecretEntry(p.key_ref)
    state.message = { t: `已删除 ${p.key_ref}`, lv: 'ok' }
  } catch (e) { state.message = { t: '删除失败:' + e.message, lv: 'fail' } }
  render()
}

function actionSelectProvider() {
  const p = state.cfg.providers[state.pCursor]
  if (!p) return
  state.cfg.current = p.id
  saveProviders(state.cfg)
  state.message = { t: `已切换为 ${p.name}${p.model ? '  ·  ' + p.model : '  ·  (还没选模型)'}`, lv: 'ok' }
  state.screen = 'main'
  state.cursor = 0
  void ensureBalance(true)      // 换了供应商,余额要重新查
}

/** 打开模型选择界面 */
function openModelPicker(p, found) {
  const list = found.list || []
  const idx = list.findIndex((m) => m.id === p.model)
  state.models = { providerId: p.id, list, url: found.url || '', cursor: idx >= 0 ? idx + 1 : 0 }
  state.screen = 'models'
}

/** m:选择模型。优先用"本地记住的列表",没有再联网拉 ——
 *  很多自建网关根本没有列模型接口,联网拉只会白等。 */
async function actionPickModel() {
  const p = state.cfg.providers[state.pCursor]
  if (!p) return
  if (Array.isArray(p.models) && p.models.length) {
    state.message = null
    openModelPicker(p, {
      list: p.models.map((id) => ({ id, label: '', context: null })),
      url: `本地记住的列表(${p.models.length} 个,按 n 可继续添加)`,
    })
    render()
    return
  }
  state.message = { t: `正在从 ${cut(p.base_url, 50)} 获取模型…`, lv: 'info' }
  render()
  let secret = null
  if (p.key_ref) { const r = await getSecret(p.key_ref); if (r.ok) secret = r.value }
  const found = await fetchModels(p, secret)
  if (found.ok) {
    // 拉到的列表也记下来,下次就不必联网了
    p.models = [...new Set([...(p.models || []), ...found.list.map((m) => m.id)])]
    saveProviders(state.cfg)
    state.message = null
    openModelPicker(p, found)
  } else {
    // 不在这里失败:很多自建网关没有列模型接口,手动输入才是主路径
    openModelPicker(p, { list: [], url: '' })
    state.message = { t: `该接口没能列出模型(${cut(found.reason, 40)})—— 选第一项手动输入`, lv: 'warn' }
  }
  render()
}

/** n / 模型屏第一项:手动输入模型名 */
async function actionSetModelManual() {
  const p = state.screen === 'models'
    ? state.cfg.providers.find((x) => x.id === state.models.providerId)
    : state.cfg.providers[state.pCursor]
  if (!p) return
  try {
    const m = await prompt(`${p.name} · 模型名:`, {
      hint: '照客户端里显示的名字原样填(如 GLM-5.3);直接回车 = 取消',
    })
    if (!m) { state.message = { t: '已取消', lv: 'warn' }; return }
    p.model = m
    // 自建接口通常只服务一个模型;四档全指向它,免得后台任务发出不认识的模型名
    p.haiku_model = m
    // 记进本地列表:下次按 m 就能直接选,不用再手打(这些网关大多没有列模型接口)
    p.models = [...new Set([...(p.models || []), m])]
    saveProviders(state.cfg)
    state.message = { t: `${p.id} 的模型已设为 ${m}`, lv: 'ok' }
    if (state.screen === 'models') state.screen = 'providers'
  } catch (e) {
    state.message = { t: '设置失败:' + (e && e.message ? e.message : e), lv: 'fail' }
  } finally {
    render()
  }
}

/** x:切换鉴权方式(Bearer ↔ x-api-key)。有些网关只认其中一种 */
function actionToggleAuth() {
  const p = state.cfg.providers[state.pCursor]
  if (!p) return
  p.auth = p.auth === 'x-api-key' ? 'bearer' : 'x-api-key'
  saveProviders(state.cfg)
  state.message = {
    t: `${p.id} 鉴权改为 ${p.auth === 'x-api-key' ? 'x-api-key 头' : 'Authorization: Bearer'}`,
    lv: 'ok',
  }
  render()
}

/**
 * 设置这次会话的工作目录(会被记住)。
 *
 * 用途:U 盘插到**另一台电脑**上时,通常是要操作那台电脑上的项目,
 * 而不是盘内的 data/workspace。Claude Code 的 `cd` 在会话内不持久,
 * 所以必须在**启动时**把工作目录定对,而不是进去之后再 cd。
 */
async function actionSetWorkdir() {
  const cur = state.workdir?.dir || ''
  try {
    const ans = await prompt('工作目录(绝对路径,支持 ~):', {
      hint: `当前 ${shortenHome(cur)} · 留空 = 取消 · 输入 - = 回到盘内默认`,
    })
    if (!ans) { state.message = { t: '未改动', lv: 'warn' }; return }
    const daemon = readDaemon()
    if (ans === '-') {
      delete daemon.cwd
      writeDaemon(daemon)
      state.workdir = resolveWorkdir()
      state.message = { t: `工作目录已回到盘内默认:${shortenHome(state.workdir.dir)}`, lv: 'ok' }
      return
    }
    const abs = expandHome(ans)
    let ok = false
    try { ok = fs.statSync(abs).isDirectory() } catch {}
    if (!ok) { state.message = { t: `不存在或不是目录:${abs}`, lv: 'fail' }; return }
    daemon.cwd = abs
    writeDaemon(daemon)
    state.workdir = resolveWorkdir()
    state.message = { t: `工作目录已设为 ${shortenHome(abs)}(已记住)`, lv: 'ok' }
  } catch (e) {
    state.message = { t: '设置失败:' + (e && e.message ? e.message : e), lv: 'fail' }
  } finally {
    render()
  }
}

/** 在模型界面回车:第 0 行是手动输入,其余把选中的模型写进配置 */
function actionSelectModel() {
  const M = state.models
  if (!M) return
  if (M.cursor === 0) { actionSetModelManual(); return }
  const p = state.cfg.providers.find((x) => x.id === M.providerId)
  const m = M.list[M.cursor - 1]
  if (!p || !m) return
  p.model = m.id
  // 第三方接口通常只服务一个模型;四个档位全指向它最稳,免得后台任务发出不认识的模型名
  p.haiku_model = m.id
  if (m.context) p.context_tokens = m.context
  saveProviders(state.cfg)
  state.message = {
    t: `已选模型 ${m.id}${m.context ? '  ·  上下文 ' + fmtCtx(m.context) : ''}`,
    lv: 'ok',
  }
  state.screen = 'providers'
  render()
}

/** A:新增一个第三方接口(URL + 密钥),随后立刻拉模型 */
async function actionAddProvider() {
  try {
    const name = await prompt('新接口 · 名称(显示用,随便起):')
    if (!name) { state.message = { t: '已取消', lv: 'warn' }; return }
    const rawUrl = await prompt('新接口 · Base URL:', {
      hint: '需 Anthropic 兼容。填到 /v1 之前为止 —— Claude Code 会自己接 /v1/messages',
    })
    if (!rawUrl) { state.message = { t: '已取消', lv: 'warn' }; return }
    const norm = normalizeBaseUrl(rawUrl)
    const key = await prompt('新接口 · 密钥:', {
      hidden: true,
      hint: '输入不回显 · 留空 = 先不填,之后可在供应商屏按 k 补录',
    })

    const base = slug(name) || 'custom'
    const used = new Set(state.cfg.providers.map((x) => x.id))
    let id = base, n = 1
    while (used.has(id)) id = `${base}-${++n}`

    const p = {
      id,
      name,
      custom: true,
      verified: false,
      base_url: norm.url,
      key_ref: id,
      model: '',
      haiku_model: '',
      context_tokens: 200000,
      extra_env: {},
    }
    state.cfg.providers.push(p)
    if (key) {
      const pass = await currentPassphrase()
      if (pass) setSecretEntry(id, key, pass)
    }
    state.cfg.current = id
    saveProviders(state.cfg)
    state.pCursor = state.cfg.providers.length - 1

    const found = await fetchModels(p, key || null)
    // 拉不到列表也要把模型界面打开:第一项就是手动输入 ——
    // 很多自建网关没有列模型接口,手填才是正常路径,不该在这里失败。
    openModelPicker(p, found.ok ? found : { list: [], url: '' })
    if (norm.changed) {
      state.message = { t: `Base URL 已自动修正为 ${norm.url}(去掉多余的 /v1)`, lv: 'warn' }
    } else if (!found.ok) {
      state.message = { t: `该接口不提供模型列表(${cut(found.reason, 40)})—— 选第一项手动输入模型名`, lv: 'warn' }
    } else {
      state.message = null
    }
  } catch (e) {
    state.message = { t: '新增失败:' + (e && e.message ? e.message : e), lv: 'fail' }
  } finally {
    render()
  }
}

/** E:改名称 / URL / 密钥(留空表示不改) */
async function actionEditProvider() {
  const p = state.cfg.providers[state.pCursor]
  if (!p) return
  try {
    const name = await prompt(`新名称(当前 ${p.name}):`, { hint: '直接回车 = 不修改' })
    const url = await prompt(`新 Base URL(当前 ${p.base_url}):`, {
      hint: '直接回车 = 不修改。填到 /v1 之前为止,Claude Code 会自己接 /v1/messages',
    })
    const key = await prompt('新密钥:', { hidden: true, hint: '输入不回显 · 直接回车 = 不修改密钥' })
    let normalized = false
    if (name) p.name = name
    if (url) { const n = normalizeBaseUrl(url); p.base_url = n.url; normalized = n.changed }
    if (key && p.key_ref) {
      const pass = await currentPassphrase()
      if (pass) setSecretEntry(p.key_ref, key, pass)
    }
    if (!name && !url && !key) { state.message = { t: '没有改动', lv: 'warn' }; return }
    saveProviders(state.cfg)
    state.message = normalized
      ? { t: `已更新 ${p.name};Base URL 已自动修正为 ${p.base_url}`, lv: 'warn' }
      : { t: `已更新 ${p.name}`, lv: 'ok' }
  } catch (e) {
    state.message = { t: '更新失败:' + (e && e.message ? e.message : e), lv: 'fail' }
  } finally {
    render()
  }
}

/** D:删除(只允许删自己加的,避免误删内置项) */
function actionDeleteProvider() {
  const p = state.cfg.providers[state.pCursor]
  if (!p) return
  if (!p.custom) {
    state.message = { t: '内置供应商不能删(防误操作);可以按 E 改它的 URL', lv: 'warn' }
    render()
    return
  }
  state.cfg.providers.splice(state.pCursor, 1)
  try { if (p.key_ref) removeSecretEntry(p.key_ref) } catch {}
  if (state.cfg.current === p.id) state.cfg.current = state.cfg.providers[0]?.id || ''
  state.pCursor = Math.max(0, Math.min(state.pCursor, state.cfg.providers.length - 1))
  saveProviders(state.cfg)
  state.message = { t: `已删除 ${p.name}`, lv: 'ok' }
  render()
}

function actionDoctor() {
  state.doctorOut = '正在运行体检…'
  state.scroll = 0
  const node = process.execPath
  const args = [path.join(HERE, 'doctor.mjs'), '--clean', '--probe']
  const r = spawnSync(node, args, { encoding: 'utf8' })
  state.doctorOut = (r.stdout || '') + (r.stderr || '')
  render()
}

// ───────────────────────── 按键处理 ─────────────────────────
function handleKey(s) {
  if (state.inputLock) return
  if (s === '\x03') { quit(); return }   // Ctrl-C

  // 只用方向键移动;不再让 j/k 兼作上下,免得和子屏的字母动作键冲突
  const up = s === '\x1b[A'
  const down = s === '\x1b[B'
  const enter = s === '\r' || s === '\n'
  const esc = s === '\x1b' || s === '\x1b\x1b'

  if (state.message) state.message = null

  if (state.screen === 'main') {
    const N = mainItems().length
    if (up) state.cursor = (state.cursor + N - 1) % N
    else if (down) state.cursor = (state.cursor + 1) % N
    else if (s >= '1' && s <= '9' && +s <= N) { state.cursor = +s - 1; doMain() }
    else if (enter) doMain()
    else if (s === 'a' || s === 'A') actionAddAgent()
    else if (s === 'e' || s === 'E') actionEditAgent()
    else if (s === 'x' || s === 'X') actionDeleteAgent()
    else if (s === 'q' || s === 'Q' || esc) quit()
  } else if (state.screen === 'providers') {
    const n = state.cfg.providers.length
    if (up) state.pCursor = (state.pCursor + n - 1) % n
    else if (down) state.pCursor = (state.pCursor + 1) % n
    else if (enter) actionSelectProvider()
    else if (s === 'm' || s === 'M') actionPickModel()
    else if (s === 'n' || s === 'N') actionSetModelManual()
    else if (s === 'x' || s === 'X') actionToggleAuth()
    else if (s === 't' || s === 'T') actionProbe()
    else if (s === 'a' || s === 'A') actionAddProvider()
    else if (s === 'e' || s === 'E') actionEditProvider()
    else if (s === 'd' || s === 'D') actionDeleteProvider()
    else if (s === 'k' || s === 'K') { state.screen = 'keys'; state.kCursor = kIndexForProvider(state.pCursor) }
    else if (s === 'q' || s === 'Q' || esc) { state.screen = 'main'; state.message = null }
  } else if (state.screen === 'models') {
    // 第 0 行是"手动输入",所以总行数是 list.length + 1
    const n = state.models ? state.models.list.length + 1 : 1
    if (up) state.models.cursor = (state.models.cursor + n - 1) % n
    else if (down) state.models.cursor = (state.models.cursor + 1) % n
    else if (enter) actionSelectModel()
    else if (s === 'i' || s === 'I') actionSetModelManual()
    else if (s === 'q' || s === 'Q' || esc) { state.screen = 'providers'; state.message = null }
  } else if (state.screen === 'keys') {
    const rows = state.cfg.providers.filter((p) => p.key_ref)
    const n = rows.length
    if (up) state.kCursor = (state.kCursor + n - 1) % n
    else if (down) state.kCursor = (state.kCursor + 1) % n
    else if (s === 'a' || s === 'A') actionSetKey()
    else if (s === 'd' || s === 'D') actionDelKey()
    else if (s === 'q' || s === 'Q' || esc) { state.screen = 'main'; state.message = null }
  } else if (state.screen === 'doctor') {
    if (up) state.scroll = Math.max(0, state.scroll - 1)
    else if (down) state.scroll += 1
    else if (s === 'r' || s === 'R') actionDoctor()
    else if (s === 'q' || s === 'Q' || esc) { state.screen = 'main'; state.message = null }
  } else { // about
    if (s === 'q' || s === 'Q' || esc || enter) { state.screen = 'main'; state.message = null }
  }
  if (state.screen === 'main') void ensureBalance()   // 有 60s 缓存,不会每次都发请求
  render()
}

function kIndexForProvider(pi) {
  const p = state.cfg.providers[pi]
  const rows = state.cfg.providers.filter((x) => x.key_ref)
  const i = rows.findIndex((x) => x.id === p.id)
  return i >= 0 ? i : 0
}

/** 回车:agent 就启动,配置项就进对应的屏 —— 按 id 分派,不再依赖写死的序号 */
function doMain() {
  const it = mainItems()[state.cursor]
  if (!it) return
  if (it.agent) { actionLaunchAgent(it.agent); return }
  if (it.id === 'providers') {
    const i = state.cfg.providers.findIndex((p) => p.id === state.cfg.current)
    state.pCursor = i >= 0 ? i : 0
    state.screen = 'providers'
  } else if (it.id === 'workdir') actionSetWorkdir()
  else if (it.id === 'keys') { state.screen = 'keys'; state.kCursor = 0 }
  else if (it.id === 'doctor') { state.screen = 'doctor'; actionDoctor() }
  else if (it.id === 'about') state.screen = 'about'
}

function quit() {
  exitScreen()
  w('\n')
  process.exit(0)
}

// ───────────────────────── 入口 ─────────────────────────
export async function runTUI(opts = {}) {
  state.cfg = loadProviders()
  state.workdir = opts.workdir || resolveWorkdir()
  state.agents = loadAgents()
  state.appName = appName()
  // 全局 skill / MCP 每次启动都对齐到各 agent(exFAT 不能软链,所以是复制)
  syncSkills()
  applyMcp()
  // 上次若被强杀,aichat 那个含密钥的临时配置会残留 —— 启动时清掉
  if (purgeStaleAichatConfig()) {
    state.message = { t: '已清理上次遗留的 aichat 临时配置(其中含密钥)', lv: 'warn' }
  }
  // 兼容旧写法:确保 current 有效
  if (!state.cfg.providers.some((p) => p.id === state.cfg.current)) {
    state.cfg.current = state.cfg.providers[0].id
  }
  enterScreen()
  IN.on('data', (buf) => {
    if (!state.active) return
    const s = buf.toString('utf8')
    // 方向键会分片到达,简单合并即可(每个按键都是独立的 data 事件)
    handleKey(s)
  })
  OUT.on('resize', () => render())
  render()
  void ensureBalance()          // 余额异步查,查完自己重绘
}

// 调试:单帧渲染后退出,便于检查布局
if (RENDER_ONLY) {
  ;(async () => {
    const a = process.argv.slice(process.argv.indexOf('--render-only') + 1)
    const W = parseInt(a[0], 10) || 84
    const H = parseInt(a[1], 10) || 26
    state.cfg = loadProviders()
    state.cfg.current = state.cfg.current || state.cfg.providers[0].id
    const scr = a[2] || 'main'
    state.screen = scr
    state.workdir = resolveWorkdir()   // 预览也要有工作目录,否则状态栏是空的
    state.agents = loadAgents()
    state.appName = appName()
    if (scr === 'main') await ensureBalance()   // 让预览里的余额是真实值
    if (scr === 'models') {                     // 预览也走与真实流程一致的逻辑
      const p = currentProvider()
      if (Array.isArray(p.models) && p.models.length) {
        state.models = {
          providerId: p.id,
          list: p.models.map((id) => ({ id, label: '', context: null })),
          url: `本地记住的列表(${p.models.length} 个,按 n 可继续添加)`,
          cursor: 0,
        }
      } else {
        let sec = null
        if (p.key_ref) { const r = await getSecret(p.key_ref); if (r.ok) sec = r.value }
        const f = await fetchModels(p, sec)
        state.models = { providerId: p.id, list: f.ok ? f.list : [], url: f.ok ? f.url : '', cursor: 0 }
      }
    }
    const lines = (() => {
      const IW = W - 4
      const IH = H - 2
      let body
      if (scr === 'main') {
        body = bodyMain(IW, IH)
      } else {
      body = scr === 'providers' ? bodyProviders(IW)
        : scr === 'models' ? bodyModels(IW, IH)
        : scr === 'keys' ? bodyKeys(IW)
        : scr === 'about' ? bodyAbout(IW)
        : (state.doctorOut = '（示例）体检输出', bodyDoctor(IW, IH))
        while (body.length < IH - 2) body.push('')
        body.push(dim('─'.repeat(IW)))
        body.push(footer(IW))
      }
      return box(body, W, H, scr === 'main' ? 'P O R T A B L E   A S S I S T A N T'
        : scr === 'providers' ? '供应商' : scr === 'models' ? '选择模型'
        : scr === 'keys' ? '密钥' : scr === 'about' ? '关于' : '体检')
    })()
    process.stdout.write(lines.join('\n') + '\n')
    // 布局自检:每行**显示宽度**必须正好等于框宽。注意中文是双宽字符,
    // 早期版本按码点数校验,中国字被当成 1 列,于是自检"通过"但实际会折行。
    const bad = lines.map((l, i) => [i + 1, vlen(l)]).filter(([, v]) => v !== W)
    if (bad.length) {
      process.stderr.write(`\n⚠ 宽度异常(应为 ${W} 显示列):${bad.map(([i, v]) => ` 行${i}=${v}`).join('')}\n`)
    } else {
      process.stderr.write(`\n✓ 布局自检通过:${lines.length} 行全部对齐在 ${W} 显示列\n`)
    }
    process.exit(0)
  })()
}

if (!RENDER_ONLY && import.meta.url === `file://${process.argv[1]}`) {
  runTUI().catch((e) => { exitScreen(); console.error(e); process.exit(1) })
}
