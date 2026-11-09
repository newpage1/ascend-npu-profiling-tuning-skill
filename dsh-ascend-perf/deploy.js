/**
 * 昇腾性能工作台三期（部署 v2，t30）—— 以 envs 环境为目标的「代码基线差异」可编辑部署计划。
 *
 * 对应用户 m02366 与 t30 任务书：
 * - 部署目标 = envs.json 中启用的环境（不再有 services.json 资产目录 / dry-run 预览 / 演示服务）；
 * - 核心是「验证某分支/代码基线相对基线的差异」：按候选/基线输入生成结构化步骤计划；
 * - 计划可编辑（改步骤、增删、排序）并持久化到 configDir/plans.json（version 1，0600，原子写）；
 * - 计划可重新打开、删除；重新生成覆盖需确认（UI 责任，REST 直接生成草稿不落盘）。
 *
 * 硬边界：纯本地文本。不执行任何步骤 —— 不 git、不 pip、不启停服务、不跑 benchmark、不连 NPU。
 * 真实执行留待后续授权（EXECUTION_NOT_SUPPORTED 是显式契约）。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包；只用 node 内置模块与同目录 tune-exec.js 的校验助手。
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TuneApiError, assertIntInRange, tuneError } from './tune-exec.js'

export const DEPLOY_SCHEMA = 'dsh-ascend-perf/deploy-v2'
export const DEPLOY_PLAN_SCHEMA = 'dsh-ascend-perf/deploy-plan-v2'
export const PLAN_STORE_FILE = 'plans.json'
export const DEPLOY_PLAN_GENERATOR = 'deploy-plan-generator-v1'

export const DEPLOY_LIMITS = {
  maxPlans: 32,
  maxSteps: 64,
  maxTitleLen: 120,
  maxDetailLen: 1024,
  maxCommandLen: 2048,
  maxRefLen: 200,
  maxNameLen: 128,
  maxPathLen: 512,
  maxPlanTitleLen: 160,
}

/** v2 实际使用的错误码（REST 400 + 工具 envelope error 共用；鉴权 401/503 由挂载层统一产生）。 */
export const DEPLOY_ERROR_CODES = [
  'INVALID_ARGUMENT', 'INVALID_SPEC', 'UNKNOWN_FIELD', 'ENV_UNKNOWN', 'ENV_DISABLED',
  'PLAN_UNKNOWN', 'PLAN_STORE_READ_FAILED', 'PLAN_LIMIT_EXCEEDED', 'STEP_INVALID',
  'EXECUTION_NOT_SUPPORTED', 'INTERNAL_ERROR',
]

// ----------------------------------------------------------------------------------------------
// 通用助手（与 tune.js 同口径，保持各文件自洽）
// ----------------------------------------------------------------------------------------------

const zz = (x) => (Object.is(x, -0) ? 0 : x)

export function canonicalJson(value) {
  const walk = (v) => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw tuneError('INVALID_SPEC', '数值必须有限')
      return zz(v)
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const key of Object.keys(v).sort()) out[key] = walk(v[key])
      return out
    }
    return v
  }
  return JSON.stringify(walk(value))
}

export function sha256(input) {
  return createHash('sha256').update(String(input)).digest('hex')
}

function nowIso(now) {
  return (now instanceof Date ? now : new Date(Number(now) || Date.now())).toISOString()
}

function fail(code, message, details = null) {
  return tuneError(code, message, details)
}

function rejectUnknown(raw, allowed, where) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('INVALID_SPEC', `${where} 必须是对象`)
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw fail('UNKNOWN_FIELD', `${where} 含未知字段：${key}`, { field: `${where}.${key}` })
  }
}

// ----------------------------------------------------------------------------------------------
// 输入校验：环境 / 基线 / 模型 / 启动参数
// ----------------------------------------------------------------------------------------------

const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/
const COMMIT_RE = /^[0-9a-fA-F]{7,40}$/
const PATH_RE = /^[A-Za-z0-9_./~-]+$/
const NAME_RE = /^[A-Za-z0-9_.:@ -]+$/
const PLAN_ID_RE = /^plan-[0-9a-f]{16}$/

const SPEC_KEYS = ['env_id', 'title', 'component', 'candidate', 'baseline', 'model', 'params']
// t44 B：代码组件白名单——基线/候选同组件对照；缺省 vllm-ascend；旧 plans.json 无 component 时读取侧补默认。
export const DEPLOY_COMPONENTS = ['vllm', 'vllm-ascend', 'lmcache', 'lmcache-ascend', 'mooncake']
export const DEFAULT_DEPLOY_COMPONENT = 'vllm-ascend'
const REF_KEYS = ['ref', 'commit']
const MODEL_KEYS = ['path', 'served_name']
const PARAMS_KEYS = ['port', 'tensor_parallel', 'max_num_seqs', 'max_num_batched_tokens', 'health_timeout_s']

function validateRef(raw, where) {
  const source = raw ?? {}
  rejectUnknown(source, REF_KEYS, where)
  const ref = String(source.ref ?? '').trim()
  if (!ref) throw fail('INVALID_SPEC', `${where}.ref 不能为空（分支或 tag）`)
  if (ref.length > DEPLOY_LIMITS.maxRefLen || !REF_RE.test(ref)) {
    throw fail('INVALID_SPEC', `${where}.ref 含非法字符或超过 ${DEPLOY_LIMITS.maxRefLen} 字符（仅允许字母/数字/./_/-//）`)
  }
  const commitRaw = String(source.commit ?? '').trim()
  let commit = ''
  if (commitRaw) {
    if (!COMMIT_RE.test(commitRaw)) throw fail('INVALID_SPEC', `${where}.commit 必须是 7–40 位十六进制（或留空取 HEAD）`)
    commit = commitRaw.toLowerCase()
  }
  return { ref, commit } // commit 为空 → 执行期取该 ref 的 HEAD（计划文本如实呈现）
}

function validateModelSpec(raw) {
  const source = raw ?? {}
  rejectUnknown(source, MODEL_KEYS, 'model')
  const path = String(source.path ?? '').trim()
  if (!path.startsWith('/') || path.length > DEPLOY_LIMITS.maxPathLen || !PATH_RE.test(path)) {
    throw fail('INVALID_SPEC', `model.path 必须是以 / 开头的绝对路径（白名单字符，≤${DEPLOY_LIMITS.maxPathLen} 字符）`)
  }
  const nameRaw = String(source.served_name ?? '').trim()
  const servedName = nameRaw || path.split('/').filter(Boolean).pop() || 'model'
  if (servedName.length > DEPLOY_LIMITS.maxNameLen || !NAME_RE.test(servedName)) {
    throw fail('INVALID_SPEC', `model.served_name 含非法字符或超过 ${DEPLOY_LIMITS.maxNameLen} 字符`)
  }
  return { path, served_name: servedName }
}

export function validateParamsSpec(raw, where = 'params') {
  const source = raw ?? {}
  rejectUnknown(source, PARAMS_KEYS, where)
  return {
    port: assertIntInRange(source.port, `${where}.port`, 1024, 65535),
    tensor_parallel: assertIntInRange(source.tensor_parallel, `${where}.tensor_parallel`, 1, 8),
    max_num_seqs: assertIntInRange(source.max_num_seqs ?? 256, `${where}.max_num_seqs`, 1, 1024),
    max_num_batched_tokens: assertIntInRange(source.max_num_batched_tokens ?? 8192, `${where}.max_num_batched_tokens`, 128, 131072),
    health_timeout_s: assertIntInRange(source.health_timeout_s ?? 300, `${where}.health_timeout_s`, 5, 3600),
  }
}

/**
 * 计划规格校验（生成与保存共用，fail-closed）。
 * getEnv(envId) → { env, occupancy } | null 由挂载方注入（读 envs 配置与占用缓存，不触发采集）。
 */
export function validatePlanSpec(raw, getEnv) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('INVALID_ARGUMENT', '请求体必须是对象')
  rejectUnknown(raw, SPEC_KEYS, 'spec')
  const envId = String(raw.env_id ?? '').trim()
  if (!envId) throw fail('INVALID_ARGUMENT', 'env_id 不能为空')
  const state = getEnv(envId)
  if (!state?.env) throw fail('ENV_UNKNOWN', `环境不存在：${envId}（不在 envs.json 当前内容中，或 envs.json 读取失败）`)
  if (state.env.enabled === false) throw fail('ENV_DISABLED', `环境已停用：${envId}（envs.json 中 enabled=false）`)
  // 代码组件：基线/候选共用同一组件做对照；缺省/空 → vllm-ascend；白名单外 fail-closed。
  const componentRaw = raw.component == null ? '' : String(raw.component).trim()
  const component = componentRaw || DEFAULT_DEPLOY_COMPONENT
  if (!DEPLOY_COMPONENTS.includes(component)) {
    throw fail('INVALID_SPEC', `component 必须是 ${DEPLOY_COMPONENTS.join(' / ')}（默认 ${DEFAULT_DEPLOY_COMPONENT}）`)
  }
  const spec = {
    env: { id: state.env.id, name: state.env.name ?? state.env.id, mode: state.env.mode ?? 'local', host_alias: state.env.hostAlias ?? null },
    component,
    candidate: validateRef(raw.candidate, 'candidate'),
    baseline: validateRef(raw.baseline, 'baseline'),
    model: validateModelSpec(raw.model),
    params: validateParamsSpec(raw.params),
  }
  const titleRaw = raw.title == null ? '' : String(raw.title).trim()
  const title = titleRaw || `${spec.env.name} · ${spec.candidate.ref} vs ${spec.baseline.ref}`
  if (title.length > DEPLOY_LIMITS.maxPlanTitleLen) throw fail('INVALID_SPEC', `title 超过 ${DEPLOY_LIMITS.maxPlanTitleLen} 字符`)
  return { title, ...spec }
}

// ----------------------------------------------------------------------------------------------
// 步骤校验与默认计划生成
// ----------------------------------------------------------------------------------------------

const STEP_KEYS = ['id', 'title', 'detail', 'command', 'scope']
const STEP_SCOPES = ['candidate', 'baseline', 'both']

export function normalizePlanStep(raw, index, takenIds = new Set()) {
  const source = raw ?? {}
  rejectUnknown(source, STEP_KEYS, `steps[${index}]`)
  const title = String(source.title ?? '').trim()
  if (!title) throw fail('STEP_INVALID', `steps[${index}].title 不能为空`)
  if (title.length > DEPLOY_LIMITS.maxTitleLen) throw fail('STEP_INVALID', `steps[${index}].title 超过 ${DEPLOY_LIMITS.maxTitleLen} 字符`)
  const detail = String(source.detail ?? '').trim()
  if (detail.length > DEPLOY_LIMITS.maxDetailLen) throw fail('STEP_INVALID', `steps[${index}].detail 超过 ${DEPLOY_LIMITS.maxDetailLen} 字符`)
  let command = source.command == null ? null : String(source.command).trim()
  if (command === '') command = null
  if (command && command.length > DEPLOY_LIMITS.maxCommandLen) throw fail('STEP_INVALID', `steps[${index}].command 超过 ${DEPLOY_LIMITS.maxCommandLen} 字符`)
  const scope = source.scope ?? 'both'
  if (!STEP_SCOPES.includes(scope)) throw fail('STEP_INVALID', `steps[${index}].scope 必须是 ${STEP_SCOPES.join('/')}`)
  let id = String(source.id ?? '').trim()
  if (!id || !/^[A-Za-z0-9_-]{1,16}$/.test(id) || takenIds.has(id)) id = `s${index + 1}`
  while (takenIds.has(id)) id = `${id.slice(0, 14)}-${index + 1}`
  takenIds.add(id)
  return { id, title, detail, command, scope }
}

export function normalizePlanSteps(rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw fail('STEP_INVALID', 'steps 必须是非空数组（至少一个步骤）')
  if (rawSteps.length > DEPLOY_LIMITS.maxSteps) throw fail('STEP_INVALID', `步骤数超过上限 ${DEPLOY_LIMITS.maxSteps}`)
  const taken = new Set()
  return rawSteps.map((step, index) => normalizePlanStep(step, index, taken))
}

/** ref 的可读形式：commit 留空 → 展示为 ref@HEAD。 */
const refText = (ref) => `${ref.ref}${ref.commit ? `@${ref.commit.slice(0, 12)}` : '@HEAD'}`

/**
 * 默认计划生成器（deploy-plan-generator-v1）：候选 vs 基线的对照实验步骤。
 * command 是给人读/改的文本占位（执行是后续授权的事），逐条嵌入用户输入以便直接照抄。
 */
export function buildPlanSteps(spec) {
  const { env, component, candidate, baseline, model, params } = spec
  const serve = (label) =>
    `${component} serve ${model.path} --served-model-name ${model.served_name} --port ${params.port}` +
    ` --tensor-parallel-size ${params.tensor_parallel} --max-num-seqs ${params.max_num_seqs}` +
    ` --max-num-batched-tokens ${params.max_num_batched_tokens}`
  const checkout = (ref) => `git fetch origin && git checkout ${ref.ref}${ref.commit ? ` && git checkout ${ref.commit}` : ''}`
  const steps = [
    {
      title: '环境占用检查',
      detail: `在面板「环境信息」确认 ${env.name}${env.host_alias ? `（${env.host_alias}）` : ''} 空闲（无他人训练/推理任务），必要时先「刷新全部」拿到最新快照。占用高时先协调，不要强行部署。`,
      command: null,
      scope: 'both',
    },
    {
      title: '获取代码并检出基线',
      detail: `组件 ${component}：拉取远端并检出基线 ${refText(baseline)}，作为性能对照的原点。`,
      command: checkout(baseline),
      scope: 'baseline',
    },
    {
      title: '基线依赖安装与构建',
      detail: '按仓库实际方式安装依赖并构建（以下命令为占位，按需修改）。',
      command: 'pip install -e .',
      scope: 'baseline',
    },
    {
      title: '基线服务启动',
      detail: `在 ${env.name} 上以基线代码启动推理服务（组件 ${component}，端口 ${params.port}）。`,
      command: serve('baseline'),
      scope: 'baseline',
    },
    {
      title: '基线健康检查',
      detail: `等待服务就绪（超时 ${params.health_timeout_s}s）：/v1/models 返回且包含 ${model.served_name}。`,
      command: `curl -sf --max-time ${Math.min(params.health_timeout_s, 60)} http://127.0.0.1:${params.port}/v1/models`,
      scope: 'baseline',
    },
    {
      title: '基线基准运行并记录',
      detail: '运行团队基准脚本（ServingBenchmark 等）并保存结果；随后把 JSON 导入本插件「性能调优」段留作对照。',
      command: `python benchmarks/benchmark_serving.py --model ${model.path} --port ${params.port} --save baseline.json`,
      scope: 'baseline',
    },
    {
      title: '停基线服务，检出候选并构建启动',
      detail: `停掉基线服务后切换到候选 ${refText(candidate)}（同一组件 ${component}），重复安装/构建/启动。`,
      command: checkout(candidate),
      scope: 'candidate',
    },
    {
      title: '候选健康检查与基准运行',
      detail: `候选服务就绪后（超时 ${params.health_timeout_s}s）用与基线完全相同的基准脚本与参数运行，保存 candidate.json。`,
      command: `python benchmarks/benchmark_serving.py --model ${model.path} --port ${params.port} --save candidate.json`,
      scope: 'candidate',
    },
    {
      title: '指标对比（baseline vs candidate）',
      detail: '在「性能调优」段导入 baseline.json 与 candidate.json，生成对比与洞察（吞吐/延迟/显存按阈值判定）。',
      command: null,
      scope: 'both',
    },
    {
      title: '日志与产物收集归档',
      detail: '收集两端服务日志、基准 JSON 与环境快照，归档到团队约定位置；之后停掉候选服务，释放环境。',
      command: null,
      scope: 'both',
    },
  ]
  return normalizePlanSteps(steps)
}

// ----------------------------------------------------------------------------------------------
// plans.json 存储（configDir，version 1，0600 原子写）
// ----------------------------------------------------------------------------------------------

function parsePlansPayload(text, file) {
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw fail('PLAN_STORE_READ_FAILED', `plans.json 不是合法 JSON（${String(error?.message ?? error).slice(0, 160)}）：${file}`)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('PLAN_STORE_READ_FAILED', `plans.json 结构非法（应为 {version:1, plans:[…]}）：${file}`)
  }
  if (payload.version !== 1) throw fail('PLAN_STORE_READ_FAILED', `plans.json version 必须是 1：${file}`)
  if (!Array.isArray(payload.plans)) throw fail('PLAN_STORE_READ_FAILED', `plans.json plans 必须是数组：${file}`)
  return { version: 1, plans: payload.plans }
}

export function readPlansConfig(configDir) {
  const file = join(configDir, PLAN_STORE_FILE)
  if (!existsSync(file)) return { plans: [] }
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw fail('PLAN_STORE_READ_FAILED', `plans.json 读取失败（${String(error?.message ?? error).slice(0, 160)}）：${file}`)
  }
  return parsePlansPayload(text, file)
}

export function writePlansConfig(configDir, plans, now = Date.now()) {
  const file = join(configDir, PLAN_STORE_FILE)
  mkdirSync(configDir, { recursive: true })
  try { chmodSync(configDir, 0o700) } catch { /* 目录已存在且权限不可改时不阻断 */ }
  const payload = { version: 1, updated_at: nowIso(now), plans }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return file
}

// ----------------------------------------------------------------------------------------------
// 计划服务：生成（草稿）/ 保存 / 读取 / 更新 / 删除
// -----------------------------------------------------------------------------

function planSummary(plan) {
  // 旧计划兼容：早期版本只有顶层 env_id（无 env 对象），读出侧补全展示。
  const env = plan.env ?? { id: plan.env_id ?? '(unknown)', name: plan.env_id ?? '(unknown)', mode: 'ssh', host_alias: null }
  return {
    id: plan.id,
    title: plan.title,
    env: { id: env.id, name: env.name, mode: env.mode, host_alias: env.host_alias },
    component: plan.component ?? DEFAULT_DEPLOY_COMPONENT,
    candidate: { ...plan.candidate },
    baseline: { ...plan.baseline },
    step_count: (plan.steps ?? []).length,
    updated_at: plan.updated_at,
    created_at: plan.created_at,
  }
}

export class DeployPlanService {
  /**
   * @param {object} options
   * @param {string} options.configDir plans.json 所在目录
   * @param {(envId: string) => { env: object, occupancy: object | null } | null} options.getEnv 只读注入
   * @param {number | Date} [options.now] 时钟注入（测试）
   */
  constructor({ configDir, getEnv, now }) {
    this.configDir = configDir
    this.getEnv = getEnv
    this.now = () => (now === undefined ? Date.now() : now instanceof Date ? now.getTime() : Number(now))
  }

  /** 按输入生成计划草稿：纯本地文本，不落盘（保存走 createPlan/updatePlan）。 */
  generate(rawSpec, { origin = 'tool' } = {}) {
    const spec = validatePlanSpec(rawSpec, this.getEnv)
    const draft = {
      schema: DEPLOY_PLAN_SCHEMA,
      draft: true,
      id: null,
      title: spec.title,
      env: spec.env,
      component: spec.component,
      candidate: spec.candidate,
      baseline: spec.baseline,
      model: spec.model,
      params: spec.params,
      steps: buildPlanSteps(spec),
      generator: DEPLOY_PLAN_GENERATOR,
      generated_at: nowIso(this.now()),
      executes: false,
      notes: '计划仅是文本：本插件不执行任何步骤（不 git/不 pip/不启停服务/不跑 benchmark/不连 NPU）。',
      origin_hint: origin,
    }
    return deployEnvelope('generate', { data: { plan: draft } })
  }

  /** 校验并保存新计划（POST /deploy/plans）。id 由服务端分配。 */
  createPlan(rawInput) {
    const { plan } = this._normalizePlanInput(rawInput, null)
    const store = readPlansConfig(this.configDir)
    if (store.plans.length >= DEPLOY_LIMITS.maxPlans) {
      throw fail('PLAN_LIMIT_EXCEEDED', `已保存计划数达到上限 ${DEPLOY_LIMITS.maxPlans}，请先删除旧计划`)
    }
    const now = nowIso(this.now())
    const saved = { ...plan, draft: false, id: `plan-${randomUUID().replace(/-/g, '').slice(0, 16)}`, created_at: now, updated_at: now, origin_hint: undefined }
    writePlansConfig(this.configDir, [...store.plans, saved], this.now())
    return deployEnvelope('save', { data: { plan: saved } })
  }

  /** 更新已有计划（PUT /deploy/plans/:id）：id 与 created_at 保持不变。 */
  updatePlan(planId, rawInput) {
    const id = String(planId ?? '')
    if (!PLAN_ID_RE.test(id)) throw fail('INVALID_ARGUMENT', `plan id 非法：${id || '(空)'}`)
    const store = readPlansConfig(this.configDir)
    const index = store.plans.findIndex((p) => p.id === id)
    if (index < 0) throw fail('PLAN_UNKNOWN', `计划不存在：${id}`)
    const { plan } = this._normalizePlanInput(rawInput, id)
    const saved = { ...plan, draft: false, id, created_at: store.plans[index].created_at, updated_at: nowIso(this.now()), origin_hint: undefined }
    const plans = [...store.plans]
    plans[index] = saved
    writePlansConfig(this.configDir, plans, this.now())
    return deployEnvelope('save', { data: { plan: saved } })
  }

  deletePlan(planId) {
    const id = String(planId ?? '')
    if (!PLAN_ID_RE.test(id)) throw fail('INVALID_ARGUMENT', `plan id 非法：${id || '(空)'}`)
    const store = readPlansConfig(this.configDir)
    const index = store.plans.findIndex((p) => p.id === id)
    if (index < 0) throw fail('PLAN_UNKNOWN', `计划不存在：${id}`)
    const plans = store.plans.filter((p) => p.id !== id)
    writePlansConfig(this.configDir, plans, this.now())
    return deployEnvelope('delete', { data: { deleted: id, remaining: plans.length } })
  }

  listPlans() {
    const store = readPlansConfig(this.configDir)
    const plans = [...store.plans].sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    return deployEnvelope('plans', {
      data: { schema: DEPLOY_PLAN_SCHEMA, store_file: join(this.configDir, PLAN_STORE_FILE), count: plans.length, plans: plans.map(planSummary) },
    })
  }

  getPlan(planId) {
    const id = String(planId ?? '')
    if (!PLAN_ID_RE.test(id)) throw fail('INVALID_ARGUMENT', `plan id 非法：${id || '(空)'}`)
    const store = readPlansConfig(this.configDir)
    const raw = store.plans.find((p) => p.id === id)
    if (!raw) throw fail('PLAN_UNKNOWN', `计划不存在：${id}`)
    // 旧计划无 component 时读取侧补默认（不回写盘；再次保存会经 validatePlanSpec 落上 component）。
    const plan = { ...raw, component: raw.component ?? DEFAULT_DEPLOY_COMPONENT }
    return deployEnvelope('plan', { data: { plan } })
  }

  /** 保存载荷 → 完整计划对象（env 仍需在 envs.json 且启用：fail-closed，环境被删/停用后旧计划不可覆盖保存）。 */
  _normalizePlanInput(rawInput, planId) {
    if (!rawInput || typeof rawInput !== 'object') throw fail('INVALID_ARGUMENT', '请求体必须是 { plan: … }')
    rejectUnknown(rawInput, ['plan'], 'body')
    const raw = rawInput.plan
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('INVALID_ARGUMENT', 'plan 必须是对象')
    const allowed = planId ? [...SPEC_KEYS, 'steps'] : [...SPEC_KEYS, 'steps']
    rejectUnknown(raw, allowed, 'plan')
    // steps 归 normalizePlanSteps 管：规格校验只看 spec 字段（否则保存载荷恒被 UNKNOWN_FIELD 拒）。
    const { steps: rawSteps, ...specRaw } = raw
    const spec = validatePlanSpec(specRaw, this.getEnv)
    const steps = normalizePlanSteps(rawSteps)
    const plan = {
      schema: DEPLOY_PLAN_SCHEMA,
      title: spec.title,
      env: spec.env,
      component: spec.component,
      candidate: spec.candidate,
      baseline: spec.baseline,
      model: spec.model,
      params: spec.params,
      steps,
      generator: DEPLOY_PLAN_GENERATOR,
      executes: false,
      notes: '计划仅是文本：本插件不执行任何步骤（不 git/不 pip/不启停服务/不跑 benchmark/不连 NPU）。',
    }
    return { plan }
  }
}

// ----------------------------------------------------------------------------------------------
// envelope / 工具 / REST
// ----------------------------------------------------------------------------------------------

function deployEnvelope(kind, { status = 'ok', data = null, error = null, warnings = [] } = {}) {
  return {
    schema: DEPLOY_SCHEMA,
    kind,
    status,
    readonly: true,
    effects: { remote_readonly: true, host_private_write: true, process_mutation: false, benchmark_traffic: false, remote_write: false },
    source: { mode: 'plan-only', executes: false },
    warnings,
    data,
    error,
  }
}

export function deployErrorPayload(error) {
  if (error instanceof TuneApiError) return { code: error.code, message: error.message, retryable: false, details: error.details ?? null }
  return { code: 'INTERNAL_ERROR', message: String(error?.message ?? error).slice(0, 512), retryable: false, details: null }
}

const DEPLOY_TOOL_TIMEOUT_MS = 30_000

export function createDeployTools({ service }) {
  const wrap = (kind, fn) => async (args) => {
    try {
      return fn(args ?? {})
    } catch (error) {
      return deployEnvelope(kind, { status: 'error', error: deployErrorPayload(error) })
    }
  }
  const specProperties = {
    env_id: { type: 'string', description: '目标环境 id（envs.json 中的 env-*，必须存在且启用）' },
    title: { type: 'string', description: '计划标题（可选，默认「环境 · 候选 vs 基线」）' },
    component: { type: 'string', description: `代码组件（基线/候选同组件对照）：${DEPLOY_COMPONENTS.join(' / ')}；可选，默认 ${DEFAULT_DEPLOY_COMPONENT}` },
    candidate: { type: 'object', description: '候选基线：{ ref: 分支/tag（必填）, commit: 7–40 位十六进制（可选，留空取 HEAD） }' },
    baseline: { type: 'object', description: '对照基线：结构同 candidate' },
    model: { type: 'object', description: '{ path: 模型绝对路径, served_name: 服务名（可选，默认取路径末段） }' },
    params: { type: 'object', description: '{ port 1024–65535, tensor_parallel 1–8, max_num_seqs 1–1024, max_num_batched_tokens 128–131072, health_timeout_s 5–3600 }' },
  }
  return [
    {
      name: 'ascend_deploy_plan_generate',
      description: '按「环境 + 候选/基线代码 + 模型与启动参数」生成可编辑的部署计划草稿（占用检查→基线构建/启动/基准→候选切换/基准→对比→归档）。纯本地文本，不执行任何步骤、不连远端。',
      parameters: { type: 'object', properties: specProperties, required: ['env_id', 'candidate', 'baseline', 'model', 'params'], additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: `部署计划草稿 ${value?.data?.plan?.title ?? value?.error?.code ?? 'unknown'}：${value?.data?.plan?.steps?.length ?? 0} 步（未执行）` }] },
      timeoutMs: DEPLOY_TOOL_TIMEOUT_MS,
      execute: wrap('generate', (args) => service.generate(args, { origin: 'tool' })),
    },
    {
      name: 'ascend_deploy_plan_list',
      description: '列出已保存的部署计划（configDir/plans.json）：id、标题、环境、候选/基线、步骤数、更新时间。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: `已保存部署计划 ${value?.data?.count ?? value?.error?.code ?? '?'} 个` }] },
      timeoutMs: DEPLOY_TOOL_TIMEOUT_MS,
      execute: wrap('plans', () => service.listPlans()),
    },
    {
      name: 'ascend_deploy_plan_get',
      description: '按 id 读取一个已保存部署计划的完整内容（含全部步骤）。',
      parameters: { type: 'object', properties: { plan_id: { type: 'string', description: 'plan- 前缀的计划 id' } }, required: ['plan_id'], additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: `部署计划 ${args?.plan_id ?? ''}：${value?.data?.plan?.steps?.length ?? value?.error?.code ?? '?'} 步（未执行）` }] },
      timeoutMs: DEPLOY_TOOL_TIMEOUT_MS,
      execute: wrap('plan', (args) => service.getPlan(args.plan_id)),
    },
    {
      name: 'ascend_deploy_plan_update',
      description: '保存/更新部署计划（编辑步骤、增删、排序后落盘 plans.json，0600 原子写）。plan_id 省略 = 新建；给出 = 更新。环境需仍存在且启用（fail-closed）。仅保存文本，不执行。',
      parameters: { type: 'object', properties: { plan_id: { type: 'string', description: '要更新的计划 id（新建时省略）' }, plan: { type: 'object', description: '计划内容：env_id/title/candidate/baseline/model/params/steps' } }, required: ['plan'], additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: `部署计划已保存：${value?.data?.plan?.id ?? value?.error?.code ?? 'unknown'}（未执行）` }] },
      timeoutMs: DEPLOY_TOOL_TIMEOUT_MS,
      execute: wrap('save', (args) => (args.plan_id ? service.updatePlan(args.plan_id, { plan: args.plan }) : service.createPlan({ plan: args.plan }))),
    },
  ]
}

/** 带 :id 的路由用 pattern 匹配（index.js 挂载层在精确路径失败后回退到 pattern）。 */
export function createDeployRoutes({ service }) {
  const api = (fn) => async (body, query, params) => fn(body ?? {}, query ?? {}, params ?? [])
  const planIdPattern = /^\/deploy\/plans\/(plan-[0-9a-f]{16})$/
  return [
    { path: '/deploy/plans', method: 'GET', handler: api(() => service.listPlans()) },
    {
      path: '/deploy/plans/generate', method: 'POST',
      handler: api((body) => service.generate(body, { origin: 'rest' })),
    },
    { path: '/deploy/plans', method: 'POST', handler: api((body) => service.createPlan(body)) },
    { path: '/deploy/plans/:id', method: 'GET', pattern: planIdPattern, handler: api((_body, _query, params) => service.getPlan(params[0])) },
    { path: '/deploy/plans/:id', method: 'PUT', pattern: planIdPattern, handler: api((body, _query, params) => service.updatePlan(params[0], body)) },
    { path: '/deploy/plans/:id', method: 'DELETE', pattern: planIdPattern, handler: api((_body, _query, params) => service.deletePlan(params[0])) },
  ]
}
