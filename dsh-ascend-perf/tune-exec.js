/**
 * 昇腾性能工作台二期 —— 调优执行器基础设施。
 *
 * 设计原则（对应 docs/tuning-design.md §5）：
 * - 命令一律 argv 数组，不经过 shell 展开；每个值先校验再拼装。
 * - 真实执行默认关闭：即使调用方传 dry_run=false，也要通过配置、target policy 与授权桥三重门。
 * - 只操作本插件创建的进程句柄；不按名称杀进程、不碰容器/systemd。
 * - 本文件不 import 任何 @deepseek-ai/* 包。
 */
import { createConnection, createServer } from 'node:net'

export class TuneApiError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'TuneApiError'
    this.code = code
    this.details = details
  }
}

export function tuneError(code, message, details = null) {
  return new TuneApiError(code, message, details)
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** 校验单个 argv 值：拒绝控制符/换行、超长、前导 '-'（防止被当成 flag）与空串。 */
export function assertSafeToken(value, field) {
  const text = String(value ?? '')
  if (!text) throw tuneError('INVALID_SPEC', `${field} 不能为空`)
  if (text.length > 1024) throw tuneError('INVALID_SPEC', `${field} 过长`)
  if (CONTROL_CHARS.test(text)) throw tuneError('INVALID_SPEC', `${field} 含控制字符`)
  if (text.startsWith('-')) throw tuneError('INVALID_SPEC', `${field} 不能以 - 开头`)
  return text
}

export function assertIntInRange(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw tuneError('INVALID_SPEC', `${field} 必须是 ${min}–${max} 的整数`)
  }
  return value
}

export function assertFiniteInRange(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw tuneError('INVALID_SPEC', `${field} 必须是 ${min}–${max} 的有限数值`)
  }
  return value
}

/**
 * 编译 vLLM serve argv（模板固定，参数为独立 argv 值）。
 * 仅用于展示/审阅与未来获授权执行；本插件当前不启动真实服务。
 */
export function buildServeArgv({ pythonAbs, modelAbs, servedModelName, port, tensorParallel, dtype, quantization, params }) {
  const argv = [
    assertSafeToken(pythonAbs, 'python_abs'),
    '-m',
    'vllm.entrypoints.openai.api_server',
    '--model',
    assertSafeToken(modelAbs, 'model_abs'),
    '--served-model-name',
    assertSafeToken(servedModelName, 'served_model_name'),
    '--host',
    '127.0.0.1',
    '--port',
    String(assertIntInRange(port, 'port', 1, 65535)),
    '--tensor-parallel-size',
    String(assertIntInRange(tensorParallel, 'tensor_parallel', 1, 64)),
    '--dtype',
    assertSafeToken(dtype, 'dtype'),
    '--max-num-seqs',
    String(assertIntInRange(params.max_num_seqs, 'max_num_seqs', 1, 1024)),
    '--max-num-batched-tokens',
    String(assertIntInRange(params.max_num_batched_tokens, 'max_num_batched_tokens', 128, 131072)),
    '--gpu-memory-utilization',
    String(assertFiniteInRange(params.gpu_memory_utilization, 'gpu_memory_utilization', 0.1, 0.95)),
    '--max-model-len',
    String(assertIntInRange(params.max_model_len, 'max_model_len', 256, 131072)),
  ]
  if (quantization && quantization !== 'none') {
    argv.push('--quantization', assertSafeToken(quantization, 'quantization'))
  }
  return argv
}

/** 编译 vLLM bench serve argv（固定模板）。 */
export function buildBenchArgv({ vllmAbs, baseUrl, model, inputLen, outputLen, numPrompts, concurrency, rateLiteral, seed, resultDir, resultName }) {
  return [
    assertSafeToken(vllmAbs, 'vllm_abs'),
    'bench',
    'serve',
    '--backend',
    'vllm',
    '--base-url',
    assertSafeToken(baseUrl, 'base_url'),
    '--endpoint',
    '/v1/completions',
    '--model',
    assertSafeToken(model, 'model'),
    '--dataset-name',
    'random',
    '--random-input-len',
    String(assertIntInRange(inputLen, 'input_len', 1, 131072)),
    '--random-output-len',
    String(assertIntInRange(outputLen, 'output_len', 2, 65536)),
    '--random-range-ratio',
    '1.0',
    '--num-prompts',
    String(assertIntInRange(numPrompts, 'num_prompts', 1, 1000000)),
    '--max-concurrency',
    String(assertIntInRange(concurrency, 'max_concurrency', 1, 1024)),
    '--request-rate',
    rateLiteral === 'inf' ? 'inf' : String(assertFiniteInRange(Number(rateLiteral), 'request_rate', 0.0001, 10000)),
    '--seed',
    String(assertIntInRange(seed, 'seed', 0, 4294967295)),
    '--ignore-eos',
    '--percentile-metrics',
    'ttft,tpot,itl',
    '--metric-percentiles',
    '50,99',
    '--save-result',
    '--result-dir',
    assertSafeToken(resultDir, 'result_dir'),
    '--result-filename',
    assertSafeToken(resultName, 'result_name'),
  ]
}

/**
 * 端口锁：在 127.0.0.1 上尝试监听，确认端口空闲后立即释放监听并记录占用。
 * 只用于本插件协调，不能替代共享环境所有者的交接；占用时绝不杀占用者。
 */
export class PortLock {
  constructor({ host = '127.0.0.1' } = {}) {
    this.host = host
    this.held = new Set()
  }

  async acquire(port) {
    assertIntInRange(port, 'port', 1, 65535)
    if (this.held.has(port)) throw tuneError('PORT_BUSY', `端口 ${port} 已被本插件占用`)
    const free = await new Promise((resolve, reject) => {
      const server = createServer()
      server.once('error', (error) => {
        if (error?.code === 'EADDRINUSE') resolve(false)
        else reject(tuneError('PORT_BUSY', `端口检查失败：${String(error?.message ?? error)}`))
      })
      server.listen({ port, host: this.host, exclusive: true }, () => {
        server.close(() => resolve(true))
      })
    })
    if (!free) throw tuneError('PORT_BUSY', `端口 ${port} 已被占用，未执行任何清理`)
    this.held.add(port)
    return port
  }

  release(port) {
    this.held.delete(port)
  }

  releaseAll() {
    this.held.clear()
  }
}

/**
 * 拥有式进程运行器：只持有本插件 spawn 的 handle，超时/取消时只 terminate 该 handle。
 * spawn 可注入（Host 使用 ctx.subprocess.spawn），测试使用 fake。
 */
export class OwnedProcessRunner {
  constructor({ spawn, graceMs = 5000, defaultTimeoutMs = 60000 } = {}) {
    if (typeof spawn !== 'function') throw tuneError('INVALID_ARGUMENT', 'OwnedProcessRunner 需要 spawn 函数')
    this.spawn = spawn
    this.graceMs = graceMs
    this.defaultTimeoutMs = defaultTimeoutMs
    this.live = new Set()
  }

  async run(argv, { cwd, env, timeoutMs = this.defaultTimeoutMs, collectLimit = 256 * 1024 } = {}) {
    const handle = this.spawn({
      argv,
      cwd,
      env,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: collectLimit },
        stderr: { maxBytes: collectLimit },
      },
      graceMs: this.graceMs,
    })
    this.live.add(handle)
    let timer = null
    let timedOut = false
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        try {
          handle.terminate?.()
        } catch { /* 终止失败交给 done 结果 */ }
        resolve({ timed_out: true })
      }, timeoutMs)
    })
    const finished = Promise.resolve(handle.done).then((result) => ({ result, timed_out: false }))
    const outcome = await Promise.race([finished, timeout])
    if (timer) clearTimeout(timer)
    this.live.delete(handle)
    const readAll = (stream) => {
      try {
        return stream?.readFrom?.(0)?.text ?? ''
      } catch {
        return ''
      }
    }
    const done = outcome.result ?? null
    const exitCode = Number.isInteger(done?.exit_code) ? done.exit_code : Number.isInteger(done?.code) ? done.code : null
    return {
      exit_code: timedOut ? null : exitCode,
      timed_out: timedOut,
      terminated_owned: timedOut,
      stdout: readAll(handle.collected?.stdout),
      stderr: readAll(handle.collected?.stderr),
    }
  }

  /** 只终止本 runner 持有的句柄；从不按名称/端口杀进程。 */
  terminateOwned(handle) {
    if (!this.live.has(handle)) return false
    try {
      handle.terminate?.()
      return true
    } catch {
      return false
    }
  }

  async terminateAll() {
    for (const handle of [...this.live]) this.terminateOwned(handle)
  }
}

/**
 * 真实执行门。返回 {ok, code, message}。
 * demo 不走此门；local/ssh 必须同时满足配置开关、维护窗口策略与有效授权。
 */
export function realExecutionGate({ executor, config = {}, targetPolicy = 'readonly', grant = null }) {
  if (executor === 'demo') return { ok: true, code: null, message: null }
  if (!config.enableRealExecutors) {
    return { ok: false, code: 'REAL_EXECUTION_DISABLED', message: '真实执行器未启用（tuning.enableRealExecutors=false）' }
  }
  if (targetPolicy !== 'maintenance_only') {
    return { ok: false, code: 'TARGET_READONLY', message: '目标策略不是 maintenance_only，拒绝启动/压测' }
  }
  if (!grant || !grant.grant_id || !grant.plan_hash) {
    return { ok: false, code: 'AUTH_BRIDGE_UNAVAILABLE', message: '当前 Harness 无可验证的用户授权桥，真实执行保持关闭' }
  }
  const now = Date.now()
  const start = Date.parse(grant.window_start ?? '')
  const end = Date.parse(grant.window_end ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now > end) {
    return { ok: false, code: 'AUTH_EXPIRED', message: '维护窗口未开始或已结束' }
  }
  return { ok: true, code: null, message: null }
}

/** 本地执行器：在已授权 sandbox 内启动自有 supervisor 并管理其生命周期（当前默认关闭）。 */
export class LocalExecutor {
  constructor({ config = {}, spawn, portLock = new PortLock() } = {}) {
    this.name = 'local'
    this.config = config
    this.portLock = portLock
    this.runner = spawn ? new OwnedProcessRunner({ spawn }) : null
  }

  describe() {
    return { mode: 'local', enabled: Boolean(this.config.enableRealExecutors), readonly: !this.config.enableRealExecutors }
  }

  async acquire(port) {
    return this.portLock.acquire(port)
  }

  release(port) {
    this.portLock.release(port)
  }

  buildServeCommand(input) {
    return buildServeArgv(input)
  }

  buildBenchCommand(input) {
    return buildBenchArgv(input)
  }

  async stopOwned() {
    if (!this.runner) return { stopped: 0 }
    await this.runner.terminateAll()
    return { stopped: this.runner.live.size }
  }
}

/** SSH 执行器：固定外层 argv，remote command 由编译器内置常量；当前默认关闭。 */
export class SshExecutor {
  constructor({ config = {}, alias = null } = {}) {
    this.name = 'ssh'
    this.config = config
    this.alias = alias
  }

  /** 固定 ssh argv；remoteCommand 必须是编译器内置常量，不接受用户输入拼接。 */
  sshArgv(remoteCommand) {
    const alias = assertSafeToken(this.alias, 'ssh_alias')
    if (alias.includes('@') || alias.includes(':')) throw tuneError('INVALID_SPEC', 'ssh alias 不能包含 @ 或 :')
    const remote = String(remoteCommand ?? '')
    if (!remote || CONTROL_CHARS.test(remote)) throw tuneError('INVALID_SPEC', 'remote command 必须是内置常量')
    return [
      'ssh',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'ConnectTimeout=10',
      alias,
      remote,
    ]
  }

  describe() {
    return { mode: 'ssh', alias: this.alias, enabled: Boolean(this.config.enableRealExecutors), readonly: !this.config.enableRealExecutors }
  }
}

export function probeLocalPort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); done(true) })
    socket.once('error', () => { clearTimeout(timer); done(false) })
  })
}
