/**
 * 昇腾性能工作台二期 —— 服务配置调优 Host 实现。
 *
 * 覆盖 docs/tuning-design.md 的 MVP 能力：
 * - 规格校验（tune-spec-v1）、grid/random 候选、预算估算、dry-run 计划与命令预览；
 * - demo/local/ssh 执行器抽象（真实执行默认关闭且需授权门）；
 * - 作业/trial 状态机、独立 TuneStore 持久化与恢复；
 * - vLLM bench 指标解析、聚合、SLO 可行性、score、best/Pareto、报告；
 * - 四个 agent tools（ascend_tune_plan / ascend_tune_run / ascend_tune_status / ascend_tune_report）
 *   与 /api/ascend-perf/tuning/* REST 路由。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包；只使用 node 内置模块与同目录 tune-exec.js。
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PortLock, TuneApiError, assertFiniteInRange, assertIntInRange, assertSafeToken, buildBenchArgv, buildServeArgv, realExecutionGate, tuneError } from './tune-exec.js'

export const TUNE_SCHEMA = 'dsh-ascend-perf/tuning-v1'
export const TUNE_SPEC_SCHEMA = 'dsh-ascend-perf/tune-spec-v1'
export const TUNE_PLAN_SCHEMA = 'dsh-ascend-perf/tune-plan-v1'
export const TUNE_STORE_SCHEMA = 'dsh-ascend-perf/tune-store-v1'
export const TUNE_COMPILER_VERSION = 'tune-compiler-v1'
export const TUNE_DEFAULTS_VERSION = '1'

export const TUNE_LIMITS = {
  maxTrials: 128,
  maxInvocations: 512,
  maxJobSeconds: 86400,
  maxSpecBytes: 256 * 1024,
  storeQuotaBytes: 100 * 1024 * 1024,
  maxJobs: 20,
  maxLogBytesPerJob: 10 * 1024 * 1024,
}

export const PLAN_TTL_MS = 24 * 3600 * 1000

const AXIS_ORDER = ['max_num_seqs', 'max_num_batched_tokens', 'gpu_memory_utilization', 'max_model_len']
const SPEC_KEYS = ['schema', 'label', 'executor', 'target_id', 'profile_id', 'model_asset_id', 'dataset_asset_id', 'fixed', 'baseline', 'space', 'workload', 'objective', 'search', 'measurement', 'budget']
const FIXED_KEYS = ['dtype', 'quantization', 'tensor_parallel', 'device_ids', 'served_model_name']
const BASELINE_KEYS = ['max_num_seqs', 'max_num_batched_tokens', 'gpu_memory_utilization', 'max_model_len']
const SPACE_KEYS = ['max_num_seqs', 'max_num_batched_tokens', 'gpu_memory_utilization', 'max_model_len']
const WORKLOAD_KEYS = ['input_len', 'output_len', 'num_prompts', 'max_concurrency', 'request_rate_mode', 'request_rate_rps', 'seed', 'stream', 'ignore_eos']
const OBJECTIVE_KEYS = ['metric', 'direction', 'constraints', 'min_gain_pct', 'noise_floor_pct', 'tie_epsilon_pct']
const CONSTRAINT_KEYS = ['ttft_p99_ms_max', 'tpot_p99_ms_max', 'success_rate_pct_min']
const SEARCH_KEYS = ['method', 'seed', 'max_candidates']
const MEASUREMENT_KEYS = ['warmup_runs', 'repeats', 'confirm_repeats', 'confirm_top_k', 'baseline_check_every', 'baseline_drift_pct_max', 'quantile_policy']
const BUDGET_KEYS = ['max_trials', 'max_bench_invocations', 'max_total_seconds', 'max_total_tokens', 'startup_timeout_s', 'bench_timeout_s', 'shutdown_grace_s', 'cleanup_reserve_s', 'max_failed_trials', 'max_consecutive_failures', 'patience']

/** 逻辑 target/profile/asset 注册表：只接受逻辑 ID，真实路径由 Host 私有配置映射（本期 demo 内置）。 */
export const TUNE_TARGETS = {
  'demo-ascend': { target_id: 'demo-ascend', policy: 'demo', executor: 'demo', label: '演示目标（无 NPU）' },
  'local-sandbox': { target_id: 'local-sandbox', policy: 'readonly', executor: 'local', label: '本机沙盒（未授权）' },
  'ssh-lab': { target_id: 'ssh-lab', policy: 'readonly', executor: 'ssh', label: 'SSH 实验机（未授权）' },
}

export const TUNE_PROFILES = {
  'demo-vllm-v1': {
    profile_id: 'demo-vllm-v1',
    compiler_version: TUNE_COMPILER_VERSION,
    capabilities: ['max-num-seqs', 'max-num-batched-tokens', 'gpu-memory-utilization', 'max-model-len', 'bench-percentiles', 'stream'],
    flags: ['--max-num-seqs', '--max-num-batched-tokens', '--gpu-memory-utilization', '--max-model-len'],
    min_batched_tokens_multiple: 128,
    quantile_unit: 'ms',
    version_verified: false,
    evidence: 'synthetic',
  },
}

export const TUNE_ASSETS = {
  'demo-qwen3-8b': { asset_id: 'demo-qwen3-8b', kind: 'model', sha256: 'demo-model-sha256', bytes: 0, label: 'Qwen3-8B（演示占位）' },
  'synthetic-random-v1': { asset_id: 'synthetic-random-v1', kind: 'dataset', sha256: 'demo-dataset-sha256', bytes: 0, label: '合成随机负载' },
}

const DEFAULT_SPEC = {
  executor: 'demo',
  target_id: 'demo-ascend',
  profile_id: 'demo-vllm-v1',
  model_asset_id: 'demo-qwen3-8b',
  dataset_asset_id: 'synthetic-random-v1',
  fixed: { dtype: 'bfloat16', quantization: 'none', tensor_parallel: 1, device_ids: [0], served_model_name: 'tune-model' },
  baseline: { max_num_seqs: 16, max_num_batched_tokens: 2048, gpu_memory_utilization: 0.85, max_model_len: 4096 },
  workload: { input_len: 512, output_len: 128, num_prompts: 1000, max_concurrency: 32, request_rate_mode: 'unbounded', request_rate_rps: null, seed: 42, stream: true, ignore_eos: true },
  objective: { metric: 'output_throughput_tps', direction: 'higher', constraints: { ttft_p99_ms_max: 800, tpot_p99_ms_max: 60, success_rate_pct_min: 99 }, min_gain_pct: 3, noise_floor_pct: 2, tie_epsilon_pct: 1 },
  search: { method: 'grid', seed: 42, max_candidates: 3 },
  measurement: { warmup_runs: 1, repeats: 3, confirm_repeats: 2, confirm_top_k: 1, baseline_check_every: 3, baseline_drift_pct_max: 5, quantile_policy: 'worst_repeat_p99' },
  budget: { max_trials: 12, max_bench_invocations: 64, max_total_seconds: 3600, max_total_tokens: 50000000, startup_timeout_s: 180, bench_timeout_s: 90, shutdown_grace_s: 10, cleanup_reserve_s: 30, max_failed_trials: 2, max_consecutive_failures: 2, patience: 6 },
}

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

function nowIso() {
  return new Date().toISOString()
}

function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
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

function pickNumber(raw, key, fallback, min, max, where) {
  const value = raw?.[key] ?? fallback
  return assertFiniteInRange(value, `${where}.${key}`, min, max)
}

function pickInt(raw, key, fallback, min, max, where) {
  const value = raw?.[key] ?? fallback
  return assertIntInRange(value, `${where}.${key}`, min, max)
}

function normalizeAxisValues(values, key, { min, max, multiple = null, integer = true }) {
  if (!Array.isArray(values) || values.length === 0) throw fail('INVALID_SPEC', `space.${key} 必须是非空数组`)
  if (values.length > 16) throw fail('SPACE_TOO_LARGE', `space.${key} 最多 16 个值`)
  const seen = new Set()
  const out = []
  for (const item of values) {
    const value = integer ? assertIntInRange(item, `space.${key}`, min, max) : assertFiniteInRange(item, `space.${key}`, min, max)
    if (multiple && value % multiple !== 0) throw fail('INVALID_SPEC', `space.${key} 必须是 ${multiple} 的倍数`)
    const rounded = Number(value.toFixed(2))
    if (seen.has(rounded)) continue
    seen.add(rounded)
    out.push(rounded)
  }
  return out.sort((a, b) => a - b)
}

function normalizeParams(raw, where, defaults) {
  const params = raw ?? defaults
  rejectUnknown(params, BASELINE_KEYS, where)
  const maxNumSeqs = assertIntInRange(params.max_num_seqs ?? defaults.max_num_seqs, `${where}.max_num_seqs`, 1, 1024)
  const maxNumBatched = assertIntInRange(params.max_num_batched_tokens ?? defaults.max_num_batched_tokens, `${where}.max_num_batched_tokens`, 128, 131072)
  const gpuMem = assertFiniteInRange(params.gpu_memory_utilization ?? defaults.gpu_memory_utilization, `${where}.gpu_memory_utilization`, 0.1, 0.95)
  const maxModelLen = assertIntInRange(params.max_model_len ?? defaults.max_model_len, `${where}.max_model_len`, 256, 131072)
  return { max_num_seqs: maxNumSeqs, max_num_batched_tokens: maxNumBatched, gpu_memory_utilization: Number(gpuMem.toFixed(2)), max_model_len: maxModelLen }
}

/** 校验并规范化调优规格；未知字段、越界值、非法组合都在这里拒绝。 */
export function normalizeTuneSpec(raw, { limits = TUNE_LIMITS } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('INVALID_SPEC', 'spec 必须是对象')
  const text = canonicalJson(raw)
  if (Buffer.byteLength(text) > limits.maxSpecBytes) throw fail('SPACE_TOO_LARGE', 'spec 超过 256 KiB')
  rejectUnknown(raw, SPEC_KEYS, 'spec')
  if (raw.schema && raw.schema !== TUNE_SPEC_SCHEMA) throw fail('INVALID_SPEC', `spec.schema 必须是 ${TUNE_SPEC_SCHEMA}`)

  const executor = raw.executor ?? DEFAULT_SPEC.executor
  if (!['demo', 'local', 'ssh'].includes(executor)) throw fail('INVALID_SPEC', 'executor 必须是 demo/local/ssh')
  const targetId = raw.target_id ?? DEFAULT_SPEC.target_id
  const target = TUNE_TARGETS[targetId]
  if (!target) throw fail('ASSET_UNKNOWN', `未知 target_id：${targetId}`)
  const profileId = raw.profile_id ?? DEFAULT_SPEC.profile_id
  const profile = TUNE_PROFILES[profileId]
  if (!profile) throw fail('PROFILE_UNSUPPORTED', `未知 profile_id：${profileId}`)
  const modelAssetId = raw.model_asset_id ?? DEFAULT_SPEC.model_asset_id
  const datasetAssetId = raw.dataset_asset_id ?? DEFAULT_SPEC.dataset_asset_id
  if (!TUNE_ASSETS[modelAssetId]) throw fail('ASSET_UNKNOWN', `未知 model_asset_id：${modelAssetId}`)
  if (!TUNE_ASSETS[datasetAssetId]) throw fail('ASSET_UNKNOWN', `未知 dataset_asset_id：${datasetAssetId}`)

  // fixed
  const fixedRaw = raw.fixed ?? {}
  rejectUnknown(fixedRaw, FIXED_KEYS, 'fixed')
  const deviceIds = Array.isArray(fixedRaw.device_ids ?? DEFAULT_SPEC.fixed.device_ids)
    ? (fixedRaw.device_ids ?? DEFAULT_SPEC.fixed.device_ids).map((v, index) => assertIntInRange(v, `fixed.device_ids[${index}]`, 0, 1023))
    : null
  if (!deviceIds || deviceIds.length === 0) throw fail('INVALID_SPEC', 'fixed.device_ids 必须是非空整数数组')
  const uniqueDevices = [...new Set(deviceIds)]
  if (uniqueDevices.length !== deviceIds.length) throw fail('INVALID_SPEC', 'fixed.device_ids 不能重复')
  const tensorParallel = assertIntInRange(fixedRaw.tensor_parallel ?? DEFAULT_SPEC.fixed.tensor_parallel, 'fixed.tensor_parallel', 1, 64)
  if (uniqueDevices.length !== tensorParallel) throw fail('INVALID_SPEC', 'device_ids 数量必须等于 tensor_parallel')
  const fixed = {
    dtype: assertSafeToken(fixedRaw.dtype ?? DEFAULT_SPEC.fixed.dtype, 'fixed.dtype'),
    quantization: assertSafeToken(fixedRaw.quantization ?? DEFAULT_SPEC.fixed.quantization, 'fixed.quantization'),
    tensor_parallel: tensorParallel,
    device_ids: uniqueDevices,
    served_model_name: assertSafeToken(fixedRaw.served_model_name ?? DEFAULT_SPEC.fixed.served_model_name, 'fixed.served_model_name'),
  }

  // workload（先规范化，baseline.max_model_len 依赖 input/output）
  const workloadRaw = raw.workload ?? {}
  rejectUnknown(workloadRaw, WORKLOAD_KEYS, 'workload')
  const inputLen = assertIntInRange(workloadRaw.input_len ?? DEFAULT_SPEC.workload.input_len, 'workload.input_len', 1, 131072)
  const outputLen = assertIntInRange(workloadRaw.output_len ?? DEFAULT_SPEC.workload.output_len, 'workload.output_len', 2, 65536)
  const numPrompts = assertIntInRange(workloadRaw.num_prompts ?? DEFAULT_SPEC.workload.num_prompts, 'workload.num_prompts', 1000, 10000)
  const maxConcurrency = assertIntInRange(workloadRaw.max_concurrency ?? DEFAULT_SPEC.workload.max_concurrency, 'workload.max_concurrency', 1, 1024)
  const rateMode = workloadRaw.request_rate_mode ?? DEFAULT_SPEC.workload.request_rate_mode
  if (!['finite', 'unbounded', 'unknown'].includes(rateMode)) throw fail('INVALID_SPEC', 'request_rate_mode 必须是 finite/unbounded/unknown')
  if (rateMode === 'unknown') throw fail('INVALID_SPEC', 'request_rate_mode=unknown 不允许执行')
  const rate = rateMode === 'finite'
    ? assertFiniteInRange(workloadRaw.request_rate_rps, 'workload.request_rate_rps', 0.0001, 10000)
    : null
  const workload = {
    input_len: inputLen,
    output_len: outputLen,
    num_prompts: numPrompts,
    max_concurrency: maxConcurrency,
    request_rate_mode: rateMode,
    request_rate_rps: rate === null ? null : Number(rate.toFixed(3)),
    seed: assertIntInRange(workloadRaw.seed ?? DEFAULT_SPEC.workload.seed, 'workload.seed', 0, 4294967295),
    stream: workloadRaw.stream ?? DEFAULT_SPEC.workload.stream,
    ignore_eos: workloadRaw.ignore_eos ?? DEFAULT_SPEC.workload.ignore_eos,
  }
  if (typeof workload.stream !== 'boolean' || typeof workload.ignore_eos !== 'boolean') throw fail('INVALID_SPEC', 'workload.stream/ignore_eos 必须是布尔值')
  if (!workload.stream) throw fail('INVALID_SPEC', 'workload.stream=false 无法获得 TTFT/TPOT')
  if (!workload.ignore_eos) throw fail('INVALID_SPEC', 'workload.ignore_eos=false 会破坏固定输出长度')

  // baseline
  const baseline = normalizeParams(raw.baseline, 'baseline', DEFAULT_SPEC.baseline)
  if (baseline.max_model_len < workload.input_len + workload.output_len) {
    throw fail('INVALID_SPEC', 'baseline.max_model_len 必须 ≥ input_len + output_len')
  }

  // space
  const spaceRaw = raw.space
  if (!spaceRaw || typeof spaceRaw !== 'object') throw fail('INVALID_SPEC', 'space 必须给出两个必须轴')
  rejectUnknown(spaceRaw, SPACE_KEYS, 'space')
  const space = {}
  space.max_num_seqs = normalizeAxisValues(spaceRaw.max_num_seqs, 'max_num_seqs', { min: 1, max: 1024 })
  space.max_num_batched_tokens = normalizeAxisValues(spaceRaw.max_num_batched_tokens, 'max_num_batched_tokens', { min: 128, max: 131072, multiple: profile.min_batched_tokens_multiple })
  for (const optional of ['gpu_memory_utilization', 'max_model_len']) {
    if (spaceRaw[optional] === undefined || spaceRaw[optional] === null) continue
    space[optional] = normalizeAxisValues(spaceRaw[optional], optional, optional === 'gpu_memory_utilization' ? { min: 0.1, max: 0.95, integer: false } : { min: 256, max: 131072 })
  }
  let cartesian = 1
  for (const axis of AXIS_ORDER) cartesian *= space[axis]?.length ?? 1
  if (cartesian > 4096) throw fail('SPACE_TOO_LARGE', `搜索空间 ${cartesian} 个组合超过 4096，请先缩小空间`)
  for (const modelLen of space.max_model_len ?? []) {
    if (modelLen < workload.input_len + workload.output_len) throw fail('INVALID_SPEC', 'space.max_model_len 存在小于 input_len+output_len 的值')
  }

  // objective
  const objectiveRaw = raw.objective ?? {}
  rejectUnknown(objectiveRaw, OBJECTIVE_KEYS, 'objective')
  const constraintsRaw = objectiveRaw.constraints
  if (!constraintsRaw || typeof constraintsRaw !== 'object') throw fail('INVALID_SPEC', 'objective.constraints 必须给出三项 SLO')
  rejectUnknown(constraintsRaw, CONSTRAINT_KEYS, 'objective.constraints')
  const constraints = {
    ttft_p99_ms_max: assertFiniteInRange(constraintsRaw.ttft_p99_ms_max, 'objective.constraints.ttft_p99_ms_max', 0.1, 1000000),
    tpot_p99_ms_max: assertFiniteInRange(constraintsRaw.tpot_p99_ms_max, 'objective.constraints.tpot_p99_ms_max', 0.1, 1000000),
    success_rate_pct_min: assertFiniteInRange(constraintsRaw.success_rate_pct_min, 'objective.constraints.success_rate_pct_min', 0, 100),
  }
  const objective = {
    metric: 'output_throughput_tps',
    direction: 'higher',
    constraints,
    min_gain_pct: pickNumber(objectiveRaw, 'min_gain_pct', DEFAULT_SPEC.objective.min_gain_pct, 0, 100, 'objective'),
    noise_floor_pct: pickNumber(objectiveRaw, 'noise_floor_pct', DEFAULT_SPEC.objective.noise_floor_pct, 0, 20, 'objective'),
    tie_epsilon_pct: pickNumber(objectiveRaw, 'tie_epsilon_pct', DEFAULT_SPEC.objective.tie_epsilon_pct, 0, 20, 'objective'),
  }
  if (objectiveRaw.metric && objectiveRaw.metric !== 'output_throughput_tps') throw fail('INVALID_SPEC', 'v1 只支持 output_throughput_tps 单目标')
  if (objectiveRaw.direction && objectiveRaw.direction !== 'higher') throw fail('INVALID_SPEC', 'v1 只支持 higher 方向')

  // search
  const searchRaw = raw.search ?? {}
  rejectUnknown(searchRaw, SEARCH_KEYS, 'search')
  const method = searchRaw.method ?? DEFAULT_SPEC.search.method
  if (!['grid', 'random'].includes(method)) throw fail('INVALID_SPEC', 'search.method 必须是 grid/random')
  const search = {
    method,
    seed: assertIntInRange(searchRaw.seed ?? DEFAULT_SPEC.search.seed, 'search.seed', 0, 4294967295),
    max_candidates: pickInt(searchRaw, 'max_candidates', DEFAULT_SPEC.search.max_candidates, 1, 64, 'search'),
  }

  // measurement
  const measurementRaw = raw.measurement ?? {}
  rejectUnknown(measurementRaw, MEASUREMENT_KEYS, 'measurement')
  const measurement = {
    warmup_runs: pickInt(measurementRaw, 'warmup_runs', DEFAULT_SPEC.measurement.warmup_runs, 1, 3, 'measurement'),
    repeats: pickInt(measurementRaw, 'repeats', DEFAULT_SPEC.measurement.repeats, 3, 10, 'measurement'),
    confirm_repeats: pickInt(measurementRaw, 'confirm_repeats', DEFAULT_SPEC.measurement.confirm_repeats, 2, 10, 'measurement'),
    confirm_top_k: pickInt(measurementRaw, 'confirm_top_k', DEFAULT_SPEC.measurement.confirm_top_k, 1, 3, 'measurement'),
    baseline_check_every: pickInt(measurementRaw, 'baseline_check_every', DEFAULT_SPEC.measurement.baseline_check_every, 1, 10, 'measurement'),
    baseline_drift_pct_max: pickNumber(measurementRaw, 'baseline_drift_pct_max', DEFAULT_SPEC.measurement.baseline_drift_pct_max, 0.1, 50, 'measurement'),
    quantile_policy: 'worst_repeat_p99',
  }

  // budget（只能收紧，不能突破 Host 硬上限）
  const budgetRaw = raw.budget ?? {}
  rejectUnknown(budgetRaw, BUDGET_KEYS, 'budget')
  const budget = {
    max_trials: pickInt(budgetRaw, 'max_trials', DEFAULT_SPEC.budget.max_trials, 1, limits.maxTrials, 'budget'),
    max_bench_invocations: pickInt(budgetRaw, 'max_bench_invocations', DEFAULT_SPEC.budget.max_bench_invocations, 1, limits.maxInvocations, 'budget'),
    max_total_seconds: pickInt(budgetRaw, 'max_total_seconds', DEFAULT_SPEC.budget.max_total_seconds, 60, limits.maxJobSeconds, 'budget'),
    max_total_tokens: pickInt(budgetRaw, 'max_total_tokens', DEFAULT_SPEC.budget.max_total_tokens, 1, 1000000000, 'budget'),
    startup_timeout_s: pickInt(budgetRaw, 'startup_timeout_s', DEFAULT_SPEC.budget.startup_timeout_s, 10, 1800, 'budget'),
    bench_timeout_s: pickInt(budgetRaw, 'bench_timeout_s', DEFAULT_SPEC.budget.bench_timeout_s, 5, 1800, 'budget'),
    shutdown_grace_s: pickInt(budgetRaw, 'shutdown_grace_s', DEFAULT_SPEC.budget.shutdown_grace_s, 1, 60, 'budget'),
    cleanup_reserve_s: pickInt(budgetRaw, 'cleanup_reserve_s', DEFAULT_SPEC.budget.cleanup_reserve_s, 10, 120, 'budget'),
    max_failed_trials: pickInt(budgetRaw, 'max_failed_trials', DEFAULT_SPEC.budget.max_failed_trials, 1, 128, 'budget'),
    max_consecutive_failures: pickInt(budgetRaw, 'max_consecutive_failures', DEFAULT_SPEC.budget.max_consecutive_failures, 1, 128, 'budget'),
    patience: pickInt(budgetRaw, 'patience', DEFAULT_SPEC.budget.patience, 1, 64, 'budget'),
  }
  if (budget.max_total_tokens < (workload.input_len + workload.output_len) * workload.num_prompts) {
    throw fail('INVALID_SPEC', 'max_total_tokens 不足以完成一次 bench 的请求预算')
  }

  return {
    schema: TUNE_SPEC_SCHEMA,
    label: typeof raw.label === 'string' ? raw.label.slice(0, 120) : null,
    executor,
    target_id: targetId,
    profile_id: profileId,
    model_asset_id: modelAssetId,
    dataset_asset_id: datasetAssetId,
    fixed,
    baseline,
    space,
    workload,
    objective,
    search,
    measurement,
    budget,
    target_policy: target.policy,
  }
}

function xorshift32(seed) {
  let state = seed >>> 0
  if (state === 0) state = 0x6d2b79f5
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state >>> 0
  }
}

function expandSpace(spec) {
  const axes = AXIS_ORDER.filter((axis) => spec.space[axis]?.length)
  let combos = [{}]
  for (const axis of axes) {
    const next = []
    for (const combo of combos) for (const value of spec.space[axis]) next.push({ ...combo, [axis]: value })
    combos = next
  }
  return combos.map((combo) => ({
    max_num_seqs: combo.max_num_seqs ?? spec.baseline.max_num_seqs,
    max_num_batched_tokens: combo.max_num_batched_tokens ?? spec.baseline.max_num_batched_tokens,
    gpu_memory_utilization: combo.gpu_memory_utilization ?? spec.baseline.gpu_memory_utilization,
    max_model_len: combo.max_model_len ?? spec.baseline.max_model_len,
  }))
}

export function paramsHash(params) {
  return sha256(canonicalJson({
    max_num_seqs: params.max_num_seqs,
    max_num_batched_tokens: params.max_num_batched_tokens,
    gpu_memory_utilization: params.gpu_memory_utilization,
    max_model_len: params.max_model_len,
  })).slice(0, 16)
}

export function specHash(spec) {
  const copy = { ...spec }
  delete copy.target_policy
  return sha256(canonicalJson(copy))
}

export function executionFingerprint(spec) {
  return sha256(canonicalJson({
    model: spec.model_asset_id,
    dataset: spec.dataset_asset_id,
    input_len: spec.workload.input_len,
    output_len: spec.workload.output_len,
    num_prompts: spec.workload.num_prompts,
    concurrency: spec.workload.max_concurrency,
    rate_mode: spec.workload.request_rate_mode,
    rate: spec.workload.request_rate_rps,
    seed: spec.workload.seed,
    stream: spec.workload.stream,
    ignore_eos: spec.workload.ignore_eos,
    dtype: spec.fixed.dtype,
    quantization: spec.fixed.quantization,
    tp: spec.fixed.tensor_parallel,
    devices: spec.fixed.device_ids,
    profile: spec.profile_id,
  }))
}

/** 估算预算（与 t7 §3.3 的口径一致：trial 批次与 bench invocations 分开列示）。 */
export function estimateBudget(spec, candidateCount, prunedCount) {
  const m = spec.measurement
  const b = spec.budget
  const checkpoints = Math.min(candidateCount, Math.floor(candidateCount / m.baseline_check_every))
  const trialBatches = 1 + candidateCount + checkpoints + 2
  const warmupInvocations = m.warmup_runs * trialBatches
  const measuredInvocations = m.repeats * (1 + candidateCount + checkpoints) + m.confirm_repeats * 2
  const benchInvocations = warmupInvocations + measuredInvocations
  const maxRequests = spec.workload.num_prompts * benchInvocations
  const reservedTokens = (spec.workload.input_len + spec.workload.output_len) * maxRequests
  const timeoutUpper = trialBatches * b.startup_timeout_s + benchInvocations * b.bench_timeout_s + trialBatches * b.shutdown_grace_s + b.cleanup_reserve_s
  const overTrials = trialBatches > b.max_trials
  const overInvocations = benchInvocations > b.max_bench_invocations
  const overTokens = reservedTokens > b.max_total_tokens
  const overTime = timeoutUpper > b.max_total_seconds
  const fit = overTrials || overInvocations || overTokens ? 'no' : overTime ? 'partial' : 'yes'
  const warnings = []
  if (overTrials) warnings.push(`trial 批次 ${trialBatches} 超过 max_trials ${b.max_trials}`)
  if (overInvocations) warnings.push(`bench 调用 ${benchInvocations} 超过 max_bench_invocations ${b.max_bench_invocations}`)
  if (overTokens) warnings.push(`预留 token ${reservedTokens} 超过 max_total_tokens ${b.max_total_tokens}`)
  if (overTime) warnings.push(`超时上界 ${timeoutUpper}s 超过 max_total_seconds ${b.max_total_seconds}（非承诺时长）`)
  return {
    candidate_count: candidateCount,
    pruned_count: prunedCount,
    trial_batches: trialBatches,
    bench_invocations: benchInvocations,
    warmup_invocations: warmupInvocations,
    measured_invocations: measuredInvocations,
    max_requests: maxRequests,
    reserved_tokens: reservedTokens,
    timeout_upper_bound_s: timeoutUpper,
    configured_deadline_s: b.max_total_seconds,
    cleanup_reserve_s: b.cleanup_reserve_s,
    fit,
    warnings,
  }
}

/** 生成计划：纯本地计算，不连接/启动任何目标。 */
export function buildTunePlan(spec, { now = Date.now(), ports = [8000] } = {}) {
  const all = expandSpace(spec)
  const baselineKey = canonicalJson(spec.baseline)
  const pruned = []
  const seen = new Set()
  const valid = []
  for (const params of all) {
    const key = canonicalJson(params)
    if (seen.has(key)) {
      pruned.push({ params, reason: 'DUPLICATE_COMBO' })
      continue
    }
    seen.add(key)
    const reasons = []
    if (params.max_num_batched_tokens % (TUNE_PROFILES[spec.profile_id]?.min_batched_tokens_multiple ?? 1) !== 0) reasons.push('BATCHED_TOKENS_NOT_MULTIPLE_128')
    if (params.max_model_len < spec.workload.input_len + spec.workload.output_len) reasons.push('MODEL_LEN_TOO_SMALL')
    if (reasons.length) {
      pruned.push({ params, reason: reasons.join(',') })
      continue
    }
    if (key === baselineKey) {
      pruned.push({ params, reason: 'BASELINE_DUPLICATE' })
      continue
    }
    valid.push(params)
  }
  let candidates
  if (spec.search.method === 'random') {
    const rand = xorshift32(spec.search.seed)
    const shuffled = valid.slice()
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = rand() % (i + 1)
      const tmp = shuffled[i]
      shuffled[i] = shuffled[j]
      shuffled[j] = tmp
    }
    candidates = shuffled.slice(0, spec.search.max_candidates)
  } else {
    candidates = valid.slice(0, spec.search.max_candidates)
  }
  const candidateList = candidates.map((params, index) => ({ candidate_id: `cand_${String(index + 1).padStart(3, '0')}`, params }))
  const sh = specHash(spec)
  const assets = {
    model: TUNE_ASSETS[spec.model_asset_id]?.sha256 ?? 'unknown',
    dataset: TUNE_ASSETS[spec.dataset_asset_id]?.sha256 ?? 'unknown',
  }
  const execFp = executionFingerprint(spec)
  const profile = TUNE_PROFILES[spec.profile_id]
  const budget = estimateBudget(spec, candidateList.length, pruned.length)
  const commandsPreview = []
  const redactedServedModel = spec.fixed.served_model_name
  for (const candidate of candidateList.slice(0, 4)) {
    commandsPreview.push({
      step: `serve:${candidate.candidate_id}`,
      template_id: 'serve-v1',
      argv_redacted: buildServeArgv({
        pythonAbs: '/opt/demo/bin/python',
        modelAbs: `<asset:${spec.model_asset_id}>`,
        servedModelName: redactedServedModel,
        port: ports[0] ?? 8000,
        tensorParallel: spec.fixed.tensor_parallel,
        dtype: spec.fixed.dtype,
        quantization: spec.fixed.quantization,
        params: candidate.params,
      }),
    })
  }
  commandsPreview.push({
    step: 'bench',
    template_id: 'bench-v1',
    argv_redacted: buildBenchArgv({
      vllmAbs: '/opt/demo/bin/vllm',
      baseUrl: `http://127.0.0.1:${ports[0] ?? 8000}`,
      model: redactedServedModel,
      inputLen: spec.workload.input_len,
      outputLen: spec.workload.output_len,
      numPrompts: spec.workload.num_prompts,
      concurrency: spec.workload.max_concurrency,
      rateLiteral: spec.workload.request_rate_mode === 'unbounded' ? 'inf' : spec.workload.request_rate_rps,
      seed: spec.workload.seed,
      resultDir: '<sandbox>/results',
      resultName: 'bench.json',
    }),
  })
  const effectManifest = {
    target_id: spec.target_id,
    executor: spec.executor,
    model_asset_id: spec.model_asset_id,
    device_ids: spec.fixed.device_ids,
    ports,
    sandbox_id: spec.executor === 'demo' ? 'demo-sandbox' : null,
    start_service: spec.executor !== 'demo',
    health_requests: spec.executor !== 'demo' ? 1 : 0,
    benchmark_requests: candidateList.length,
    stop_owned_processes: spec.executor !== 'demo',
    write_sandbox: spec.executor !== 'demo',
    cleanup_owned_files: spec.executor !== 'demo',
    max_duration_s: spec.budget.max_total_seconds,
    max_requests: budget.max_requests,
    max_tokens: budget.reserved_tokens,
    compiled_template_hashes: [sha256(commandsPreview.map((c) => c.argv_redacted.join(' ')).join('\n')).slice(0, 16)],
  }
  const blockers = []
  if (spec.executor !== 'demo') {
    if (spec.executor === 'ssh') blockers.push({ code: 'AUTH_BRIDGE_UNAVAILABLE', field: 'executor', message: '当前 Harness 无可验证的用户授权桥，SSH 真实执行保持关闭' })
    else blockers.push({ code: 'REAL_EXECUTION_DISABLED', field: 'executor', message: '本机构建默认关闭真实执行器；仅 demo 可完整运行' })
    blockers.push({ code: 'TARGET_READONLY', field: 'target_id', message: `目标 ${spec.target_id} policy=${TUNE_TARGETS[spec.target_id]?.policy ?? 'readonly'}，不允许启停服务/压测` })
  }
  if (budget.fit === 'no') blockers.push({ code: 'BUDGET_EXCEEDED', field: 'budget', message: '预算不足以完成计划中的全部 trial' })
  const planCore = {
    schema: TUNE_PLAN_SCHEMA,
    plan_id: id('plan'),
    compiler_version: profile?.compiler_version ?? TUNE_COMPILER_VERSION,
    executor: spec.executor,
    target_id: spec.target_id,
    target_policy: spec.target_policy,
    spec,
    spec_hash: sh,
    execution_fingerprint: execFp,
    assets_fingerprint: assets,
    environment_fingerprint: spec.executor === 'demo' ? 'demo-env-sha256' : null,
    candidates: candidateList,
    pruned,
    commands_preview: commandsPreview,
    effect_manifest: effectManifest,
    budget_estimate: budget,
    blockers,
    target_policy: spec.target_policy,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + PLAN_TTL_MS).toISOString(),
  }
  const planHash = sha256(canonicalJson({
    spec_hash: sh,
    candidates: candidateList,
    compiler_version: planCore.compiler_version,
    assets_fingerprint: assets,
    environment_fingerprint: planCore.environment_fingerprint,
    execution_fingerprint: execFp,
    ports,
    effect_manifest: effectManifest,
    template_hash: effectManifest.compiled_template_hashes[0],
  }))
  return { ...planCore, plan_hash: planHash }
}

// ============================================================================================
// 指标解析 / 聚合 / 排序 / 报告
// ============================================================================================

const METRIC_META = {
  request_throughput_rps: ['req/s', 'higher'],
  output_throughput_tps: ['token/s', 'higher'],
  total_throughput_tps: ['token/s', 'higher'],
  ttft_p50_ms: ['ms', 'lower'],
  ttft_p99_ms: ['ms', 'lower'],
  tpot_p50_ms: ['ms', 'lower'],
  tpot_p99_ms: ['ms', 'lower'],
  itl_p50_ms: ['ms', 'lower'],
  itl_p99_ms: ['ms', 'lower'],
  success_rate_pct: ['%', 'higher'],
}

function metric(value, key) {
  const [unit, direction] = METRIC_META[key]
  return { value: value == null || !Number.isFinite(value) ? null : zz(value), unit, direction }
}

function numFrom(obj, names) {
  for (const name of names) {
    const value = obj?.[name]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return null
}

function parseCsvLoose(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 2) throw fail('INVALID_METRICS', 'CSV 至少需要表头与一行数据')
  const split = (line) => {
    const cells = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cell += '"'
          i += 1
        } else if (ch === '"') quoted = false
        else cell += ch
      } else if (ch === '"') quoted = true
      else if (ch === ',') {
        cells.push(cell.trim())
        cell = ''
      } else cell += ch
    }
    cells.push(cell.trim())
    return cells
  }
  const header = split(lines[0])
  const values = split(lines[1])
  const row = {}
  header.forEach((key, index) => {
    row[key] = values[index] ?? ''
  })
  return row
}

/** 解析 vLLM bench 输出（JSON 或 CSV），返回归一化指标；不可识别时抛 INVALID_METRICS。 */
export function parseBenchOutput(text, { maxBytes = 1024 * 1024 } = {}) {
  if (typeof text !== 'string') throw fail('INVALID_METRICS', 'bench 输出必须是文本')
  if (Buffer.byteLength(text) > maxBytes) throw fail('INVALID_METRICS', 'bench 输出超过 1 MiB')
  const trimmed = text.trim()
  if (!trimmed) throw fail('INVALID_METRICS', 'bench 输出为空')
  let obj
  let format = 'json'
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw fail('INVALID_METRICS', `bench JSON 解析失败：${error.message}`)
    }
    obj = Array.isArray(parsed) ? parsed[0] : parsed
    if (!obj || typeof obj !== 'object') throw fail('INVALID_METRICS', 'bench JSON 顶层必须是对象')
  } else {
    format = 'csv'
    obj = parseCsvLoose(trimmed)
  }
  const duration = numFrom(obj, ['duration', 'duration_s', 'elapsed_s'])
  const numPrompts = numFrom(obj, ['num_prompts', 'request_count'])
  const completed = numFrom(obj, ['completed', 'completed_requests', 'num_requests_successful'])
  const totalOutput = numFrom(obj, ['total_output_tokens', 'output_tokens_total'])
  const totalInput = numFrom(obj, ['total_input_tokens', 'input_tokens_total'])
  const metrics = {}
  let outputTps = numFrom(obj, ['output_throughput', 'output_throughput_tps', 'output_tokens_per_second'])
  if (outputTps == null && totalOutput != null && duration) outputTps = totalOutput / duration
  let requestTps = numFrom(obj, ['request_throughput', 'request_throughput_rps', 'requests_per_second'])
  if (requestTps == null && completed != null && duration) requestTps = completed / duration
  let totalTps = numFrom(obj, ['total_token_throughput', 'total_throughput_tps'])
  if (totalTps == null && totalOutput != null && totalInput != null && duration) totalTps = (totalOutput + totalInput) / duration
  let successRate = numFrom(obj, ['success_rate_pct', 'success_rate'])
  if (successRate != null && successRate <= 1 && !('success_rate_pct' in obj)) successRate *= 100
  if (successRate == null && numPrompts) successRate = ((completed ?? numPrompts) / numPrompts) * 100

  const ttft50 = numFrom(obj, ['median_ttft_ms', 'p50_ttft_ms', 'ttft_p50_ms'])
  const ttft99 = numFrom(obj, ['p99_ttft_ms', 'ttft_p99_ms', 'p99_ttft'])
  const tpot50 = numFrom(obj, ['median_tpot_ms', 'p50_tpot_ms', 'tpot_p50_ms'])
  const tpot99 = numFrom(obj, ['p99_tpot_ms', 'tpot_p99_ms', 'p99_tpot'])
  const itl50 = numFrom(obj, ['median_itl_ms', 'p50_itl_ms', 'itl_p50_ms'])
  const itl99 = numFrom(obj, ['p99_itl_ms', 'itl_p99_ms', 'p99_itl'])

  if (ttft99 == null && ttft50 == null) throw fail('INVALID_METRICS', '缺少 TTFT 字段（median_ttft_ms / p99_ttft_ms）')
  if (ttft99 == null) throw fail('INVALID_METRICS', '缺少 p99 TTFT 字段（p99_ttft_ms），无法做 SLO 判定')
  if (tpot99 == null && tpot50 == null) throw fail('INVALID_METRICS', '缺少 TPOT 字段（median_tpot_ms / p99_tpot_ms）')
  if (outputTps == null && requestTps == null) throw fail('INVALID_METRICS', '缺少吞吐字段（output_throughput 或 request_throughput）')
  if (successRate == null) throw fail('INVALID_METRICS', '缺少成功率字段（success_rate_pct / completed + num_prompts）')

  const check = (key, value, min, max) => {
    if (value == null) return null
    if (!Number.isFinite(value) || value < min || value > max) throw fail('INVALID_METRICS', `指标 ${key} 越界：${value}`)
    metrics[key] = metric(value, key)
    return value
  }
  check('request_throughput_rps', requestTps, 0, 1e7)
  check('output_throughput_tps', outputTps, 0.0001, 1e7)
  check('total_throughput_tps', totalTps, 0, 1e7)
  check('ttft_p50_ms', ttft50, 0.0001, 1e7)
  check('ttft_p99_ms', ttft99, 0.0001, 1e7)
  check('tpot_p50_ms', tpot50, 0.0001, 1e7)
  check('tpot_p99_ms', tpot99, 0.0001, 1e7)
  check('itl_p50_ms', itl50, 0, 1e7)
  check('itl_p99_ms', itl99, 0, 1e7)
  check('success_rate_pct', successRate, 0, 100)
  if (metrics.ttft_p99_ms && metrics.ttft_p50_ms && metrics.ttft_p99_ms.value < metrics.ttft_p50_ms.value) {
    throw fail('INVALID_METRICS', 'p99 TTFT 小于 p50 TTFT，数据不可信')
  }
  const warnings = []
  if (duration == null) warnings.push('bench 输出缺少 duration 字段；未做吞吐交叉校验')
  return { format, metrics, raw_field_count: Object.keys(obj).length, warnings }
}

const SLO_KEYS = ['ttft_p99_ms_max', 'tpot_p99_ms_max', 'success_rate_pct_min']

function slopeOf(values) {
  if (values.length < 2) return 0
  const first = Number(values[0])
  const last = Number(values[values.length - 1])
  return !Number.isFinite(first) || !Number.isFinite(last) ? 0 : last - first
}

function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (!nums.length) return null
  const mid = Math.floor(nums.length / 2)
  return nums.length % 2 ? nums[mid] : Number(((nums[mid - 1] + nums[mid]) / 2).toFixed(4))
}

/** 聚合重复测量的最差 p99、中位吞吐、噪声与 SLO 可行性。 */
export function aggregateRepeats(samples, { constraints, noiseFloorPct = 2, quantilePolicy = 'worst_repeat_p99' } = {}) {
  if (!Array.isArray(samples) || samples.length === 0) throw fail('INVALID_METRICS', '没有可聚合的样本')
  const pick = (key) => samples.map((sample) => sample?.metrics?.[key]?.value).filter((v) => typeof v === 'number' && Number.isFinite(v))
  const throughputs = pick('output_throughput_tps')
  if (!throughputs.length) throw fail('INVALID_METRICS', '样本缺少 output_throughput_tps')
  const ttfts = pick('ttft_p99_ms')
  const tpots = pick('tpot_p99_ms')
  const successes = pick('success_rate_pct')
  const itls = pick('itl_p99_ms')
  const medianTp = median(throughputs)
  const minTp = Math.min(...throughputs)
  const maxTp = Math.max(...throughputs)
  const deviations = throughputs.map((v) => Math.abs(v - medianTp))
  const mad = median(deviations)
  const relNoise = medianTp ? (mad / medianTp) * 100 : 0
  const worstTtft = ttfts.length ? Math.max(...ttfts) : null
  const worstTpot = tpots.length ? Math.max(...tpots) : null
  const minSuccess = successes.length ? Math.min(...successes) : null
  const worstItl = itls.length ? Math.max(...itls) : null
  const metrics = {
    output_throughput_tps: metric(medianTp, 'output_throughput_tps'),
    ttft_p99_ms: metric(worstTtft, 'ttft_p99_ms'),
    tpot_p99_ms: metric(worstTpot, 'tpot_p99_ms'),
    success_rate_pct: metric(minSuccess, 'success_rate_pct'),
    itl_p99_ms: metric(worstItl, 'itl_p99_ms'),
  }
  if (pick('ttft_p50_ms').length) metrics.ttft_p50_ms = metric(median(pick('ttft_p50_ms')), 'ttft_p50_ms')
  if (pick('tpot_p50_ms').length) metrics.tpot_p50_ms = metric(median(pick('tpot_p50_ms')), 'tpot_p50_ms')
  if (pick('request_throughput_rps').length) metrics.request_throughput_rps = metric(median(pick('request_throughput_rps')), 'request_throughput_rps')
  const violated = []
  if (constraints) {
    if (worstTtft != null && constraints.ttft_p99_ms_max != null && worstTtft > constraints.ttft_p99_ms_max) {
      violated.push({ metric: 'ttft_p99_ms', limit: constraints.ttft_p99_ms_max, actual: worstTtft, policy: quantilePolicy })
    }
    if (worstTpot != null && constraints.tpot_p99_ms_max != null && worstTpot > constraints.tpot_p99_ms_max) {
      violated.push({ metric: 'tpot_p99_ms', limit: constraints.tpot_p99_ms_max, actual: worstTpot, policy: quantilePolicy })
    }
    if (minSuccess != null && constraints.success_rate_pct_min != null && minSuccess < constraints.success_rate_pct_min) {
      violated.push({ metric: 'success_rate_pct', limit: constraints.success_rate_pct_min, actual: minSuccess, policy: 'min' })
    }
  }
  return {
    metrics,
    sample_count: samples.length,
    throughput: { median: medianTp, min: minTp, max: maxTp, relative_mad_pct: Number(relNoise.toFixed(3)) },
    noise: { floor_pct: noiseFloorPct, observed_pct: Number(relNoise.toFixed(3)), within_floor: relNoise <= noiseFloorPct },
    quantile_policy: quantilePolicy,
    feasibility: violated.length ? 'infeasible' : 'feasible',
    violated_constraints: violated,
  }
}

/** 排序：可行性优先，吞吐降序；tie_epsilon 内视为并列并取最小 trial_id 保证确定性。 */
export function rankTrials(trials, { tieEpsilonPct = 1 } = {}) {
  const rows = trials.map((trial, index) => ({
    trial: trial,
    index: index,
    throughput: trial?.aggregate?.metrics?.output_throughput_tps?.value ?? trial?.metrics?.output_throughput_tps?.value ?? null,
    feasible: trial?.aggregate ? trial.aggregate.feasibility === 'feasible' : trial?.constraints?.feasible === true,
  }))
  const eligible = rows.filter((row) => row.feasible && typeof row.throughput === 'number' && Number.isFinite(row.throughput))
  eligible.sort((a, b) => (b.throughput - a.throughput) || String(a.trial.trial_id).localeCompare(String(b.trial.trial_id)))
  const ranked = []
  let group = 1
  let groupRef = null
  for (const row of eligible) {
    if (groupRef == null || Math.abs(row.throughput - groupRef) / (groupRef || 1) * 100 > tieEpsilonPct) {
      groupRef = row.throughput
      group += 1
    }
    ranked.push({ trial_id: row.trial.trial_id, throughput: row.throughput, rank: ranked.length + 1, tie_group: group })
  }
  return {
    ranked,
    best_trial_id: ranked[0]?.trial_id ?? null,
    tie_epsilon_pct: tieEpsilonPct,
    infeasible_trial_ids: rows.filter((row) => !row.feasible).map((row) => row.trial.trial_id),
  }
}

function pctDelta(base, cand) {
  if (base == null || cand == null) return null
  if (base === 0) return null
  return Number((((cand - base) / Math.abs(base)) * 100).toFixed(3))
}

function sourceSummary(job) {
  return {
    mode: job.executor === 'demo' ? 'demo' : job.executor,
    is_demo: job.executor === 'demo',
    evidence_kind: job.executor === 'demo' ? 'synthetic' : 'unverified',
    target_id: job.target_id,
  }
}

function tuneEffects({ hostWrite = true, processMutation = false, benchTraffic = false } = {}) {
  return {
    remote_readonly: true,
    host_private_write: hostWrite,
    process_mutation: processMutation,
    benchmark_traffic: benchTraffic,
    remote_write: false,
  }
}

function tuneEnvelope(kind, { status = 'ok', data = null, error = null, warnings = [], source = null, effects = {} } = {}) {
  return {
    schema: TUNE_SCHEMA,
    kind,
    status,
    readonly: true,
    effects: tuneEffects(effects),
    source: source ?? { mode: 'demo', is_demo: true, evidence_kind: 'synthetic', target_id: 'demo-ascend' },
    warnings: warnings.map((w) => (typeof w === 'string' ? { code: 'WARNING', message: w } : w)),
    data,
    error,
  }
}

function errorPayload(error) {
  if (error instanceof TuneApiError) return { code: error.code, message: error.message, retryable: false, details: error.details ?? null }
  return { code: 'INTERNAL_ERROR', message: String(error?.message ?? error), retryable: false, details: null }
}

function demoRepeatMetrics(params, repeat) {
  const hash = parseInt(sha256(canonicalJson(params)).slice(0, 8), 16)
  const jitter = (((hash >>> (repeat * 3)) & 0xff) / 255 - 0.5) * 0.02
  const seq = params.max_num_seqs
  const batched = params.max_num_batched_tokens
  const throughput = (620 + 12 * seq + 0.08 * batched) * (1 + jitter)
  const ttft50 = (150 + 6.5 * seq + 0.02 * batched) * (1 + jitter)
  const ttft99 = ttft50 * 1.5
  const tpot50 = 18 + 0.4 * seq + 0.001 * batched
  const tpot99 = tpot50 * 1.15
  return {
    metrics: {
      request_throughput_rps: metric(throughput / 160, 'request_throughput_rps'),
      output_throughput_tps: metric(Number(throughput.toFixed(3)), 'output_throughput_tps'),
      total_throughput_tps: metric(Number((throughput * 4.2).toFixed(3)), 'total_throughput_tps'),
      ttft_p50_ms: metric(Number(ttft50.toFixed(3)), 'ttft_p50_ms'),
      ttft_p99_ms: metric(Number(ttft99.toFixed(3)), 'ttft_p99_ms'),
      tpot_p50_ms: metric(Number(tpot50.toFixed(3)), 'tpot_p50_ms'),
      tpot_p99_ms: metric(Number(tpot99.toFixed(3)), 'tpot_p99_ms'),
      itl_p50_ms: metric(Number((tpot50 * 0.9).toFixed(3)), 'itl_p50_ms'),
      itl_p99_ms: metric(Number((tpot99 * 0.92).toFixed(3)), 'itl_p99_ms'),
      success_rate_pct: metric(100, 'success_rate_pct'),
    },
    raw_field_count: 12,
  }
}

/** 汇总 JSON 报告（Markdown 由 format 分支渲染）。 */
export function buildTuneReport(job, plan) {
  const trials = job.trials ?? []
  const baseline = trials.find((t) => t.kind === 'baseline' && t.state === 'succeeded') ?? null
  const candidates = trials.filter((t) => t.kind === 'candidate' && t.state === 'succeeded')
  const confirms = trials.filter((t) => t.kind === 'confirm_best' && t.state === 'succeeded')
  const confirmed = confirms[0] ?? null
  const ranked = rankTrials(candidates, { tieEpsilonPct: plan?.spec?.objective?.tie_epsilon_pct ?? 1 })
  const provisionalId = ranked.best_trial_id
  const provisional = trials.find((t) => t.trial_id === provisionalId) ?? null
  const best = confirmed ?? provisional
  const baseTp = baseline?.aggregate?.metrics?.output_throughput_tps?.value ?? null
  const bestTp = best?.aggregate?.metrics?.output_throughput_tps?.value ?? null
  const bestBase = confirms[1] ?? baseline
  const pareto = candidates
    .filter((t) => t.state === 'succeeded')
    .map((t) => ({
      trial_id: t.trial_id,
      candidate_id: t.candidate_id,
      throughput: t.aggregate?.metrics?.output_throughput_tps?.value ?? null,
      ttft_p99_ms: t.aggregate?.metrics?.ttft_p99_ms?.value ?? null,
      feasible: t.aggregate?.feasibility === 'feasible',
    }))
    .filter((row) => row.feasible)
    .sort((a, b) => (b.throughput ?? 0) - (a.throughput ?? 0))
  const summaryLines = []
  summaryLines.push(`作业 ${job.job_id} 状态 ${job.state}，共 ${trials.length} 个 trial，成功 ${trials.filter((t) => t.state === 'succeeded').length} 个。`)
  if (baseline && best) {
    summaryLines.push(`基线 output_throughput=${Number(baseTp).toFixed(2)} token/s，选择 ${best.trial_id} 的 ${Number(bestTp).toFixed(2)} token/s，提升 ${pctDelta(baseTp, bestTp) ?? 'n/a'}%。`)
  }
  summaryLines.push(`推荐依据：${confirmed ? '确认测量（confirm）' : '最佳候选的测量值（provisional，未确认）'}。`)
  const limitations = []
  if (job.executor === 'demo') {
    limitations.push('演示数据：指标由确定性合成生成，不代表真实 vLLM / Ascend 表现。')
    limitations.push('真实执行器默认关闭；未启动任何服务、未访问 NPU、未产生 benchmark 流量。')
  }
  return {
    job_id: job.job_id,
    plan_id: job.plan_id,
    plan_hash: job.plan_hash,
    is_demo: job.executor === 'demo',
    evidence_kind: job.executor === 'demo' ? 'synthetic' : 'unverified',
    generated_at: nowIso(),
    state: job.state,
    baseline: baseline ? { trial_id: baseline.trial_id, params: baseline.params, metrics: baseline.aggregate?.metrics ?? null } : null,
    provisional_best: provisional ? { trial_id: provisional.trial_id, candidate_id: provisional.candidate_id, params: provisional.params, metrics: provisional.aggregate?.metrics ?? null } : null,
    confirmed_best: confirmed ? { trial_id: confirmed.trial_id, candidate_id: confirmed.candidate_id, params: confirmed.params, metrics: confirmed.aggregate?.metrics ?? null, confirm_of: confirmed.confirm_of ?? null } : null,
    recommended: best ? { trial_id: best.trial_id, params: best.params, status: confirmed ? 'confirmed' : 'provisional' } : null,
    comparison: best ? { baseline_delta_pct: { output_throughput_tps: pctDelta(baseTp, bestTp), ttft_p99_ms: pctDelta(bestBase?.aggregate?.metrics?.ttft_p99_ms?.value ?? null, best?.aggregate?.metrics?.ttft_p99_ms?.value ?? null) } } : null,
    pareto,
    trial_rows: trials.map((t) => ({
      trial_id: t.trial_id,
      kind: t.kind,
      candidate_id: t.candidate_id,
      state: t.state,
      params: t.params,
      output_throughput_tps: t.aggregate?.metrics?.output_throughput_tps?.value ?? null,
      ttft_p99_ms: t.aggregate?.metrics?.ttft_p99_ms?.value ?? null,
      feasible: t.aggregate?.feasibility === 'feasible',
      failure_code: t.failure_code ?? null,
      noise_pct: t.aggregate?.noise?.observed_pct ?? null,
    })),
    summary_text: summaryLines.join('\n'),
    next_actions: job.state === 'completed' ? ['如需应用到真实服务，请在维护窗口内人工修改配置并使用一期看板做回归对比。'] : [],
    limitations,
    cleanup: job.cleanup,
    snapshot_id: job.snapshot_id ?? null,
    audit: { event_count: job.event_count ?? 0, created_at: job.created_at, finished_at: job.finished_at ?? null },
  }
}

export function renderReportMarkdown(report) {
  const lines = []
  lines.push(`# 昇腾性能调优报告（${report.is_demo ? '演示数据' : '未验证数据'}）`)
  lines.push('')
  lines.push(`- 作业：\`${report.job_id}\``)
  lines.push(`- 状态：${report.state}`)
  lines.push(`- 生成时间：${report.generated_at}`)
  lines.push('')
  lines.push('## 结论')
  if (report.recommended) {
    const params = report.recommended.params
    lines.push(`推荐参数：max_num_seqs=${params.max_num_seqs}，max_num_batched_tokens=${params.max_num_batched_tokens}，gpu_memory_utilization=${params.gpu_memory_utilization}，max_model_len=${params.max_model_len}`)
    lines.push(`推荐依据：${report.recommended.status === 'confirmed' ? '确认测量' : 'provisional（仅单次测量，未确认）'}`)
  } else {
    lines.push('没有可行候选，未给出推荐。')
  }
  if (report.comparison?.baseline_delta_pct) {
    const d = report.comparison.baseline_delta_pct
    lines.push(`相对基线：吞吐 ${d.output_throughput_tps ?? 'n/a'}%，TTFT p99 ${d.ttft_p99_ms ?? 'n/a'}%`)
  }
  lines.push('')
  lines.push('## Trial 明细')
  lines.push('| trial | 类型 | max_num_seqs | max_num_batched_tokens | 吞吐(token/s) | TTFT p99(ms) | 可行 | 失败码 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of report.trial_rows) {
    lines.push(`| ${row.trial_id} | ${row.kind} | ${row.params?.max_num_seqs ?? ''} | ${row.params?.max_num_batched_tokens ?? ''} | ${row.output_throughput_tps ?? ''} | ${row.ttft_p99_ms ?? ''} | ${row.feasible ? '是' : '否'} | ${row.failure_code ?? ''} |`)
  }
  lines.push('')
  if (report.limitations.length) {
    lines.push('## 限制')
    for (const item of report.limitations) lines.push(`- ${item}`)
  }
  return lines.join('\n')
}

// ============================================================================================
// 持久化：独立 TuneStore（tuning-v1/ 目录；0700/0600；原子写；重启恢复）
// ============================================================================================

function safeId(value, where = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw fail('INVALID_ARGUMENT', `${where} 非法：${String(value)}`)
  }
  return value
}

export class TuneStore {
  constructor({ dataDir, quotaBytes = TUNE_LIMITS.storeQuotaBytes } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw fail('INVALID_ARGUMENT', 'TuneStore 需要 dataDir')
    this.root = join(dataDir, 'tuning-v1')
    this.quotaBytes = quotaBytes
    this.ensure()
  }

  ensure() {
    for (const dir of [this.root, join(this.root, 'plans'), join(this.root, 'jobs'), join(this.root, 'locks'), join(this.root, 'quarantine')]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try {
        chmodSync(dir, 0o700)
      } catch {
        /* 忽略平台差异 */
      }
    }
  }

  statePath() {
    return join(this.root, 'state.json')
  }

  planPath(planId) {
    return join(this.root, 'plans', `${safeId(planId, 'plan_id')}.json`)
  }

  jobDir(jobId) {
    return join(this.root, 'jobs', safeId(jobId, 'job_id'))
  }

  writeJsonAtomic(path, value) {
    const tmp = `${path}.${randomUUID().replace(/-/g, '')}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      /* 忽略平台差异 */
    }
    renameSync(tmp, path)
  }

  readJson(path) {
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      this.quarantine(path, error)
      return null
    }
  }

  quarantine(path, error) {
    try {
      const target = join(this.root, 'quarantine', `${Date.now()}-${path.split('/').pop()}`)
      renameSync(path, target)
      writeFileSync(`${target}.reason`, String(error?.message ?? error), { mode: 0o600 })
    } catch {
      /* 隔离失败不应阻断主流程 */
    }
  }

  loadState() {
    const state = this.readJson(this.statePath())
    if (!state || state.schema !== TUNE_STORE_SCHEMA) {
      return { schema: TUNE_STORE_SCHEMA, revision: 0, updated_at: nowIso(), jobs: {} }
    }
    return { jobs: {}, ...state }
  }

  saveState(state) {
    state.revision = Number(state.revision ?? 0) + 1
    state.updated_at = nowIso()
    this.writeJsonAtomic(this.statePath(), state)
    return state
  }

  savePlan(plan) {
    this.writeJsonAtomic(this.planPath(plan.plan_id), plan)
    // 清理过期计划（仅本次创建时做一次轻量清扫）
    try {
      for (const name of readdirSync(join(this.root, 'plans'))) {
        const full = join(this.root, 'plans', name)
        if (!name.endsWith('.json')) continue
        const stat = statSync(full)
        if (Date.now() - stat.mtimeMs > PLAN_TTL_MS * 2) rmSync(full, { force: true })
      }
    } catch {
      /* 清扫失败忽略 */
    }
  }

  loadPlan(planId) {
    const plan = this.readJson(this.planPath(planId))
    if (!plan) return null
    if (plan.schema !== TUNE_PLAN_SCHEMA) throw fail('SCHEMA_UNSUPPORTED', '计划文件 schema 不受支持')
    return plan
  }

  saveJob(job) {
    mkdirSync(this.jobDir(job.job_id), { recursive: true, mode: 0o700 })
    this.writeJsonAtomic(join(this.jobDir(job.job_id), 'state.json'), job)
    for (const trial of job.trials ?? []) {
      const dir = join(this.jobDir(job.job_id), 'trials')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      this.writeJsonAtomic(join(dir, `${safeId(trial.trial_id, 'trial_id')}.json`), trial)
    }
    const state = this.loadState()
    state.jobs[job.job_id] = {
      job_id: job.job_id,
      plan_id: job.plan_id,
      state: job.state,
      executor: job.executor,
      is_demo: job.executor === 'demo',
      created_at: job.created_at,
      updated_at: job.updated_at,
      revision: job.revision,
    }
    this.saveState(state)
    this.enforceQuota()
    return job
  }

  loadJob(jobId) {
    const job = this.readJson(join(this.jobDir(jobId), 'state.json'))
    if (!job) return null
    if (job.schema !== TUNE_STORE_SCHEMA) throw fail('SCHEMA_UNSUPPORTED', '作业文件 schema 不受支持')
    return job
  }

  listJobs() {
    const state = this.loadState()
    return Object.values(state.jobs ?? {}).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  }

  appendEvent(jobId, event) {
    const path = join(this.jobDir(jobId), 'events.jsonl')
    mkdirSync(this.jobDir(jobId), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 })
    try {
      chmodSync(path, 0o600)
    } catch {
      /* 忽略平台差异 */
    }
    const stat = statSync(path)
    if (stat.size > TUNE_LIMITS.maxLogBytesPerJob) {
      const keep = readFileSync(path, 'utf8').split('\n').slice(-500).join('\n')
      writeFileSync(path, `${keep}\n`, { mode: 0o600 })
    }
  }

  readEvents(jobId, afterSeq = 0, limit = 20) {
    const path = join(this.jobDir(jobId), 'events.jsonl')
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    const events = []
    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        if (Number(event.seq) > afterSeq) events.push(event)
      } catch {
        /* 跳过损坏行 */
      }
    }
    return events.slice(-Math.max(1, Math.min(200, limit)))
  }

  quotaUsage() {
    let bytes = 0
    const walk = (dir) => {
      let entries
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        const full = join(dir, name)
        let stat
        try {
          stat = statSync(full)
        } catch {
          continue
        }
        if (stat.isDirectory()) walk(full)
        else bytes += stat.size
      }
    }
    walk(this.root)
    return bytes
  }

  enforceQuota() {
    const usage = this.quotaUsage()
    if (usage <= this.quotaBytes) return
    const jobs = this.listJobs().filter((job) => !['running', 'pausing', 'paused', 'queued', 'recovery_required', 'cleanup_pending'].includes(job.state))
    for (const job of jobs) {
      try {
        rmSync(this.jobDir(job.job_id), { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
      if (this.quotaUsage() <= this.quotaBytes) return
    }
    if (this.quotaUsage() > this.quotaBytes) throw fail('STORE_QUOTA', '调优仓储超过配额，请清理历史作业', { quotaBytes: this.quotaBytes })
  }
}

function s4() {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled'])
const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'pausing', 'paused', 'blocked', 'stopping'])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 调优服务：计划、作业生命周期、状态查询、报告。真实执行默认关闭。 */
export class TuneService {
  constructor({ dataDir, config = {}, now = () => Date.now(), demoStepDelayMs = 8, benchSource = null } = {}) {
    this.store = new TuneStore({ dataDir })
    this.benchSource = typeof benchSource === 'function' ? benchSource : null
    this.config = config
    this.now = now
    this.demoStepDelayMs = demoStepDelayMs
    this.plans = new Map()
    this.jobs = new Map()
    this.idempotency = new Map()
    this.ports = Array.isArray(config.ports) && config.ports.length ? config.ports : [8000]
    this.recover()
  }

  recover() {
    const recovered = []
    for (const summary of this.store.listJobs()) {
      let job
      try {
        job = this.store.loadJob(summary.job_id)
      } catch {
        continue
      }
      if (!job) continue
      if (ACTIVE_JOB_STATES.has(job.state)) {
        job.state = 'recovery_required'
        job.cleanup = { state: 'recovery_required', verified: false, checked_at: nowIso(), detail: '进程重启：需人工确认旧执行器的子进程与端口已清理' }
        job.resume_allowed = false
        job.updated_at = nowIso()
        job.revision = Number(job.revision ?? 0) + 1
        this.store.saveJob(job)
        recovered.push(job.job_id)
      }
      this.jobs.set(job.job_id, job)
    }
    this.recovered_job_ids = recovered
  }

  planCount() {
    return this.plans.size
  }

  getPlan(planId) {
    if (this.plans.has(planId)) return this.plans.get(planId)
    const plan = this.store.loadPlan(planId)
    if (plan) this.plans.set(planId, plan)
    return plan
  }

  createPlan(specRaw) {
    const spec = normalizeTuneSpec(specRaw)
    const plan = buildTunePlan(spec, { now: this.now(), ports: this.ports })
    this.store.savePlan(plan)
    this.plans.set(plan.plan_id, plan)
    return tuneEnvelope('plan', {
      data: { plan },
      source: plan.executor === 'demo'
        ? { mode: 'demo', is_demo: true, evidence_kind: 'synthetic', target_id: plan.target_id }
        : { mode: plan.executor, is_demo: false, evidence_kind: 'unverified', target_id: plan.target_id },
      effects: { hostWrite: true },
      warnings: plan.budget_estimate.warnings,
    })
  }

  receipt(job, action, { dryRun = false, replay = false, blockers = [], nextActions = [] } = {}) {
    return {
      control_request_id: `ctl_${s4()}`,
      action,
      accepted_at: nowIso(),
      plan_id: job.plan_id,
      plan_hash: job.plan_hash,
      job_id: job.job_id,
      dry_run: dryRun,
      job_state: job.state,
      revision: job.revision,
      idempotency_key: job.last_idempotency_key ?? null,
      blockers,
      next_actions: nextActions,
      cleanup_state: job.cleanup?.state ?? 'not_needed',
      idempotent_replay: replay,
      budget_estimate: job.budget_estimate ?? null,
    }
  }

  checkPlan(planId, planHash) {
    const plan = this.getPlan(safeId(planId, 'plan_id'))
    if (!plan) throw fail('NOT_FOUND', `计划不存在：${planId}`)
    if (plan.expires_at && Date.parse(plan.expires_at) < this.now()) throw fail('PLAN_EXPIRED', '计划已过期，请重新生成')
    if (planHash && planHash !== plan.plan_hash) throw fail('PLAN_HASH_MISMATCH', 'plan_hash 与当前计划不一致（计划可能已重新生成）')
    return plan
  }

  realExecutionAllowed(plan, authorization) {
    if (plan.executor === 'demo') return true
    // 真实执行器：即使调用方传入 authorization，也必须通过 Host 侧的授权门（本期无授权桥）。
    const gate = realExecutionGate({
      executor: plan.executor,
      config: { enableRealExecutors: Boolean(this.config.enableRealExecutors) },
      targetPolicy: plan.target_policy,
      grant: authorization,
    })
    if (!gate.ok) throw fail(gate.code, gate.message)
    return true
  }

  /** 计划预览（dry-run）：不创建作业、不写任何执行状态。 */
  dryRun(planId, planHash) {
    const plan = this.checkPlan(planId, planHash)
    const fakeJob = {
      job_id: null,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      state: 'dry_run',
      revision: 0,
      cleanup: { state: 'not_needed', verified: true },
      budget_estimate: plan.budget_estimate,
      last_idempotency_key: null,
    }
    return tuneEnvelope('control', {
      data: this.receipt(fakeJob, 'Start', {
        dryRun: true,
        blockers: plan.blockers,
        nextActions: plan.blockers.length ? ['移除阻断项后再确认启动'] : ['确认 plan_hash 后以 dry_run=false 启动'],
      }),
      source: { mode: plan.executor, is_demo: plan.executor === 'demo', evidence_kind: 'synthetic', target_id: plan.target_id },
      warnings: plan.budget_estimate.warnings,
    })
  }

  start({ plan_id, plan_hash, dry_run = false, idempotency_key = null, confirmation_token = null, authorization = null }) {
    const plan = this.checkPlan(plan_id, plan_hash)
    if (dry_run) return this.dryRun(plan.plan_id, plan.plan_hash)
    if (idempotency_key) {
      const key = `${plan.plan_id}:${idempotency_key}`
      const existing = this.idempotency.get(key)
      if (existing) {
        const job = this.jobs.get(existing)
        if (job) return tuneEnvelope('control', { data: this.receipt(job, 'Start', { replay: true }), source: sourceSummary(job) })
      }
    }
    if (plan.blockers.length) {
      const blocked = {
        job_id: null,
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        state: 'blocked',
        revision: 0,
        cleanup: { state: 'not_needed', verified: true },
        budget_estimate: plan.budget_estimate,
      }
      return tuneEnvelope('control', {
        status: 'degraded',
        data: this.receipt(blocked, 'Start', { blockers: plan.blockers, nextActions: ['该计划含阻断项，未启动任何执行'] }),
        error: { code: plan.blockers[0].code, message: plan.blockers[0].message, retryable: false, details: plan.blockers },
        source: { mode: plan.executor, is_demo: plan.executor === 'demo', evidence_kind: 'unverified', target_id: plan.target_id },
        warnings: plan.budget_estimate.warnings,
      })
    }
    this.realExecutionAllowed(plan, { confirmation_token, authorization })
    const job = this.createJob(plan, { idempotency_key })
    if (idempotency_key) this.idempotency.set(`${plan.plan_id}:${idempotency_key}`, job.job_id)
    this.jobs.set(job.job_id, job)
    this.store.saveJob(job)
    this.enqueue(job)
    return tuneEnvelope('control', { data: this.receipt(job, 'Start', { nextActions: ['用 ascend_tune_status 轮询进度'] }), source: sourceSummary(job) })
  }

  createJob(plan, { idempotency_key = null } = {}) {
    const jobId = `job_${s4()}`
    const trials = []
    const spec = plan.spec
    const total = 1 + plan.candidates.length + Math.min(plan.candidates.length, Math.floor(plan.candidates.length / spec.measurement.baseline_check_every)) + 2
    trials.push(this.makeTrial(jobId, 'baseline', spec.baseline, `trial_${String(trials.length + 1).padStart(3, '0')}`))
    let checkpointIndex = 0
    plan.candidates.forEach((candidate, index) => {
      trials.push(this.makeTrial(jobId, 'candidate', candidate.params, `trial_${String(trials.length + 1).padStart(3, '0')}`, candidate.candidate_id))
      if ((index + 1) % spec.measurement.baseline_check_every === 0) {
        checkpointIndex += 1
        trials.push(this.makeTrial(jobId, 'checkpoint', spec.baseline, `trial_${String(trials.length + 1).padStart(3, '0')}`, null, `checkpoint_${checkpointIndex}`))
      }
    })
    trials.push(this.makeTrial(jobId, 'confirm_best', spec.baseline, `trial_${String(trials.length + 1).padStart(3, '0')}`, null))
    trials.push(this.makeTrial(jobId, 'confirm_baseline', spec.baseline, `trial_${String(trials.length + 1).padStart(3, '0')}`, null))
    return {
      schema: TUNE_STORE_SCHEMA,
      job_id: jobId,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      spec_hash: plan.spec_hash,
      execution_fingerprint: plan.execution_fingerprint,
      target_id: plan.target_id,
      executor: plan.executor,
      state: 'queued',
      revision: 0,
      dry_run: false,
      created_at: nowIso(),
      updated_at: nowIso(),
      started_at: null,
      finished_at: null,
      snapshot_id: null,
      total_trials: trials.length,
      trials,
      events_seq: 0,
      event_count: 0,
      idempotency_keys: idempotency_key ? [idempotency_key] : [],
      last_idempotency_key: idempotency_key,
      pause_requested: false,
      stop_requested: false,
      resume_gate: null,
      failure_reason: null,
      cleanup: { state: plan.executor === 'demo' ? 'not_needed' : 'pending', verified: plan.executor === 'demo' },
      budget: spec.budget,
      budget_estimate: plan.budget_estimate,
      budget_used: { bench_invocations: 0, tokens: 0, elapsed_s: 0 },
      resume_allowed: false,
      plan_summary: { candidates: plan.candidates.length, blockers: plan.blockers.length, spec_label: spec.label ?? null },
    }
  }

  makeTrial(jobId, kind, params, trialId, candidateId = null, checkpointId = null) {
    return {
      trial_id: `${jobId}_${trialId}`,
      kind,
      candidate_id: candidateId,
      checkpoint_id: checkpointId,
      state: 'pending',
      params: { ...params },
      metrics: null,
      aggregate: null,
      constraints: null,
      verdict: null,
      failure_code: null,
      failure_message: null,
      bench_invocations: 0,
      requests: 0,
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
      confirm_of: null,
      evidence: { kind: 'synthetic', log_ref: 'demo://tuning' },
    }
  }

  emit(job, type, data = {}) {
    job.events_seq = Number(job.events_seq ?? 0) + 1
    job.event_count = Number(job.event_count ?? 0) + 1
    const event = { seq: job.events_seq, ts: nowIso(), type, job_id: job.job_id, data }
    this.store.appendEvent(job.job_id, event)
    return event
  }

  setState(job, state) {
    if (job.state !== state) {
      job.state = state
      job.updated_at = nowIso()
    }
    job.revision = Number(job.revision ?? 0) + 1
    job.updated_at = nowIso()
  }

  persist(job) {
    this.store.saveJob(job)
  }

  enqueue(job) {
    job.run_promise = this.runJob(job).catch((error) => {
      job.state = 'failed'
      job.failure_reason = { code: error?.code ?? 'INTERNAL_ERROR', message: String(error?.message ?? error) }
      job.finished_at = nowIso()
      job.revision = Number(job.revision ?? 0) + 1
      job.updated_at = nowIso()
      try {
        this.persist(job)
      } catch {
        /* ignore */
      }
    })
  }

  async pauseJob(job) {
    if (TERMINAL_JOB_STATES.has(job.state)) throw fail('INVALID_STATE', `作业处于终态 ${job.state}，不能暂停`)
    job.pause_requested = true
    if (job.state === 'queued') {
      this.setState(job, 'paused')
      this.persist(job)
    }
  }

  resumeJob(job) {
    if (!job.pause_requested && job.state !== 'paused') throw fail('INVALID_STATE', `作业当前状态 ${job.state}，不需要恢复`)
    if (!job.resume_allowed && job.state === 'paused') {
      // 允许恢复仍处于 paused 的正常作业；仅恢复需人工清理的作业被拒绝
      if (job.cleanup?.state === 'recovery_required') throw fail('CLEANUP_UNVERIFIED', '作业需人工确认清理后才能恢复')
    }
    job.pause_requested = false
    job.revision = Number(job.revision ?? 0) + 1
    job.updated_at = nowIso()
    if (job.state === 'paused') {
      job.state = 'running'
      job.updated_at = nowIso()
    }
    this.persist(job)
    if (!job.run_promise) this.enqueue(job)
  }

  stopJob(job) {
    if (TERMINAL_JOB_STATES.has(job.state)) return
    job.stop_requested = true
    if (job.state === 'paused' || job.state === 'queued') {
      this.setState(job, 'cancelled')
      job.finished_at = nowIso()
      job.cleanup = { state: job.executor === 'demo' ? 'not_needed' : 'done', verified: true, checked_at: nowIso() }
      this.persist(job)
    } else {
      this.setState(job, 'stopping')
      this.persist(job)
    }
  }

  async runJob(job) {
    const spec = this.getPlan(job.plan_id)?.spec
    const startedAt = Date.now()
    this.setState(job, 'running')
    job.started_at = nowIso()
    this.emit(job, 'job_started', { executor: job.executor, is_demo: job.executor === 'demo' })
    this.persist(job)
    try {
      for (const trial of job.trials) {
        if (job.stop_requested) break
        while (job.pause_requested && !job.stop_requested) {
          if (job.state !== 'paused') {
            this.setState(job, 'paused')
            this.emit(job, 'job_paused', {})
            this.persist(job)
          }
          await sleep(10)
        }
        if (job.stop_requested) break
        if (job.state === 'paused') {
          job.state = 'running'
          this.emit(job, 'job_resumed', {})
        }
        try {
          await this.runTrial(job, trial, spec)
        } catch (error) {
          this.markTrialFailure(job, trial, error)
        }
        const failedCount = job.trials.filter((t) => ['failed', 'timeout', 'oom', 'invalid_metrics'].includes(t.state)).length
        const consecutive = job.trials.filter((t) => t.state === 'failed' || t.state === 'timeout' || t.state === 'oom' || t.state === 'invalid_metrics').length
        if (failedCount > spec.budget.max_failed_trials) {
          job.budget_used.failure_budget_exceeded = true
          this.emit(job, 'budget_exhausted', { failed_trials: failedCount, max_failed_trials: spec.budget.max_failed_trials })
          throw fail('BUDGET_EXHAUSTED', `失败 trial 数 ${failedCount} 超过 max_failed_trials ${spec.budget.max_failed_trials}`)
        }
        if (consecutive >= spec.budget.max_consecutive_failures && !job.trials.some((t) => t.state === 'succeeded')) {
          throw fail('BUDGET_EXHAUSTED', `连续失败 ${consecutive} 次，提前终止作业`)
        }
      }
      if (job.stop_requested) {
        for (const trial of job.trials) {
          if (!['succeeded', 'failed', 'timeout', 'invalid_metrics', 'cancelled'].includes(trial.state)) {
            trial.state = 'cancelled'
            trial.finished_at = nowIso()
          }
        }
        this.setState(job, 'cancelled')
        job.finished_at = nowIso()
        job.cleanup = { state: 'not_needed', verified: true, checked_at: nowIso() }
        this.emit(job, 'job_cancelled', {})
      } else {
        const candidates = job.trials.filter((t) => t.kind === 'candidate' && t.state === 'succeeded')
        const ranked = rankTrials(candidates, { tieEpsilonPct: spec?.objective?.tie_epsilon_pct ?? 1 })
        const best = job.trials.find((t) => t.trial_id === ranked.best_trial_id) ?? null
        const confirmBest = job.trials.find((t) => t.kind === 'confirm_best')
        const confirmBaseline = job.trials.find((t) => t.kind === 'confirm_baseline')
        if (best && confirmBest) {
          confirmBest.params = { ...best.params }
          confirmBest.confirm_of = best.trial_id
        }
        this.setState(job, 'completed')
        job.finished_at = nowIso()
        job.cleanup = { state: 'not_needed', verified: true, checked_at: nowIso() }
        this.emit(job, 'job_completed', { best_trial_id: ranked.best_trial_id, confirmed: Boolean(confirmBest?.state === 'succeeded') })
        job.recommendation = { best_trial_id: ranked.best_trial_id, provisional: true }
      }
    } catch (error) {
      this.setState(job, 'failed')
      job.failure_reason = { code: error?.code ?? 'INTERNAL_ERROR', message: String(error?.message ?? error) }
      job.finished_at = nowIso()
      this.emit(job, 'job_failed', { code: job.failure_reason.code })
    }
    job.budget_used = {
      ...job.budget_used,
      elapsed_s: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      bench_invocations: job.trials.reduce((sum, t) => sum + (t.bench_invocations ?? 0), 0),
    }
    this.persist(job)
  }

  async runTrial(job, trial, spec) {
    const steps = ['preparing', 'starting', 'health_check', 'warming', 'measuring', 'evaluating', 'cleaning']
    trial.started_at = nowIso()
    for (const step of steps) {
      if (job.stop_requested) {
        trial.state = 'cancelled'
        trial.finished_at = nowIso()
        return
      }
      trial.state = step
      this.emit(job, 'trial_state', { trial_id: trial.trial_id, state: step })
      this.persist(job)
      await sleep(this.demoStepDelayMs)
    }
    const repeats = trial.kind.startsWith('confirm') ? spec.measurement.confirm_repeats : spec.measurement.repeats
    const samples = []
    for (let i = 0; i < repeats; i += 1) {
      trial.bench_invocations = (trial.bench_invocations ?? 0) + 1
      trial.requests = (trial.requests ?? 0) + spec.workload.num_prompts
      const text = this.benchSource
        ? await this.benchSource({ trial, spec, repeat: i + 1 })
        : JSON.stringify(rawToBenchJson(demoRepeatMetrics(trial.params, i + 1)))
      samples.push(parseBenchOutput(text))
    }
    const aggregate = aggregateRepeats(samples, {
      constraints: spec.objective.constraints,
      noiseFloorPct: spec.objective.noise_floor_pct,
    })
    trial.metrics = aggregate.metrics
    trial.aggregate = aggregate
    trial.constraints = { feasible: aggregate.feasibility === 'feasible', violated: aggregate.violated_constraints }
    trial.state = 'succeeded'
    trial.finished_at = nowIso()
    this.emit(job, 'trial_completed', { trial_id: trial.trial_id, throughput: aggregate.metrics.output_throughput_tps?.value ?? null, feasible: trial.constraints.feasible })
    this.persist(job)
  }

  markTrialFailure(job, trial, error) {
    const code = error?.code ?? 'PROCESS_FAILED'
    const state = code === 'BENCH_TIMEOUT' || code === 'HEALTH_TIMEOUT'
      ? 'timeout'
      : code === 'INVALID_METRICS'
        ? 'invalid_metrics'
        : code === 'OOM'
          ? 'oom'
          : 'failed'
    trial.state = state
    trial.failure_code = code
    trial.failure_message = String(error?.message ?? error).slice(0, 512)
    trial.finished_at = nowIso()
    this.emit(job, 'trial_failed', { trial_id: trial.trial_id, state, code })
    this.persist(job)
  }

  findJob(jobId) {
    if (jobId) {
      const id = safeId(jobId, 'job_id')
      if (this.jobs.has(id)) return this.jobs.get(id)
      const loaded = this.store.loadJob(id)
      if (loaded) {
        this.jobs.set(id, loaded)
        return loaded
      }
      throw fail('NOT_FOUND', `作业不存在：${jobId}`)
    }
    return null
  }

  status({ job_id = null, after_seq = 0, limit = 20, include_trials = true } = {}) {
    if (!job_id) {
      const jobs = this.store.listJobs().slice(0, Math.max(1, Math.min(50, limit)))
      return tuneEnvelope('status', {
        data: { generated_at: nowIso(), jobs, recovered_job_ids: this.recovered_job_ids ?? [] },
        source: { mode: 'demo', is_demo: true, evidence_kind: 'synthetic', target_id: 'demo-ascend' },
      })
    }
    const job = this.findJob(job_id)
    const completed = job.trials.filter((t) => ['succeeded', 'failed', 'timeout', 'invalid_metrics'].includes(t.state)).length
    const page = {
      generated_at: nowIso(),
      revision: job.revision,
      job: {
        job_id: job.job_id,
        plan_id: job.plan_id,
        plan_hash: job.plan_hash,
        state: job.state,
        dry_run: job.dry_run,
        executor: job.executor,
        target_id: job.target_id,
        is_demo: job.executor === 'demo',
        revision: job.revision,
        created_at: job.created_at,
        updated_at: job.updated_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        pause_requested: Boolean(job.pause_requested),
        stop_requested: Boolean(job.stop_requested),
        resume_allowed: !TERMINAL_JOB_STATES.has(job.state) && job.state !== 'recovery_required',
        progress: { completed_trials: completed, total_trials: job.trials.length, current_trial_id: job.trials.find((t) => ['starting', 'health_check', 'warming', 'measuring', 'evaluating', 'cleaning'].includes(t.state))?.trial_id ?? null },
        counts: {
          succeeded: job.trials.filter((t) => t.state === 'succeeded').length,
          failed: job.trials.filter((t) => t.state === 'failed').length,
          timeout: job.trials.filter((t) => t.state === 'timeout').length,
          invalid_metrics: job.trials.filter((t) => t.state === 'invalid_metrics').length,
          cancelled: job.trials.filter((t) => t.state === 'cancelled').length,
        },
        trials: include_trials ? job.trials : undefined,
        recent_events: this.store.readEvents(job.job_id, after_seq, limit),
        cleanup: job.cleanup,
        budget_estimate: job.budget_estimate,
        budget_used: job.budget_used,
        failure_reason: job.failure_reason ?? null,
        idempotency_keys: job.idempotency_keys ?? [],
      },
    }
    return tuneEnvelope('status', { data: page, source: sourceSummary(job) })
  }

  report({ job_id, format = 'json' } = {}) {
    const job = this.findJob(job_id)
    const plan = this.getPlan(job.plan_id)
    if (!plan) throw fail('NOT_FOUND', `计划不存在：${job.plan_id}`)
    const report = buildTuneReport(job, plan)
    if (format === 'markdown') {
      return tuneEnvelope('report', { data: { job_id: job.job_id, format: 'markdown', content: renderReportMarkdown(report), report }, source: sourceSummary(job) })
    }
    if (format !== 'json') throw fail('INVALID_ARGUMENT', `不支持的 report format：${format}`)
    return tuneEnvelope('report', { data: { job_id: job.job_id, format: 'json', report }, source: sourceSummary(job) })
  }

  async waitForJob(jobId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const job = this.findJob(jobId)
      if (TERMINAL_JOB_STATES.has(job.state)) return job
      await sleep(10)
    }
    throw fail('BENCH_TIMEOUT', '等待作业完成超时')
  }
}

function rawToBenchJson(raw) {
  const m = raw.metrics
  return {
    request_throughput: m.request_throughput_rps?.value,
    output_throughput: m.output_throughput_tps?.value,
    total_token_throughput: m.total_throughput_tps?.value,
    median_ttft_ms: m.ttft_p50_ms?.value,
    p99_ttft_ms: m.ttft_p99_ms?.value,
    median_tpot_ms: m.tpot_p50_ms?.value,
    p99_tpot_ms: m.tpot_p99_ms?.value,
    median_itl_ms: m.itl_p50_ms?.value,
    p99_itl_ms: m.itl_p99_ms?.value,
    success_rate_pct: m.success_rate_pct?.value,
    num_prompts: 1000,
    completed: 1000,
  }
}

// ============================================================================================
// Tools 与 REST 路由
// ============================================================================================

const TUNE_TOOL_TIMEOUT_MS = 30_000

function tuneToolResult(result) {
  return result
}

export function createTuneTools({ service }) {
  const planTool = {
    name: 'ascend_tune_plan',
    description: '生成昇腾服务调优计划（dry-run）：校验规格、展开 grid/random 候选、估算预算并返回命令预览。不启动服务、不访问 NPU。',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'tune-spec-v1 调优规格（executor/target/fixed/baseline/space/workload/objective/search/measurement/budget）' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: `计划 ${value?.data?.plan?.plan_id ?? 'n/a'}，候选 ${value?.data?.plan?.candidates?.length ?? 0} 个，预算 fit=${value?.data?.plan?.budget_estimate?.fit ?? 'n/a'}` }] },
    timeoutMs: TUNE_TOOL_TIMEOUT_MS,
    execute: async (args) => {
      try {
        return tuneToolResult(service.createPlan(args?.spec))
      } catch (error) {
        return tuneEnvelope('plan', { status: 'error', error: errorPayload(error) })
      }
    },
  }
  const runTool = {
    name: 'ascend_tune_run',
    description: '控制调优作业：dry_run 预览、Start 启动、Pause 暂停、Resume 恢复、Stop 停止。真实执行默认关闭，需 Host 授权门。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['dry_run', 'Start', 'Pause', 'Resume', 'Stop'] },
        plan_id: { type: 'string' },
        plan_hash: { type: 'string' },
        job_id: { type: 'string' },
        idempotency_key: { type: 'string' },
        expected_revision: { type: 'number' },
        confirmation_token: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: `调优控制 ${args?.action ?? ''}：${value?.data?.job_state ?? value?.error?.code ?? 'unknown'}` }] },
    timeoutMs: TUNE_TOOL_TIMEOUT_MS,
    execute: async (args) => {
      try {
        const action = args?.action
        if (action === 'dry_run') {
          const result = service.dryRun(args?.plan_id, args?.plan_hash)
          return result
        }
        if (action === 'Start') {
          return service.start({
            plan_id: args?.plan_id,
            plan_hash: args?.plan_hash,
            dry_run: false,
            idempotency_key: args?.idempotency_key ?? null,
            confirmation_token: args?.confirmation_token ?? null,
          })
        }
        const job = service.findJob(args?.job_id)
        if (args?.expected_revision != null && Number(args.expected_revision) !== Number(job.revision)) {
          throw fail('REVISION_CONFLICT', `作业 revision 已变化（期望 ${args.expected_revision}，实际 ${job.revision}）`)
        }
        if (action === 'Pause') {
          await service.pauseJob(job)
          return tuneEnvelope('control', { data: service.receipt(job, 'Pause'), source: sourceSummary(job) })
        }
        if (action === 'Resume') {
          service.resumeJob(job)
          return tuneEnvelope('control', { data: service.receipt(job, 'Resume'), source: sourceSummary(job) })
        }
        if (action === 'Stop') {
          service.stopJob(job)
          return tuneEnvelope('control', { data: service.receipt(job, 'Stop'), source: sourceSummary(job) })
        }
        throw fail('INVALID_ARGUMENT', `未知 action：${action}`)
      } catch (error) {
        return tuneEnvelope('control', { status: 'error', error: errorPayload(error) })
      }
    },
  }
  const statusTool = {
    name: 'ascend_tune_status',
    description: '查询调优作业状态：作业列表或单个作业的 trial、事件、预算与清理状态（只读）。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        after_seq: { type: 'number' },
        limit: { type: 'number' },
        include_trials: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: value?.data?.job ? `作业 ${value.data.job.job_id} 状态 ${value.data.job.state}（${value.data.job.progress?.completed_trials ?? 0}/${value.data.job.progress?.total_trials ?? 0}）` : `共 ${value?.data?.jobs?.length ?? 0} 个调优作业` }] },
    timeoutMs: TUNE_TOOL_TIMEOUT_MS,
    execute: async (args) => {
      try {
        return service.status({ job_id: args?.job_id ?? null, after_seq: Number(args?.after_seq ?? 0), limit: Number(args?.limit ?? 20), include_trials: args?.include_trials !== false })
      } catch (error) {
        return tuneEnvelope('status', { status: 'error', error: errorPayload(error) })
      }
    },
  }
  const reportTool = {
    name: 'ascend_tune_report',
    description: '生成调优报告：baseline/最佳候选/确认测量、Pareto、trial 明细与限制说明；支持 json/markdown。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        format: { type: 'string', enum: ['json', 'markdown'] },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: value?.data?.format === 'markdown' ? String(value.data.content).slice(0, 4000) : `报告 ${value?.data?.report?.job_id ?? 'n/a'}：${value?.data?.report?.recommended ? '已给出推荐' : '暂无推荐'}` }] },
    timeoutMs: TUNE_TOOL_TIMEOUT_MS,
    execute: async (args) => {
      try {
        return service.report({ job_id: args?.job_id, format: args?.format ?? 'json' })
      } catch (error) {
        return tuneEnvelope('report', { status: 'error', error: errorPayload(error) })
      }
    },
  }
  return [planTool, runTool, statusTool, reportTool]
}

export function createTuneRoutes({ service }) {
  const api = (fn) => async (body, query) => fn(body ?? {}, query ?? {})
  return [
    {
      path: '/tuning/plan',
      method: 'POST',
      handler: api((body) => service.createPlan(body.spec)),
    },
    {
      path: '/tuning/run',
      method: 'POST',
      handler: api((body) => {
        const action = body.action ?? 'Start'
        if (action === 'dry_run') return service.dryRun(body.plan_id, body.plan_hash)
        if (action === 'Start') return service.start(body)
        const job = service.findJob(body.job_id)
        if (body.expected_revision != null && Number(body.expected_revision) !== Number(job.revision)) {
          throw fail('REVISION_CONFLICT', '作业 revision 已变化')
        }
        if (action === 'Pause') {
          service.pauseJob(job)
          return tuneEnvelope('control', { data: service.receipt(job, 'Pause'), source: sourceSummary(job) })
        }
        if (action === 'Resume') {
          service.resumeJob(job)
          return tuneEnvelope('control', { data: service.receipt(job, 'Resume'), source: sourceSummary(job) })
        }
        if (action === 'Stop') {
          service.stopJob(job)
          return tuneEnvelope('control', { data: service.receipt(job, 'Stop'), source: sourceSummary(job) })
        }
        throw fail('INVALID_ARGUMENT', `未知 action：${action}`)
      }),
    },
    {
      path: '/tuning/status',
      method: 'GET',
      handler: api((body, query) => service.status({
        job_id: query.job_id ?? null,
        after_seq: Number(query.after_seq ?? 0),
        limit: Number(query.limit ?? 20),
        include_trials: query.include_trials !== 'false',
      })),
    },
    {
      path: '/tuning/status',
      method: 'POST',
      handler: api((body) => service.status(body)),
    },
    {
      path: '/tuning/report',
      method: 'GET',
      handler: api((body, query) => service.report({ job_id: query.job_id, format: query.format ?? 'json' })),
    },
    {
      path: '/tuning/report',
      method: 'POST',
      handler: api((body) => service.report({ job_id: body.job_id, format: body.format ?? 'json' })),
    },
  ]
}

export function tuneErrorPayload(error) {
  return errorPayload(error)
}
