#!/usr/bin/env node
/**
 * 随身 Agent 盘 · Claude Code 自动安装器
 *
 * 场景:从 git 克隆出来的干净副本没有 app/(二进制不入库),以前只能提示
 * "去跑 tools/build-local.sh" 然后把人拦在门外。本模块让面板/命令行在
 * 缺二进制时**当场下载安装**:拉 npm 上的平台包(@anthropic-ai/claude-code-<plat>,
 * 里面就是一个原生可执行文件),解出二进制放进 app/ 的标准位置。
 *
 * 约束与设计:
 *   · 零依赖(仅 Node 内置模块)—— 盘上不能 npm install(exFAT 无软链)。
 *   · 不需要 npm:直接走 npm registry 的 HTTP 接口拿元数据和 tarball。
 *   · tar.gz 用 zlib 流式解压 + 手写 tar 解析,边解边写,内存占用只有
 *     一个 chunk 的大小(二进制解压后有 200MB+,不能整个读进内存)。
 *   · 先写 .part 再改名:中途断网/Ctrl-C 不会留下一个"看似装好了"的半截文件。
 *   · registry 依次尝试 npmjs → npmmirror(国内网络常常只有镜像能通),
 *     可用环境变量 USB_AGENT_NPM_REGISTRY 指定首选项。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MB = 1024 * 1024

function registries() {
  // 环境变量可指定一个或多个(逗号分隔,按顺序优先);之后是内置的公网与国内镜像
  const env = (process.env.USB_AGENT_NPM_REGISTRY || '')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  const list = [...env, 'https://registry.npmjs.org', 'https://registry.npmmirror.com']
  return [...new Set(list)]
}

const hostOf = (url) => { try { return new URL(url).host } catch { return url } }

/** 把字节流写到文件,边写边报进度;shouldAbort 返回 true 时抛 cancelled 错误 */
async function downloadTo(file, url, { onProgress, shouldAbort }) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || null
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const fd = fs.openSync(file, 'w')
  let got = 0
  try {
    for await (const chunk of res.body) {
      if (shouldAbort && shouldAbort()) { const e = new Error('已取消'); e.cancelled = true; throw e }
      fs.writeSync(fd, chunk)
      got += chunk.length
      if (onProgress) onProgress({ phase: 'download', got, total })
    }
  } finally { fs.closeSync(fd) }
  if (total && got !== total) throw new Error(`下载不完整( ${got}/${total} 字节)`)
  return got
}

// ───────────────────────── tar 解析(流式) ─────────────────────────
// 只需要"找到目标成员并把它的数据写出来",所以是一个小状态机,不是完整 tar 实现。
// 支持 ustar 普通文件、GNU 长文件名('L')与 pax 头('x' 里的 path=…),
// 其余成员(目录/软链等)一律跳过 —— 平台包里本来也只有 package.json 和二进制。

const padOf = (size) => (512 - (size % 512)) % 512
const strAt = (buf, from, to) => buf.toString('utf8', from, to).replace(/\0.*$/, '')

function octAt(buf, from, to) {
  const s = buf.toString('ascii', from, to).replace(/\0.*$/, '').trim()
  return parseInt(s || '0', 8) || 0
}

/**
 * 从 .tgz 文件里流式解出名为 pick(name) 的成员,写到 destPath。
 * 返回 Promise<{ size }>。onBytes(已写字节) 用于解压进度。
 */
function extractTarMember(tgzPath, pick, destPath, onBytes, shouldAbort = null) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(tgzPath)
    const gz = zlib.createGunzip()
    let buf = Buffer.alloc(0)
    let state = 'head'            // head | meta | skip | data | pad
    let left = 0, padLeft = 0
    let metaKind = 0, metaBuf = Buffer.alloc(0)
    let longName = null
    let fd = null, written = 0, found = null
    let settled = false
    const fail = (e) => {
      if (settled) return
      settled = true
      try { if (fd !== null) fs.closeSync(fd) } catch {}
      try { fs.rmSync(destPath, { force: true }) } catch {}
      reject(e)
    }

    gz.on('data', (chunk) => {
      if (settled) return
      // ★ 'data' 回调里抛异常会变成 uncaughtException,必须自己接住
      try {
        if (shouldAbort && shouldAbort()) {
          rs.destroy(); gz.destroy()
          const e = new Error('已取消'); e.cancelled = true
          fail(e); return
        }
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
        while (true) {
          // ★ 缓冲区暂时为空必须退出等下一个 chunk:各消费状态在空缓冲上
          //   take=0、left 不变,原地空转会饿死事件循环(流再也送不来数据)。
          if (buf.length === 0) break
          if (state === 'head') {
            if (buf.length < 512) break
            if (buf[0] === 0 && octAt(buf, 124, 136) === 0) {   // 全零头 = 归档结束
              rs.destroy(); gz.destroy()
              if (found) { settled = true; resolve(found) } else fail(new Error('归档里找不到 Claude Code 的可执行文件'))
              return
            }
            const raw = strAt(buf, 0, 100)
            const size = octAt(buf, 124, 136)
            const type = buf[156]
            buf = buf.subarray(512)
            if (type === 76 || type === 120) {                   // 'L' 长文件名 / 'x' pax 头
              state = 'meta'; left = size; padLeft = padOf(size)
              metaKind = type; metaBuf = Buffer.alloc(0)
            } else {
              const name = longName || raw; longName = null
              const isFile = type === 0 || type === 48           // 旧式 '\0' 或 '0'
              if (isFile && pick(name)) {
                fd = fs.openSync(destPath, 'w'); written = 0
                state = 'data'; left = size; padLeft = padOf(size)
              } else {
                state = 'skip'; left = size; padLeft = padOf(size)
              }
            }
            continue
          }
          if (state === 'meta') {
            const take = Math.min(buf.length, left)
            if (take > 0) metaBuf = Buffer.concat([metaBuf, buf.subarray(0, take)])
            buf = buf.subarray(take); left -= take
            if (left === 0) {
              if (metaKind === 76) longName = strAt(metaBuf, 0, metaBuf.length)
              else { const m = /(?:^|\n)path=([^\n]*)/.exec(metaBuf.toString('utf8')); if (m) longName = m[1] }
              state = 'pad'; left = padLeft
            }
            continue
          }
          if (state === 'data') {
            const take = Math.min(buf.length, left)
            if (take > 0) {
              fs.writeSync(fd, buf, 0, take)
              written += take
              if (onBytes) onBytes(written)
            }
            buf = buf.subarray(take); left -= take
            if (left === 0) {
              try { fs.closeSync(fd) } catch {}
              fd = null
              found = { size: written }
              state = 'pad'; left = padLeft
            }
            continue
          }
          // skip / pad:丢弃字节即可。★ skip 完数据后必须先过 pad(512 对齐的填充),
          // 直接回 head 会让后续所有头部错位 —— 真实包里在 claude 之前还有
          // package.json 等成员,错一位就再也匹配不到目标了。
          const take = Math.min(buf.length, left)
          buf = buf.subarray(take); left -= take
          if (left === 0) {
            if (state === 'pad') state = 'head'
            else { state = 'pad'; left = padLeft }
          }
        }
      } catch (e) { fail(e) }
    })
    gz.on('end', () => {
      if (settled) return
      if (found) { settled = true; resolve(found) }
      else fail(new Error('归档里找不到 Claude Code 的可执行文件'))
    })
    gz.on('error', fail)
    rs.on('error', fail)
    rs.pipe(gz)
  })
}

/**
 * 安装当前平台的 Claude Code。
 *
 * 用法(面板 / CLI 都调它):
 *   const r = await installClaudeCode({
 *     plat: 'darwin-arm64', usbDir: '/Volumes/agent_usb',
 *     onProgress: ({ phase, got, total, version, registry }) => {},
 *     shouldAbort: () => false,
 *   })
 *
 * 返回 { ok:true, version, binPath, sizeMB } 或 { ok:false, cancelled?, reason }。
 * phase: 'meta'(查版本)| 'download'(下 tarball)| 'extract'(解压写盘)| 'done'
 */
export async function installClaudeCode({
  plat, usbDir,
  version = process.env.USB_AGENT_CC_VER || null,
  registries: registryList = null,
  onProgress = null,
  shouldAbort = null,
}) {
  if (!plat) return { ok: false, reason: '未知平台(不是 macOS/Windows/Linux 的 arm64/x64)' }
  const pkg = `@anthropic-ai/claude-code-${plat}`
  const binName = plat.startsWith('win32-') ? 'claude.exe' : 'claude'
  const destDir = path.join(usbDir, 'app', 'claude', 'node_modules', '@anthropic-ai', `claude-code-${plat}`)
  const dest = path.join(destDir, binName)
  const errors = []
  const regs = (registryList && registryList.length ? registryList : registries())

  for (const reg of regs) {
    let meta
    try {
      if (onProgress) onProgress({ phase: 'meta', registry: reg })
      const url = `${reg}/${encodeURIComponent(pkg)}/${version || 'latest'}`
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) throw new Error(`查询版本失败 HTTP ${res.status}`)
      meta = await res.json()
      if (!meta?.dist?.tarball) throw new Error('registry 元数据里没有 tarball 地址')
    } catch (e) {
      if (e.cancelled) return { ok: false, cancelled: true, reason: '已取消' }
      errors.push(`${hostOf(reg)}:${e.message}`)
      continue
    }
    const ver = meta.version
    const unpacked = Number(meta.dist.unpackedSize) || null

    // 盘剩余空间:tgz + 解出的二进制 + .part,留 64MB 余量
    try {
      const s = fs.statfsSync(usbDir)
      const free = Number(s.bavail) * Number(s.bsize)
      const need = (unpacked || 300 * MB) + 64 * MB
      if (free < need) {
        return { ok: false, reason: `盘剩余空间不足(约需 ${(need / MB).toFixed(0)}MB,剩 ${(free / MB).toFixed(0)}MB)` }
      }
    } catch { /* 查不到就不管,写失败自然会报 */ }

    const tmpDir = path.join(usbDir, 'tmp')
    const tgz = path.join(tmpDir, `cc-install-${plat}.tgz`)
    const part = `${dest}.part`
    try {
      fs.mkdirSync(tmpDir, { recursive: true })
      await downloadTo(tgz, meta.dist.tarball, { onProgress, shouldAbort })
      fs.mkdirSync(destDir, { recursive: true })   // ★ 必须在解压前:.part 就写在这里面
      if (onProgress) onProgress({ phase: 'extract', got: 0, total: unpacked, version: ver, registry: reg })
      const r = await extractTarMember(
        tgz,
        (name) => name === `package/${binName}` || name === `package/bin/${binName}`,
        part,
        (got) => { if (onProgress) onProgress({ phase: 'extract', got, total: unpacked, version: ver, registry: reg }) },
        shouldAbort,
      )
      fs.renameSync(part, dest)                 // 原子落位:之前哪怕中断,也只是一个 .part
      try { fs.chmodSync(dest, 0o755) } catch {}  // exFAT 会忽略,无妨
      fs.writeFileSync(path.join(usbDir, 'app', 'claude', 'VERSION'), ver + '\n')
      try { fs.rmSync(tgz, { force: true }) } catch {}   // 临时 tarball 用完即删
      // macOS 在 exFAT 上会生成 ._ 边车文件,一并清掉(和 build-local.sh 的收尾一致)
      for (const junk of [
        path.join(destDir, `._${binName}`),
        path.join(path.dirname(tgz), `._${path.basename(tgz)}`),
        path.join(usbDir, 'app', 'claude', '._VERSION'),
      ]) {
        try { fs.rmSync(junk, { force: true }) } catch {}
      }
      if (onProgress) onProgress({ phase: 'done', version: ver, registry: reg })
      return { ok: true, version: ver, binPath: dest, sizeMB: (r.size / MB).toFixed(1) }
    } catch (e) {
      try { fs.rmSync(part, { force: true }) } catch {}
      try { fs.rmSync(tgz, { force: true }) } catch {}
      if (e.cancelled) return { ok: false, cancelled: true, reason: '已取消' }
      errors.push(`${hostOf(reg)}:${e.message}`)
      continue
    }
  }
  return { ok: false, reason: errors.join(' ; ') || '所有 registry 都不可达' }
}

// ───────────────────────── 命令行直跑 ─────────────────────────
//   node tools/install-cc.mjs [平台]     平台缺省 = 当前平台;纯文本进度条
if (import.meta.url === `file://${process.argv[1]}`) {
  const platArg = process.argv[2]
  const OS = process.platform === 'win32' ? 'win32'
    : process.platform === 'darwin' ? 'darwin'
    : process.platform === 'linux' ? 'linux' : null
  const ARCH = process.arch === 'arm64' || process.arch === 'x64' ? process.arch : null
  const plat = platArg || (OS && ARCH ? `${OS}-${ARCH}` : null)
  const usbDir = path.resolve(path.dirname(process.argv[1]), '..')
  const barOf = (p) => {
    const W = 36
    const fill = p === null ? 0 : Math.round(W * Math.max(0, Math.min(1, p)))
    const pct = p === null ? ' -- ' : String(Math.round(p * 100)).padStart(3) + '%'
    return `[${'█'.repeat(fill)}${'░'.repeat(W - fill)}] ${pct}`
  }
  console.log(`\n  安装 Claude Code(${plat || '?'})→ ${usbDir}\n`)
  const t0 = Date.now()
  const r = await installClaudeCode({
    plat, usbDir,
    onProgress: (i) => {
      if (i.phase === 'meta') process.stdout.write(`\r  查询版本(${hostOf(i.registry)})…\x1b[K`)
      else if (i.phase === 'download' || i.phase === 'extract') {
        const p = i.total ? i.got / i.total : null
        const mb = (n) => n == null ? '?' : (n / 1024 / 1024).toFixed(1)
        process.stdout.write(`\r  ${i.phase === 'download' ? '下载' : '解压'} ${barOf(p)} ${mb(i.got)}/${mb(i.total)}MB\x1b[K`)
      } else if (i.phase === 'done') {
        process.stdout.write('\n')
      }
    },
  })
  if (r.ok) {
    console.log(`  ✓ Claude Code ${r.version} 已装好(${r.sizeMB}MB,${((Date.now() - t0) / 1000).toFixed(0)}s)\n`)
  } else {
    console.error(`\n  ✗ 安装失败:${r.reason}\n`)
    process.exit(1)
  }
}
