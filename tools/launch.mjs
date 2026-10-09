#!/usr/bin/env node
/**
 * 随身 Agent 盘 · 启动器
 *
 * 零依赖(仅 Node 内置模块),一份代码同时服务 macOS / Windows / Linux。
 * 职责:定位盘根 → 把全部环境变量重定向到盘内 → 注入供应商凭证 → 启动 Claude Code。
 *
 * 用法:
 *   node tools/launch.mjs                        打开面板
 *   node tools/launch.mjs --provider deepseek    直接指定供应商启动
 *   node tools/launch.mjs --provider glm -- --help    -- 之后的参数原样透传给 claude
 *   node tools/launch.mjs --list                 列出供应商
 *   node tools/launch.mjs --check                只体检不启动(验证端点/密钥/模型)
 *
 * 工作目录(默认是盘内的 data/workspace):
 *   node tools/launch.mjs --cwd ~/my-project     指定这次在哪工作
 *   node tools/launch.mjs --here                 用启动时 shell 所在的目录
 *   面板主菜单第 7 项可以改,并且会被记住(存在 data/config/daemon.json)
 *
 * 注意:供应商开关是 --provider(不是 -p),因为 -p 是 Claude Code 自己的
 * "非交互打印模式",必须留给它。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getSecret } from './secrets.mjs'

// ────────────────────────── 盘根与平台 ──────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const USB = path.resolve(HERE, '..')
export const DATA = path.join(USB, 'data')
export const PHOME = path.join(DATA, 'home')       // 伪 HOME
export const TMP = path.join(USB, 'tmp')
const PROVIDERS_FILE = path.join(DATA, 'config', 'providers.json')

const OS = process.platform === 'darwin' ? 'darwin'
  : process.platform === 'win32' ? 'win32'
  : process.platform === 'linux' ? 'linux' : null
const ARCH = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
export const PLAT = OS && ARCH ? `${OS}-${ARCH}` : null
export const IS_WIN = OS === 'win32'

function passthroughRoot() {
  const p = process.env.SYSTEMROOT || process.env.SystemRoot || 'C:\\Windows'
  return IS_WIN ? p : '/'
}

// ────────────────────── 工作目录 ──────────────────────
const DAEMON_FILE = path.join(DATA, 'config', 'daemon.json')

export function expandHome(p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return path.resolve(p)
}

export function readDaemon() {
  try { return JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8')) } catch { return {} }
}
export function writeDaemon(obj) {
  fs.mkdirSync(path.dirname(DAEMON_FILE), { recursive: true })
  fs.writeFileSync(DAEMON_FILE, JSON.stringify(obj, null, 2) + '\n')
}

/**
 * 决定这次会话在哪个目录里工作。
 *
 * 优先级(先命中且确实存在的目录胜出):
 *   1. 命令行 --cwd <目录>
 *   2. 命令行 --here(用启动时 shell 所在的目录)
 *   3. 面板里保存过的设置(data/config/daemon.json)
 *   4. 盘内默认 data/workspace
 *
 * 之所以要能改:U 盘插到别的电脑上时,常常是要操作**那台电脑上**的项目,
 * 而不是盘内的目录。写死在盘内会让 Claude Code 的 cd 无效、只能一路用绝对路径。
 */
export function resolveWorkdir({ cli = null, here = false } = {}) {
  const fallback = path.join(DATA, 'workspace')
  const list = []
  if (cli) list.push({ p: cli, src: '--cwd 指定' })
  if (here) list.push({ p: process.cwd(), src: '启动时所在目录' })
  const saved = readDaemon().cwd
  if (saved) list.push({ p: saved, src: '面板里保存的' })
  list.push({ p: fallback, src: '盘内默认' })

  for (const c of list) {
    const p = expandHome(String(c.p))
    try { if (fs.statSync(p).isDirectory()) return { dir: p, src: c.src } } catch {}
  }
  return { dir: fallback, src: '盘内默认' }
}

/**
 * 首次运行时补齐 Claude Code 需要的配置文件。
 * 目的是让"从 git 克隆出来的干净副本"(不含 data/home)也能直接跑起来 ——
 * data/home 属于用户数据,不入版本库,所以必须由代码自己补。
 */
export function ensureClaudeConfig() {
  const dir = path.join(PHOME, '.claude')
  fs.mkdirSync(dir, { recursive: true })

  const settings = path.join(dir, 'settings.json')
  if (!fs.existsSync(settings)) {
    fs.writeFileSync(settings, JSON.stringify({
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      env: {
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      },
    }, null, 2) + '\n')
  }

  // 跳过首次引导向导。注意它不解决鉴权:真正免登录靠启动器在
  // 首次运行前就把 ANTHROPIC_AUTH_TOKEN 注入进去。
  const stateFile = path.join(PHOME, '.claude.json')
  if (!fs.existsSync(stateFile)) {
    fs.writeFileSync(stateFile, JSON.stringify({ hasCompletedOnboarding: true }, null, 2) + '\n')
  }
}

/**
 * 首次运行时从模板生成用户自己的供应商配置。
 * providers.json 不入版本库(会累积自建项、可能含内网地址),
 * 仓库只带 providers.example.json。
 */
export function ensureProvidersConfig() {
  const dst = path.join(DATA, 'config', 'providers.json')
  if (fs.existsSync(dst)) return
  const src = path.join(DATA, 'config', 'providers.example.json')
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
}

export function claudeBinary() {
  if (!PLAT) return null
  const name = IS_WIN ? 'claude.exe' : 'claude'
  const p = path.join(USB, 'app', 'claude', 'node_modules', '@anthropic-ai', `claude-code-${PLAT}`, name)
  return fs.existsSync(p) ? p : null
}

function nodeBinary() {
  if (!PLAT) return process.execPath
  const exe = IS_WIN ? 'node.exe' : 'node'
  const p = path.join(USB, 'runtime', 'node', PLAT, 'bin', exe)
  return fs.existsSync(p) ? p : process.execPath
}

// ────────────────────────── 环境构建 ──────────────────────────
export const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}

/** 宿主环境里可能干扰的变量:一律清掉,确保只走盘上的配置 */
const SHADOW = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_BETAS', 'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CONFIG_DIR', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS',
]

/** 各家网关的鉴权头不一样:多数认 Authorization: Bearer,少数只认 x-api-key */
export function authHeaders(provider, secret) {
  if (!secret) return {}
  return provider.auth === 'x-api-key'
    ? { 'x-api-key': secret }
    : { authorization: `Bearer ${secret}` }
}

/**
 * 规范化 Base URL —— 这是接第三方接口最容易错的地方。
 *
 * Claude Code 会在 ANTHROPIC_BASE_URL 后面**自动接 `/v1/messages`**,
 * 所以 base 里不该再出现 `/v1`、`/v1/messages`、`/messages`,否则会拼成
 * `.../code/v1/v1/messages` 这种 404 路径。
 *
 * ⚠️ 别的客户端约定不同:ZCode 的 "Anthropic Messages" 格式是 base + `/messages`,
 * 所以它的 Base URL 会带 `/v1`。**两边不能照抄。**
 */
export function normalizeBaseUrl(raw) {
  const before = String(raw || '').trim().replace(/\/+$/, '')
  const url = before
    .replace(/\/v1\/messages$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/v1$/i, '')
    .replace(/\/+$/, '')
  return { url, changed: url !== before }
}

export function buildEnv(provider, secret) {
  const env = { ...process.env }

  // 1) 清掉宿主可能已有的同名变量,避免"配置跑到宿主机/用了宿主凭证"
  for (const k of SHADOW) delete env[k]
  // Anthropic 之外的 OpenAI/Gemini 变量也不该影响 Claude Code
  delete env.OPENAI_BASE_URL

  // 2) 伪 HOME —— 必须,遮住 ~/.claude.json 等硬编码家目录的路径
  env.HOME = PHOME
  if (IS_WIN) {
    env.USERPROFILE = PHOME
    env.APPDATA = path.join(PHOME, 'AppData', 'Roaming')
    env.LOCALAPPDATA = path.join(PHOME, 'AppData', 'Local')
  }

  // 3) 配置目录进盘
  env.CLAUDE_CONFIG_DIR = path.join(PHOME, '.claude')

  // 4) 关掉自动更新与一切非必要外联(便携盘必须:否则更新会破坏盘上安装)
  env.DISABLE_AUTOUPDATER = '1'
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  env.DISABLE_TELEMETRY = '1'
  env.DISABLE_ERROR_REPORTING = '1'
  env.DISABLE_BUG_COMMAND = '1'
  env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1'

  // 5) 第三方网关:剥掉实验性 beta 头(400 报错的最大来源)
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
  env.API_TIMEOUT_MS = '600000'

  // 6) 临时目录进盘
  env.TMPDIR = TMP; env.TEMP = TMP; env.TMP = TMP

  // 6b) macOS:尽量阻止生成 AppleDouble 边车文件(._*),避免污染跨平台目录
  if (OS === 'darwin') env.COPYFILE_DISABLE = '1'

  // 7) 供应商注入
  if (provider) {
    env.ANTHROPIC_BASE_URL = provider.base_url
    // 两种鉴权方式只能设一个:都设会触发"两个凭证来源"的告警,且优先级不好记
    if (secret) {
      if (provider.auth === 'x-api-key') env.ANTHROPIC_API_KEY = secret
      else env.ANTHROPIC_AUTH_TOKEN = secret
    }
    env.ANTHROPIC_MODEL = provider.model
    // 声明为"自定义模型":Claude Code 会跳过模型名校验,消除 unrecognized_model 提示
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = provider.model
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = provider.name
    // 四个档位全指向同一模型:后台任务不会发出网关不认识的模型名
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.haiku_model || provider.model
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.model
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.model
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = provider.model
    env.CLAUDE_CODE_SUBAGENT_MODEL = provider.haiku_model || provider.model
    if (provider.context_tokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(provider.context_tokens)
    for (const [k, v] of Object.entries(provider.extra_env || {})) env[k] = String(v)
  }
  return env
}

// ────────────────────────── 工具 ──────────────────────────
export function loadProviders() {
  // 放在这里而不是 main():tui.mjs / doctor.mjs 也会直接调它,
  // 干净克隆的第一次调用同样需要从模板生成配置。
  ensureProvidersConfig()
  if (!fs.existsSync(PROVIDERS_FILE)) die(`找不到供应商清单:${PROVIDERS_FILE}`)
  try { return JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8')) }
  catch (e) { die(`供应商清单解析失败:\n${e.message}`) }
}

function die(msg) { console.error(`\n  ${C.r('✗')} ${msg}\n`); process.exit(1) }
function ok(msg) { console.log(`  ${C.g('✓')} ${msg}`) }

export function freeSpace() {
  try {
    const s = fs.statfsSync(USB)
    const bytes = Number(s.bavail) * Number(s.bsize)
    return (bytes / 1024 ** 3).toFixed(1) + ' GB'
  } catch { return '?' }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (a) => { rl.close(); resolve(a) })
  })
}

/**
 * 真实探活:发一个 max_tokens=1 的最小请求,当场验证端点 / 密钥 / 模型名。
 *
 * 遇到 401/403 会**自动换另一种鉴权方式再试一次**(Bearer ↔ x-api-key),
 * 并在结果里说明哪种能用 —— 官方建议就是"先 AUTH_TOKEN,401 再换 API_KEY"。
 */
export async function probe(provider, secret) {
  if (!provider.base_url) return { ok: false, reason: '没有 base_url' }
  if (!provider.model) {
    return { ok: false, reason: '还没选模型(供应商屏按 n 可手动输入模型名)' }
  }
  const url = provider.base_url.replace(/\/+$/, '') + '/v1/messages'
  const body = JSON.stringify({
    model: provider.model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  })
  const preferred = provider.auth === 'x-api-key' ? 'x-api-key' : 'bearer'
  const order = [preferred, preferred === 'bearer' ? 'x-api-key' : 'bearer']
  let last = null

  for (const mode of order) {
    const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
    if (secret) {
      if (mode === 'x-api-key') headers['x-api-key'] = secret
      else headers.authorization = `Bearer ${secret}`
    }
    const t0 = Date.now()
    let res
    try {
      res = await fetch(url, { method: 'POST', headers, body })
    } catch (e) {
      return { ok: false, reason: `网络不可达:${e.message}`, url, authUsed: mode }
    }
    const ms = Date.now() - t0
    const text = await res.text()
    if (res.ok) {
      return { ok: true, ms, url, model: provider.model, authUsed: mode, switched: mode !== preferred }
    }
    let detail = text.slice(0, 300)
    try { const j = JSON.parse(text); detail = j.error?.message || j.message || detail } catch {}
    const hint =
      res.status === 401 ? '密钥不对、或鉴权方式不对(已自动两种都试过)' :
      res.status === 403 ? '密钥无权访问该模型' :
      res.status === 404 ? `路径或模型名不对。注意 base 里**不要带 /v1** —— Claude Code 会自己接 /v1/messages,这次实际请求的是 ${url}` :
      res.status === 400 ? '请求被拒(多为实验性 beta 头;本启动器已默认关闭)' :
      res.status === 429 ? '余额不足或触发限流' : ''
    last = { ok: false, status: res.status, reason: detail, hint, url, ms, authUsed: mode }
    // 只有鉴权类错误才值得换一种方式重试,其它错误换了也一样
    if (res.status !== 401 && res.status !== 403) return last
  }
  return last
}

function header(row) {
  const bin = claudeBinary()
  const ver = fs.existsSync(path.join(USB, 'app', 'claude', 'VERSION'))
    ? fs.readFileSync(path.join(USB, 'app', 'claude', 'VERSION'), 'utf8').trim() : '未安装'
  console.log()
  console.log(C.cyan('  ┌' + '─'.repeat(62) + '┐'))
  console.log(C.cyan('  │') + C.b('  随 身 A G E N T 盘  ·  CLAUDE STATION') + ' '.repeat(22) + C.cyan('│'))
  console.log(C.cyan('  ├' + '─'.repeat(62) + '┤'))
  console.log(C.cyan('  │') + `  RUNTIME   node ${process.version}  (${PLAT || '未知平台'})`.padEnd(62) + C.cyan('│'))
  console.log(C.cyan('  │') + `  APP       claude-code ${ver}`.padEnd(62) + C.cyan('│'))
  console.log(C.cyan('  │') + `  盘剩余    ${freeSpace()}`.padEnd(62) + C.cyan('│'))
  if (!bin) console.log(C.cyan('  │') + C.r(`  ⚠ 本平台(${PLAT})的 Claude Code 未安装,请先跑 tools/build-local.sh`) + C.cyan('│'))
  console.log(C.cyan('  └' + '─'.repeat(62) + '┘'))
}

// ────────────────────────── 主流程 ──────────────────────────
async function main() {
  ensureClaudeConfig()          // 干净副本首次运行也能直接跑
  ensureProvidersConfig()
  const argv = process.argv.slice(2)
  // 分离透传给 claude 的参数
  const sep = argv.indexOf('--')
  const own = sep >= 0 ? argv.slice(0, sep) : argv
  const rest = sep >= 0 ? argv.slice(sep + 1) : []

  const cfg = loadProviders()

  // 这次在哪个目录工作(--cwd / --here / 已保存的设置 / 盘内默认)
  const ci = own.findIndex((a) => a === '--cwd' || a === '-C')
  const workdir = resolveWorkdir({ cli: ci >= 0 ? own[ci + 1] : null, here: own.includes('--here') })

  if (own.includes('--list')) {
    console.log('\n  已配置的供应商:')
    for (const p of cfg.providers) {
      const mark = p.id === cfg.current ? C.g('●') : ' '
      const v = p.verified ? '' : C.dim(' (未验证)')
      console.log(`   ${mark} ${p.id.padEnd(16)} ${p.name}${v}\n       ${C.dim(p.base_url)}  ${C.dim('模型 ' + p.model)}`)
    }
    console.log(`\n  当前:${C.b(cfg.current)}   (用 --provider <id> 指定)\n`)
    return
  }

  // 没有显式指令、又是交互终端 → 打开交互面板(双击启动走的就是这条路)
  const hasProviderFlag = own.some((a) => a === '--provider' || a === '-P')
  if (!hasProviderFlag && !own.includes('--check') && !own.includes('--no-tui') && process.stdin.isTTY) {
    const { runTUI } = await import('./tui.mjs')
    await runTUI({ workdir })
    return
  }

  // 选供应商
  let pid = null
  const pi = own.findIndex((a) => a === '--provider' || a === '-P')
  if (pi >= 0) pid = own[pi + 1]
  if (!pid) pid = cfg.current

  let provider = cfg.providers.find((p) => p.id === pid) || cfg.providers[0]

  // 取密钥
  let secret = null
  if (provider.key_ref) {
    const r = await getSecret(provider.key_ref)
    if (!r.ok) {
      header()
      console.log(`\n  ${C.y('!')} 取不到 "${provider.key_ref}" 的密钥:${r.reason}`)
      console.log(`\n  先录入密钥:`)
      console.log(`    ${C.b(`node tools/secrets.mjs set ${provider.key_ref}`)}\n`)
      process.exit(1)
    }
    secret = r.value
  }

  // ★ 必须在这里拦:模型为空时若照常启动,ANTHROPIC_MODEL 会是空串,
  //   Claude Code 会回落到它自己的默认模型名,于是打到一个对方不认识的
  //   模型上报错(现象是莫名其妙的 404 / "model may not exist"),极难排查。
  if (!provider.model) {
    die(`${provider.name} 还没选模型,不能启动。\n\n` +
        `  用面板选:${C.b('sh tools/claude.sh')} → ${C.b('2')}(供应商)→ ${C.b('m')}(获取模型列表)→ 选一个\n` +
        `  或直接编辑 ${C.dim('data/config/providers.json')} 里该供应商的 ${C.b('model')} 字段`)
  }

  // --check:只探活不启动
  if (own.includes('--check')) {
    header()
    console.log(`\n  供应商  ${C.b(provider.name)}  ${C.dim('(' + provider.id + ')')}`)
    console.log(`  端点    ${provider.base_url}`)
    console.log(`  模型    ${provider.model}`)
    console.log(`  ${C.dim('探活中…')}`)
    const r = await probe(provider, secret)
    if (r.ok) { ok(`连通(${r.ms}ms)—— 端点、密钥、模型名都正确`); console.log() }
    else {
      console.log(`\n  ${C.r('✗')} 探活失败${r.status ? ` [HTTP ${r.status}]` : ''}`)
      console.log(`    ${r.reason}`)
      if (r.hint) console.log(`    ${C.y('提示:')} ${r.hint}`)
      console.log()
      process.exit(1)
    }
    return
  }

  // 启动
  const bin = claudeBinary()
  if (!bin) { header(); die(`本平台(${PLAT})没有可用的 Claude Code。\n  用 tools/build-local.sh 构建后拷入 app/claude/`) }

  header()
  console.log(`\n  供应商  ${C.b(provider.name)}  ${C.dim('(' + provider.id + ')')}`)
  console.log(`  模型    ${C.b(provider.model)}   ${C.dim('· 小模型 ' + (provider.haiku_model || provider.model))}`)
  console.log(`  工作区  ${C.dim(workdir.dir)}  ${C.dim('(' + workdir.src + ')')}`)
  console.log(`  密钥    ${secret ? C.g('● 已注入') : C.y('○ 无')}`)
  console.log(`\n  ${C.dim('启动 Claude Code…(首次会问是否信任该工作目录,选 yes 即可)')}\n`)

  fs.mkdirSync(TMP, { recursive: true })
  try { fs.mkdirSync(workdir.dir, { recursive: true }) } catch {}

  const env = buildEnv(provider, secret)
  const child = spawn(bin, rest, {
    cwd: workdir.dir,
    env,
    stdio: 'inherit',
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  child.on('error', (e) => die(`启动失败:${e.message}`))
}

if (import.meta.url === `file://${process.argv[1]}`) main()
