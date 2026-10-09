#!/usr/bin/env node
/**
 * 内置 MCP server(零依赖,stdio 传输)
 *
 * 为什么要自己写一个:盘上已经有的 claude / chat / aichat 都读不到**加密密钥库**,
 * 也就没法回答"我还剩多少余额""当前用的是哪个供应商"这类问题。这正好是
 * MCP 该补的缺口 —— 而不是把 Claude Code 已有的能力(读写文件、bash、搜索)再包一遍。
 *
 * 暴露三个工具:
 *   usb_balance   当前(或指定)供应商的账户余额
 *   usb_providers 盘上配了哪些供应商、当前用哪个、模型是什么、密钥有没有
 *   usb_status    盘剩余空间、工作目录、可用的 agent 列表
 *
 * 协议:JSON-RPC 2.0,按行分隔(每行一个完整 JSON)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadProviders, loadAgents, authHeaders, resolveWorkdir } from './launch.mjs'
import { getSecret } from './secrets.mjs'

const TOOLS = [
  {
    name: 'usb_balance',
    description: '查询供应商账户余额。默认查当前供应商;只有配置了 balance 接口的供应商能查(如 DeepSeek)。',
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string', description: '供应商标识(不填则用当前供应商)' } },
    },
  },
  {
    name: 'usb_providers',
    description: '列出这个盘上配置的所有供应商:当前选中哪个、模型是什么、密钥是否已录入、接口地址。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'usb_status',
    description: '这个便携盘的状态:剩余空间、当前工作目录、可用的 agent 列表。',
    inputSchema: { type: 'object', properties: {} },
  },
]

const pick = (obj, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj)

async function callTool(name, args = {}) {
  if (name === 'usb_providers') {
    const cfg = loadProviders()
    const lines = cfg.providers.map((p) => {
      const mark = p.id === cfg.current ? '← 当前' : ''
      return `- ${p.id}  ${p.name}  模型 ${p.model || '(未选)'}  密钥 ${p.key_ref ? '已录入' : '—'}  ${mark}\n    ${p.base_url}`
    })
    return `共 ${cfg.providers.length} 个供应商:\n${lines.join('\n')}`
  }

  if (name === 'usb_status') {
    const agents = loadAgents()
    const wd = resolveWorkdir()
    let free = '?'
    try {
      const s = fs.statfsSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'))
      free = `${(Number(s.bavail) * Number(s.bsize) / 1024 ** 3).toFixed(1)} GB`
    } catch {}
    return [
      `盘剩余空间:${free}`,
      `工作目录:${wd.dir}(${wd.src})`,
      `可用 agent(${agents.length} 个):`,
      ...agents.map((a) => `  - ${a.name} [${a.kind || 'cmd'}] ${a.desc || ''}`),
    ].join('\n')
  }

  if (name === 'usb_balance') {
    const cfg = loadProviders()
    const p = cfg.providers.find((x) => x.id === (args.provider || cfg.current))
    if (!p) return `找不到供应商 ${args.provider}`
    if (!p.balance) return `${p.name} 没有配置余额接口,查不了。可在 data/config/providers.json 里给它加 balance 字段。`
    const r = p.key_ref ? await getSecret(p.key_ref) : { ok: true, value: null }
    if (!r.ok) return `取不到 ${p.id} 的密钥:${r.reason}`
    try {
      const res = await fetch(p.balance.url, { headers: authHeaders(p, r.value) })
      const j = await res.json()
      const total = pick(j, p.balance.total)
      const cur = p.balance.currency ? pick(j, p.balance.currency) : ''
      const sym = { CNY: '¥', USD: '$' }[cur] || (cur ? cur + ' ' : '')
      return res.ok ? `${p.name} 余额:${sym}${total}` : `查询失败:HTTP ${res.status}`
    } catch (e) {
      return `查询失败:${e.message}`
    }
  }

  return `未知工具:${name}`
}

// ───────── JSON-RPC over stdio(按行分隔)─────────
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

let buf = ''
process.stdin.on('data', async (chunk) => {
  buf += chunk.toString('utf8')
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    await handle(msg)
  }
})

async function handle(msg) {
  const id = msg.id
  const reply = (result) => send({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  try {
    if (msg.method === 'initialize') {
      // 把客户端要求的协议版本原样回过去,兼容性最好
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'usb-local', version: '1.0.0' },
      })
    }
    if (msg.method === 'notifications/initialized' || msg.method === 'initialized') return
    if (msg.method === 'ping') return reply({})
    if (msg.method === 'tools/list') return reply({ tools: TOOLS })
    if (msg.method === 'tools/call') {
      const text = await callTool(msg.params?.name, msg.params?.arguments || {})
      return reply({ content: [{ type: 'text', text }] })
    }
    // 未实现的方法:按协议返回"方法不存在",而不是静默
    if (id !== undefined) return fail(-32601, `未实现的方法:${msg.method}`)
  } catch (e) {
    if (id !== undefined) fail(-32603, e && e.message ? e.message : String(e))
  }
}

process.stdin.on('end', () => process.exit(0))
