#!/usr/bin/env node
/**
 * Claude Code 状态栏(中文)
 *
 * 背景:Claude Code 的界面文字(Thought for / Brewed for …)是英文,没有语言开关;
 * 但**状态栏可以由我们自己给**,所以这里做成中文,顺便显示有用信息。
 *
 * ⚠ 必须快、且**绝不能阻塞**:Claude Code 会把一段 JSON 写进 stdin,
 * 但不一定关闭管道。用 fs.readFileSync(0) 会一直等到管道关闭 —— 结果就是状态栏
 * 永远不显示(踩过)。这里改成"收数据 + 超时兜底",保证一定会输出。
 */
import fs from 'node:fs'

const chunks = []
let done = false

function render(raw) {
  let j = {}
  try { j = JSON.parse(raw.trim().split('\n').pop() || '{}') } catch {}

  const model = j?.model?.display_name || j?.model?.id || ''
  const dir = j?.workspace?.current_dir || j?.cwd || ''

  let free = ''
  try {
    const s = fs.statfsSync(new URL('..', import.meta.url).pathname)
    free = `${(Number(s.bavail) * Number(s.bsize) / 1024 ** 3).toFixed(0)}G 可用`
  } catch {}

  const short = dir ? (dir.replace(/^.*\//, '') || dir) : ''
  const parts = ['REMON']
  if (model) parts.push(model)
  if (free) parts.push(`盘 ${free}`)
  if (short) parts.push(`📁 ${short}`)
  process.stdout.write(parts.join('  ·  '))
}

function finish() {
  if (done) return
  done = true
  render(Buffer.concat(chunks).toString('utf8'))
  process.exit(0)
}

process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', finish)
process.stdin.on('error', finish)
setTimeout(finish, 80)          // 兜底:管道不关也要在 80ms 内给出结果
