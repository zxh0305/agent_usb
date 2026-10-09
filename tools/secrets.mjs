#!/usr/bin/env node
/**
 * 随身 Agent 盘 · 密钥库
 *
 * 零依赖(仅 Node 内置 crypto),三平台通用,不需要 age/gpg。
 * 加密:AES-256-GCM;密钥派生:scrypt。密文以 JSON 明文元数据 + base64 密文存储,
 * 因此 secrets.json 本身可以安全地暴露(没有口令解不开)。
 *
 * 口令来源优先级:
 *   1. 环境变量 USB_AGENT_PASSPHRASE
 *   2. 文件 data/config/passphrase        (便利模式;等同于明文,见文档)
 *   3. 交互式输入                          (默认,最安全)
 *
 * 用法:
 *   node tools/secrets.mjs set <name>      录入/覆盖一个密钥(交互输入,不回显)
 *   node tools/secrets.mjs get <name>      解密并打印(供脚本调用)
 *   node tools/secrets.mjs list            列出已录入的密钥名
 *   node tools/secrets.mjs rm  <name>      删除
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const USB = path.resolve(HERE, '..')
const VAULT = path.join(USB, 'data', 'config', 'secrets.json')
const PASSFILE = path.join(USB, 'data', 'config', 'passphrase')

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }

function readVault() {
  if (!fs.existsSync(VAULT)) return { version: 1, kdf: 'scrypt', entries: {} }
  try {
    const v = JSON.parse(fs.readFileSync(VAULT, 'utf8'))
    v.entries ||= {}
    return v
  } catch (e) {
    die(`密钥库损坏,无法解析:${VAULT}\n${e.message}`)
  }
}

function writeVault(v) {
  fs.mkdirSync(path.dirname(VAULT), { recursive: true })
  fs.writeFileSync(VAULT, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 })
}

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`)
  process.exit(1)
}

/** 交互式读取一行,可选隐藏回显 */
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      // 覆盖内部输出,实现不回显
      rl._writeToOutput = function (s) {
        if (s.includes('\n')) rl.output.write('\n')
        else rl.output.write('*')
      }
      rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a) })
    } else {
      rl.question(question, (a) => { rl.close(); resolve(a) })
    }
  })
}

/** 取口令:env → 便利文件 → 交互 */
export async function getPassphrase({ confirm = false } = {}) {
  if (process.env.USB_AGENT_PASSPHRASE) return process.env.USB_AGENT_PASSPHRASE
  if (fs.existsSync(PASSFILE)) {
    const p = fs.readFileSync(PASSFILE, 'utf8').trim()
    if (p) return p
  }
  if (!process.stdin.isTTY) {
    die('需要口令,但当前不是交互终端。请设置 USB_AGENT_PASSPHRASE 环境变量,或创建 data/config/passphrase 文件。')
  }
  const p = await ask('  密钥库口令: ', { hidden: true })
  if (!p) die('口令不能为空')
  if (confirm) {
    const p2 = await ask('  再输一次确认: ', { hidden: true })
    if (p !== p2) die('两次输入不一致')
  }
  return p
}

function deriveKey(pass, salt) {
  return crypto.scryptSync(pass, salt, 32, SCRYPT)
}

export function encrypt(pass, plaintext) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
}

export function decrypt(pass, entry) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, Buffer.from(entry.salt, 'base64')), Buffer.from(entry.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(entry.ct, 'base64')), decipher.final()]).toString('utf8')
}

/** 取某个 key_ref 的明文密钥;失败返回 null 并给出原因 */
export async function getSecret(name, passphrase) {
  const v = readVault()
  const entry = v.entries[name]
  if (!entry) return { ok: false, reason: `密钥库中没有 "${name}"` }
  const pass = passphrase ?? (await getPassphrase())
  try {
    return { ok: true, value: decrypt(pass, entry) }
  } catch {
    return { ok: false, reason: '口令错误,或密钥库被篡改(GCM 校验失败)' }
  }
}

/** 供 TUI 使用:列出 / 写入 / 删除 */
export function listSecretNames() {
  return Object.keys(readVault().entries)
}
export function setSecretEntry(name, value, passphrase) {
  const v = readVault()
  v.entries[name] = encrypt(passphrase, value)
  writeVault(v)
}
export function removeSecretEntry(name) {
  const v = readVault()
  delete v.entries[name]
  writeVault(v)
}
export function hasPassfile() {
  return fs.existsSync(PASSFILE)
}
export function vaultPath() {
  return VAULT
}

// ---------- CLI ----------
async function main() {
  const [cmd, name] = process.argv.slice(2)

  if (cmd === 'list') {
    const v = readVault()
    const names = Object.keys(v.entries)
    if (!names.length) return console.log('  (密钥库为空)')
    console.log('  已录入的密钥:')
    for (const n of names) console.log(`    - ${n}`)
    console.log(`\n  便利模式(口令文件): ${fs.existsSync(PASSFILE) ? '开启 —— 等同于明文' : '未开启(启动时需输口令)'}`)
    return
  }

  if (cmd === 'get') {
    if (!name) die('用法: secrets.mjs get <name>')
    const r = await getSecret(name)
    if (!r.ok) die(r.reason)
    process.stdout.write(r.value)
    return
  }

  if (cmd === 'set') {
    if (!name) die('用法: secrets.mjs set <name>')
    const v = readVault()
    const isNew = !Object.keys(v.entries).length
    const pass = await getPassphrase({ confirm: isNew })
    let val
    if (process.stdin.isTTY) {
      val = (await ask(`  粘贴 "${name}" 的密钥(不回显): `, { hidden: true })).trim()
    } else {
      // 非交互:从 stdin 读取密钥,便于脚本化搭建
      val = fs.readFileSync(0, 'utf8').trim()
    }
    if (!val) die('密钥不能为空')
    v.entries[name] = encrypt(pass, val)
    writeVault(v)
    console.log(`  ✓ 已加密写入 ${path.relative(USB, VAULT)}`)
    return
  }

  if (cmd === 'rm') {
    if (!name) die('用法: secrets.mjs rm <name>')
    const v = readVault()
    if (!v.entries[name]) die(`没有 "${name}"`)
    delete v.entries[name]
    writeVault(v)
    console.log(`  ✓ 已删除 "${name}"`)
    return
  }

  console.log(`随身 Agent 盘 · 密钥库

  用法:
    node tools/secrets.mjs set <name>    录入/覆盖密钥
    node tools/secrets.mjs get <name>    解密打印
    node tools/secrets.mjs list          列出
    node tools/secrets.mjs rm  <name>    删除`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
