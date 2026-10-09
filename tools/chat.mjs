#!/usr/bin/env node
/**
 * 内置 · 轻量对话助手(零依赖)
 *
 * 与 Claude Code 的区别:它**只对话,不带文件/命令工具**。
 * 适合问答、文案、翻译、起名字这类不需要动文件的事 —— 启动快、开销小,
 * 也不会去读写你的项目。
 *
 * 用法:
 *   node tools/chat.mjs                用当前供应商
 *   node tools/chat.mjs --provider glm 指定供应商
 *   node tools/chat.mjs --system "你是一个严格的代码审阅者"
 *
 * 会话内命令:/clear 清空上下文 · /save 导出 · /exit 退出
 * 每轮对话都会追加到 data/sessions/chat/ 下,跟着 U 盘走。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { loadProviders, authHeaders, DATA, C, listSkills, readSkill } from './launch.mjs'
import { getSecret } from './secrets.mjs'

const DEFAULT_SYSTEM = '你是一个简洁、直接的中文助手。回答不要客套,不要复述我的问题。'

function parseArgs(argv) {
  const out = { provider: null, system: null }
  const pi = argv.findIndex((a) => a === '--provider' || a === '-P')
  if (pi >= 0) out.provider = argv[pi + 1]
  const si = argv.findIndex((a) => a === '--system')
  if (si >= 0) out.system = argv[si + 1]
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cfg = loadProviders()
  const prov = cfg.providers.find((p) => p.id === (args.provider || cfg.current)) || cfg.providers[0]
  if (!prov) { console.error('  没有可用的供应商'); process.exit(1) }
  if (!prov.model) {
    console.error(`\n  ${C.r('✗')} ${prov.name} 还没选模型。\n` +
      `    用面板选:sh tools/claude.sh → 2(供应商)→ m 或 n(手填模型名)\n`)
    process.exit(1)
  }
  if (!prov.base_url) { console.error('  该供应商没有 base_url'); process.exit(1) }

  let secret = null
  if (prov.key_ref) {
    const r = await getSecret(prov.key_ref)
    if (!r.ok) { console.error(`\n  ${C.r('✗')} 取不到密钥:${r.reason}\n`); process.exit(1) }
    secret = r.value
  }

  const url = prov.base_url.replace(/\/+$/, '') + '/v1/messages'
  const messages = [{ role: 'user', content: `[系统指令] ${args.system || DEFAULT_SYSTEM}` }]

  // 每轮对话落盘:换电脑也能接着看
  const dir = path.join(DATA, 'sessions', 'chat')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logFile = path.join(dir, `${stamp}.md`)
  const log = (who, text) => fs.appendFileSync(logFile, `\n**${who}:** ${text}\n`)

  console.log()
  console.log(`  ${C.b('对话助手')}   ${prov.name} · ${C.b(prov.model)}`)
  console.log(`  ${C.dim('只对话,不操作文件。命令:/clear 清空 · /skill 技能 · /save 导出 · /exit 退出')}`)
  console.log(`  ${C.dim('记录:' + path.relative(process.cwd(), logFile))}`)
  console.log()

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })

  async function send() {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...authHeaders(prov, secret),
        },
        body: JSON.stringify({ model: prov.model, max_tokens: 8192, stream: true, messages }),
      })
    } catch (e) {
      console.log(`\n  ${C.r('✗')} 网络不可达:${e.message}\n`)
      return null
    }
    if (!res.ok) {
      const t = await res.text()
      let d = t.slice(0, 300)
      try { const j = JSON.parse(t); d = j.error?.message || j.message || d } catch {}
      const hint = res.status === 401 ? '密钥或鉴权方式不对(可在供应商屏按 x 切换 Bearer / x-api-key)'
        : res.status === 404 ? `路径或模型名不对。实际请求:${url}`
        : res.status === 429 ? '余额不足或限流' : ''
      console.log(`\n  ${C.r('✗')} [HTTP ${res.status}] ${d}${hint ? `\n    ${C.y('提示:')} ${hint}` : ''}\n`)
      return null
    }

    // 流式输出
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = '', full = ''
    process.stdout.write(`\n  ${C.dim('助手')} › `)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
          // 只显示正文;thinking 之类的推理块略过,免得刷屏
          if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
            process.stdout.write(j.delta.text)
            full += j.delta.text
          }
        } catch {}
      }
    }
    process.stdout.write('\n\n')
    return full
  }

  let turns = 0
  const PROMPT = `  ${C.b('你')} › `
  // 管道输入(非 TTY)时,EOF 会先于回复到达并关掉 readline,
  // 之后再调 prompt() 会抛 "readline was closed"。所以统一走这个守卫。
  const reask = () => { if (!rl.closed) { rl.setPrompt(PROMPT); rl.prompt() } }
  reask()
  for await (const line of rl) {
    if (rl.closed) break
    const text = line.trim()
    if (!text) { reask(); continue }
    if (text === '/exit' || text === '/quit') break
    if (text === '/clear') {
      messages.length = 1
      turns = 0
      console.log(`  ${C.dim('已清空上下文')}\n`)
      reask(); continue
    }
    if (text === '/save') {
      console.log(`  ${C.dim('已记录在 ' + logFile)}\n`)
      reask(); continue
    }
    // 全局 skill:和 Claude Code 共用同一份 data/skills/,这里按需载入
    if (text === '/skill' || text === '/skills') {
      const names = listSkills()
      console.log(`  ${C.dim(names.length ? '可用技能:' + names.join(' · ') + '(用 /skill <名字> 载入)' : '还没有技能;放进 data/skills/<名字>/SKILL.md 即可')}\n`)
      reask(); continue
    }
    if (text.startsWith('/skill ')) {
      const n = text.slice(7).trim()
      const s = readSkill(n)
      if (!s) {
        console.log(`  ${C.r('✗')} 没有技能「${n}」${listSkills().length ? ';可用:' + listSkills().join(' · ') : ''}\n`)
        reask(); continue
      }
      messages.push({ role: 'user', content: `[技能指令] 接下来请按这个技能执行:\n\n${s.body}` })
      console.log(`  ${C.g('✓')} 已载入技能 ${C.b(n)}${s.meta.description ? '  ' + C.dim(s.meta.description) : ''}\n`)
      reask(); continue
    }

    messages.push({ role: 'user', content: text })
    log('你', text)
    const reply = await send()
    if (reply === null) {
      messages.pop()               // 失败就别留在上下文里,免得污染后续
    } else {
      messages.push({ role: 'assistant', content: reply })
      log('助手', reply)
      turns++
    }
    reask()
  }
  if (!rl.closed) rl.close()
  if (turns > 0) console.log(`  ${C.dim(`本次 ${turns} 轮,记录:`)} ${logFile}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n  ✗ ' + (e && e.message ? e.message : e)); process.exit(1) })
}
