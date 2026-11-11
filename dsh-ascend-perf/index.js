/**
 * 昇腾性能工作台 —— Host 侧实现。
 *
 * 设计原则（对应 docs/tech-design.md）：
 * - 设备与远端只读：只执行 npu-smi info / npu-smi info -t usages -i N（可选 SSH），
 *   不启停服务、不跑 benchmark、不写远端文件。
 * - 导入只写本机私有仓储（默认 ~/.local/share/dsh-ascend-perf，0700/0600）。
 * - 所有对外结构遵循 `dsh-ascend-perf/v1` snake_case 契约。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包，便于以链接目录方式安装后被 DSH 直接加载；
 * 工具定义使用 ToolDefinition 所需的纯 JSON 结构。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { TUNE_SCHEMA, TuneService, createTuneRoutes, createTuneTools } from './tune.js'
import { DeployPlanService, createDeployRoutes, createDeployTools } from './deploy.js'

export const name = 'dsh-ascend-perf'
export const inject = ['tools', 'subprocess', 'webServer']

export const SCHEMA = 'dsh-ascend-perf/v1'
export const STORE_SCHEMA = 'dsh-ascend-perf/store-v1'
export const PARSER_VERSION = '1'
export const ALGORITHM_VERSION = 'compare-v1'
export const RULE_VERSION = 'rules-v1'

export const METRIC_KEYS = [
  'request_throughput_rps',
  'output_throughput_tps',
  'total_throughput_tps',
  'ttft_p50_ms',
  'ttft_p99_ms',
  'tpot_p50_ms',
  'tpot_p99_ms',
  'itl_p50_ms',
  'itl_p99_ms',
  'success_rate_pct',
]

export const PRIMARY_METRICS = [
  'output_throughput_tps',
  'ttft_p99_ms',
  'tpot_p99_ms',
  'success_rate_pct',
]

export const METRIC_META = {
  request_throughput_rps: { unit: 'req/s', direction: 'higher' },
  output_throughput_tps: { unit: 'token/s', direction: 'higher' },
  total_throughput_tps: { unit: 'token/s', direction: 'higher' },
  ttft_p50_ms: { unit: 'ms', direction: 'lower' },
  ttft_p99_ms: { unit: 'ms', direction: 'lower' },
  tpot_p50_ms: { unit: 'ms', direction: 'lower' },
  tpot_p99_ms: { unit: 'ms', direction: 'lower' },
  itl_p50_ms: { unit: 'ms', direction: 'lower' },
  itl_p99_ms: { unit: 'ms', direction: 'lower' },
  success_rate_pct: { unit: '%', direction: 'higher' },
}

const MAX_IMPORT_BYTES = 1024 * 1024
const MAX_CSV_ROWS = 10000
const MAX_JSON_OBJECTS = 200
const MAX_RUNS = 200
const MAX_SNAPSHOTS = 20
const STORE_LIMIT_BYTES = 5 * 1024 * 1024
const STALE_MS = 15 * 60 * 1000
const EXPORT_LIMIT_BYTES = 64 * 1024

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString()
const isoOrNull = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
const num = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[,%]/g, '').trim()
  if (cleaned === '' || cleaned === '-' || cleaned === 'NA' || cleaned === 'N/A') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}
const round = (value, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const f = 10 ** digits
  return Math.round(value * f) / f
}
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function baseSource(mode, isDemo) {
  return {
    mode,
    is_demo: Boolean(isDemo),
    evidence_kind: isDemo ? 'synthetic' : mode === 'import' ? 'unverified_import' : 'captured',
    host: mode === 'local' ? 'local' : null,
    path: null,
    source_ref: '',
    collected_at: mode === 'import' || isDemo ? null : nowIso(),
    sha256: null,
  }
}

function ok(kind, source, data, warnings = []) {
  return { schema: SCHEMA, kind, status: 'ok', readonly: true, source, warnings, data, error: null }
}
function degraded(kind, source, data, warnings = [], error = null) {
  return { schema: SCHEMA, kind, status: 'degraded', readonly: true, source, warnings, data, error }
}
function empty(kind, source, data, warnings = [], error = null) {
  return { schema: SCHEMA, kind, status: 'empty', readonly: true, source, warnings, data, error }
}
function failure(kind, source, code, message, details = null, retryable = false) {
  return {
    schema: SCHEMA,
    kind,
    status: 'error',
    readonly: true,
    source,
    warnings: [],
    data: null,
    error: { code, message, retryable, details },
  }
}

class ApiFailure extends Error {
  constructor(code, message, details = null, retryable = false) {
    super(message)
    this.code = code
    this.details = details
    this.retryable = retryable
  }
}

/* ------------------------------------------------------------------ */
/* npu-smi 解析                                                        */
/* ------------------------------------------------------------------ */

/**
 * 解析 `npu-smi info` 文本。真实环境为 8 卡 × 2 chip，每 chip 由“卡行 + 芯片行”两行组成；
 * 卡 ID 按表格第一列去重（禁止按行数当卡数），chip 由 Phy-ID 去重。
 */
export function parseNpuSmiInfo(text) {
  const result = { npu_smi: null, cards: [], processes: [], warnings: [] }
  const lines = String(text ?? '').split(/\r?\n/)
  let current = null
  let inProcesses = false
  let pendingCardRow = null

  for (const line of lines) {
    const versionMatch = line.match(/npu-smi\s+(\d+\.\d+\.\d+\S*)/)
    if (versionMatch && !result.npu_smi) result.npu_smi = versionMatch[1]
    if (/Process\s+id\s*\|\s*Process name/i.test(line)) {
      inProcesses = true
      continue
    }
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((s) => s.trim())
    if (cells.length < 2) continue

    if (inProcesses) {
      if (/No running processes/i.test(line)) continue
      const head = cells[0].split(/\s+/).filter(Boolean)
      if (head.length < 2) continue
      const npuId = num(head[0])
      const chipId = num(head[1])
      result.processes.push({
        pid: num(cells[1]),
        name: cells[2] || 'unknown',
        memory_mb: num(cells[3]),
        chip_id: chipId,
        npu_id: npuId,
        container_pid: num(cells[4]),
      })
      continue
    }

    const head = cells[0].split(/\s+/).filter(Boolean)
    const busIdCell = String(cells[1] ?? '')
    const isBusId = /^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}\.[0-7]$/.test(busIdCell)
    // 910B3 单 chip 卡：芯片行只有一列 chip id，第二列直接是 Bus-Id（没有 Phy-ID 列）。
    const singleChipRow = head.length === 1 && isBusId
    if (head.length < 1 || (head.length < 2 && !singleChipRow)) continue
    if (/^(NPU|Chip)$/i.test(head[0]) && /^(Name|Phy-ID)$/i.test(head[1] ?? '')) continue
    const secondIsNumeric = head.length >= 2 && /^\d+$/.test(head[1])

    if (!secondIsNumeric && !singleChipRow) {
      // 卡行：NPU ID + Name + Health + Power/Temp/Hugepages
      const cardId = num(head[0])
      if (cardId === null) continue
      const metrics = cells[2].split(/\s+/).filter(Boolean)
      const huge = cells[2].match(/(\d+)\s*\/\s*(\d+)/)
      pendingCardRow = {
        card_id: cardId,
        model: head.slice(1).join(' ') || null,
        health_raw: cells[1] || null,
        power_w: num(metrics[0]),
        temp_c: num(metrics[1]),
        hugepages: huge ? `${huge[1]} / ${huge[2]}` : null,
      }
      if (current) result.cards.push(current)
      current = {
        card_id: cardId,
        model: pendingCardRow.model,
        chips: [],
        processes: [],
      }
      continue
    }

    // 芯片行：Chip + Phy-ID + Bus-Id + AICore + Memory + HBM
    if (!current) continue
    if (current.chips.length > 0) {
      // 同一卡的第二个 chip 由“卡行 + 芯片行”再次开始；复用当前卡。
    }
    const chipId = num(head[0])
    const phyId = head.length >= 2 ? num(head[1]) : null
    const metrics = cells[2].split(/\s+/).filter(Boolean)
    const pairs = [...cells[2].matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)]
    const aicore = num(metrics[0])
    const memUsed = pairs[0] ? num(pairs[0][1]) : null
    const memTotal = pairs[0] ? num(pairs[0][2]) : null
    const hbmUsed = pairs[1] ? num(pairs[1][1]) : null
    const hbmTotal = pairs[1] ? num(pairs[1][2]) : null
    const chip = {
      chip_id: chipId,
      phy_id: phyId,
      bus_id: cells[1] || null,
      health_raw: pendingCardRow?.health_raw ?? null,
      health: healthFromRaw(pendingCardRow?.health_raw),
      temp_c: pendingCardRow?.temp_c ?? null,
      power_w: pendingCardRow?.power_w ?? null,
      aicore_pct: aicore,
      npu_util_pct: null,
      hbm_used_mb: hbmUsed,
      hbm_total_mb: hbmTotal,
      hbm_usage_rate_pct: hbmUsed !== null && hbmTotal ? round((hbmUsed / hbmTotal) * 100, 1) : null,
      hbm_reported_usage_rate_pct: null,
      memory_used_mb: memUsed,
      memory_total_mb: memTotal,
      memory_unit: 'MiB',
      aivector_pct: null,
      aicpu_pct: null,
      ctrlcpu_pct: null,
      ddr_bandwidth_pct: null,
      hbm_bandwidth_pct: null,
      aicube_pct: null,
      processes: [],
      processes_state: 'unknown',
      missing_reasons: {},
    }
    if (chip.power_w === null) chip.missing_reasons.power_w = '该芯片未上报功耗'
    if (chip.temp_c === null) chip.missing_reasons.temp_c = '该芯片未上报温度'
    current.chips.push(chip)
    pendingCardRow = null
  }
  if (current) result.cards.push(current)

  // 同一 NPU ID 的多个 chip 会以多组“卡行 + 芯片行”出现；按 card_id 合并。
  const mergedCards = new Map()
  for (const card of result.cards) {
    const existing = mergedCards.get(card.card_id)
    if (!existing) {
      mergedCards.set(card.card_id, { ...card, chips: [...card.chips], processes: [...(card.processes ?? [])] })
      continue
    }
    existing.chips.push(...card.chips)
    existing.processes.push(...(card.processes ?? []))
    if (!existing.model) existing.model = card.model
  }
  result.cards = [...mergedCards.values()].sort((a, b) => a.card_id - b.card_id)

  // 进程归属：按 (npu_id) 归属到卡，再按 chip_id 归属到 chip。
  for (const proc of result.processes) {
    const card = result.cards.find((c) => c.card_id === proc.npu_id)
    if (!card) continue
    const chip = card.chips.find((c) => c.chip_id === proc.chip_id)
    const item = {
      pid: proc.pid,
      name: proc.name,
      memory_mb: proc.memory_mb,
      chip_id: proc.chip_id,
      container_pid: proc.container_pid,
    }
    if (chip) chip.processes.push(item)
    else card.processes.push(item)
  }
  for (const card of result.cards) {
    const seen = new Set()
    card.chips = card.chips.filter((chip) => {
      const key = `${chip.chip_id}:${chip.phy_id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    for (const chip of card.chips) {
      chip.processes_state = chip.processes.length > 0 ? 'observed' : 'none_reported'
    }
  }
  if (result.cards.length === 0) result.warnings.push('未从 npu-smi info 输出中识别到设备行')
  return result
}

function healthFromRaw(raw) {
  if (!raw) return 'unknown'
  const v = String(raw).toLowerCase()
  if (v.includes('ok') || v.includes('healthy') || v.includes('normal')) return 'ok'
  if (v.includes('warn')) return 'warning'
  if (v.includes('crit') || v.includes('fail') || v.includes('alarm')) return 'critical'
  return 'unknown'
}

/**
 * 解析单卡 `npu-smi info -t usages -i N` 输出。每个 chip 以 `Chip ID` 收尾，
 * 指标键在 chip 块内重复；必须在 `Chip ID` 处复制当前块，避免两个 chip 共用末值。
 */
export function parseUsages(text) {
  const out = { npu_id: null, chip_count: null, chips: [], warnings: [] }
  const groups = String(text ?? '').split(/\n\s*\n/)
  for (const group of groups) {
    const kv = {}
    for (const line of group.split(/\r?\n/)) {
      const m = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/)
      if (m) kv[m[1]] = m[2]
    }
    if (kv['NPU ID'] !== undefined) out.npu_id = num(kv['NPU ID'])
    if (kv['Chip Count'] !== undefined) out.chip_count = num(kv['Chip Count'])
    if (kv['Chip ID'] !== undefined) {
      out.chips.push({
        chip_id: num(kv['Chip ID']),
        hbm_total_mb: num(kv['HBM Capacity(MB)']),
        hbm_reported_usage_rate_pct: num(kv['HBM Usage Rate(%)']),
        aicore_pct: num(kv['Aicore Usage Rate(%)']),
        aivector_pct: num(kv['Aivector Usage Rate(%)']),
        aicpu_pct: num(kv['Aicpu Usage Rate(%)']),
        ctrlcpu_pct: num(kv['Ctrlcpu Usage Rate(%)']),
        ddr_bandwidth_pct: num(kv['DDR Bandwidth Usage Rate(%)']),
        hbm_bandwidth_pct: num(kv['HBM Bandwidth Usage Rate(%)']),
        npu_util_pct: num(kv['NPU Utilization(%)']),
        aicube_pct: num(kv['Aicube Usage Rate(%)']),
        ddr_capacity_mb: num(kv['DDR Capacity(MB)']),
      })
    }
  }
  if (out.chips.length === 0) out.warnings.push('usages 输出中未找到 Chip ID 块')
  return out
}

/** 合并 info 与 usages；usages 缺失时保留 info 值并标记 missing_reason。 */
export function mergeUsages(cards, usagesByCard) {
  const warnings = []
  for (const card of cards) {
    const u = usagesByCard.get(card.card_id)
    if (!u || u.chips.length === 0) {
      for (const chip of card.chips) {
        chip.processes_state = chip.processes.length > 0 ? 'observed' : 'none_reported'
        chip.missing_reasons.usages = '未采集到该卡的 usages'
      }
      warnings.push(`卡 ${card.card_id} 的 usages 不可用`)
      continue
    }
    for (const chip of card.chips) {
      const usage = u.chips.find((c) => c.chip_id === chip.chip_id)
      if (!usage) {
        chip.missing_reasons.usages = 'usages 中缺少该 chip'
        warnings.push(`卡 ${card.card_id} chip ${chip.chip_id} 的 usages 缺失`)
        continue
      }
      chip.aicore_pct = usage.aicore_pct ?? chip.aicore_pct
      chip.aivector_pct = usage.aivector_pct
      chip.aicpu_pct = usage.aicpu_pct
      chip.ctrlcpu_pct = usage.ctrlcpu_pct
      chip.ddr_bandwidth_pct = usage.ddr_bandwidth_pct
      chip.hbm_bandwidth_pct = usage.hbm_bandwidth_pct
      chip.npu_util_pct = usage.npu_util_pct
      chip.aicube_pct = usage.aicube_pct
      chip.hbm_total_mb = chip.hbm_total_mb ?? usage.hbm_total_mb
      chip.hbm_reported_usage_rate_pct = usage.hbm_reported_usage_rate_pct
      if (chip.hbm_usage_rate_pct === null && chip.hbm_used_mb !== null && chip.hbm_total_mb) {
        chip.hbm_usage_rate_pct = round((chip.hbm_used_mb / chip.hbm_total_mb) * 100, 1)
      }
      chip.processes_state = chip.processes.length > 0 ? 'observed' : 'none_reported'
    }
  }
  return warnings
}

/* ------------------------------------------------------------------ */
/* benchmark 导入解析                                                  */
/* ------------------------------------------------------------------ */

function emptyMetrics() {
  const metrics = {}
  for (const key of METRIC_KEYS) {
    metrics[key] = { value: null, unit: METRIC_META[key].unit, direction: METRIC_META[key].direction, missing_reason: '文件中未提供该指标' }
  }
  return metrics
}

function setMetric(metrics, key, value, missingReason = null) {
  const meta = METRIC_META[key]
  metrics[key] = {
    value: value === undefined ? null : value,
    unit: meta.unit,
    direction: meta.direction,
    missing_reason: value === undefined || value === null ? missingReason || '文件中未提供该指标' : null,
  }
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      const n = num(obj[key])
      if (n !== null) return n
    }
  }
  return null
}

/**
 * 解析 vLLM benchmark JSON。真实文件常见别名：median_ttft_ms / p50_ttft_ms，
 * p99_ttft_ms，output_throughput，total_token_throughput。
 */
export function parseVllmJson(raw) {
  let obj
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (error) {
    throw new ApiFailure('PARSE_ERROR', 'JSON 解析失败', { reason: String(error?.message ?? error) })
  }
  if (!isPlainObject(obj)) throw new ApiFailure('PARSE_ERROR', 'JSON 顶层不是对象')
  const meta = isPlainObject(obj.metadata) ? obj.metadata : {}
  const workloadMeta = isPlainObject(meta.workload) ? meta.workload : {}
  const metrics = emptyMetrics()
  const warnings = []
  const fieldSources = {}

  const duration = pick(obj, ['duration', 'elapsed_time', 'elapsed'])
  const completed = pick(obj, ['completed', 'num_completed', 'successful_requests'])
  const prompts = pick(obj, ['num_prompts', 'request_count'])
  const totalOut = pick(obj, ['total_output_tokens', 'output_token_count']) ?? pick(meta, ['total_output_tokens'])
  const totalIn = pick(obj, ['total_input_tokens', 'input_token_count']) ?? pick(meta, ['total_input_tokens'])

  const direct = {
    request_throughput_rps: pick(obj, ['request_throughput', 'request_throughput_rps', 'requests_per_second']),
    output_throughput_tps: pick(obj, ['output_throughput', 'output_throughput_tps', 'output_tokens_per_second']),
    total_throughput_tps: pick(obj, ['total_token_throughput', 'total_throughput_tps', 'total_tokens_per_second']),
  }
  for (const [key, value] of Object.entries(direct)) {
    if (value !== null) {
      setMetric(metrics, key, value)
      fieldSources[key] = 'direct'
    }
  }
  if (metrics.request_throughput_rps.value === null && completed !== null && duration) {
    setMetric(metrics, 'request_throughput_rps', round(completed / duration, 2))
    fieldSources.request_throughput_rps = 'derived:completed/duration'
    warnings.push({ code: 'DERIVED_METRIC', field: 'request_throughput_rps', message: '请求吞吐由 completed/duration 推导', args: {} })
  }
  if (metrics.output_throughput_tps.value === null && totalOut !== null && duration) {
    setMetric(metrics, 'output_throughput_tps', round(totalOut / duration, 2))
    fieldSources.output_throughput_tps = 'derived:total_output_tokens/duration'
    warnings.push({ code: 'DERIVED_METRIC', field: 'output_throughput_tps', message: '输出吞吐由 token 数/时长推导', args: {} })
  }
  if (metrics.total_throughput_tps.value === null && totalOut !== null && duration) {
    setMetric(metrics, 'total_throughput_tps', round((totalOut + (totalIn ?? 0)) / duration, 2))
    fieldSources.total_throughput_tps = 'derived:(input+output)/duration'
  }

  const aliases = {
    ttft_p50_ms: ['median_ttft_ms', 'p50_ttft_ms', 'mean_ttft_ms'],
    ttft_p99_ms: ['p99_ttft_ms'],
    tpot_p50_ms: ['median_tpot_ms', 'p50_tpot_ms', 'mean_tpot_ms'],
    tpot_p99_ms: ['p99_tpot_ms'],
    itl_p50_ms: ['median_itl_ms', 'p50_itl_ms', 'mean_itl_ms'],
    itl_p99_ms: ['p99_itl_ms'],
  }
  for (const [key, keys] of Object.entries(aliases)) {
    const value = pick(obj, keys)
    if (value !== null) {
      setMetric(metrics, key, value)
      fieldSources[key] = 'direct'
    }
  }

  let success = pick(obj, ['success_rate', 'success_rate_pct'])
  if (success === null && completed !== null && prompts) success = round((completed / prompts) * 100, 2)
  if (success !== null) {
    setMetric(metrics, 'success_rate_pct', success)
    fieldSources.success_rate_pct = 'direct'
  }

  const timestamp = isoOrNull(obj.date ?? obj.timestamp ?? meta.date ?? meta.timestamp)
  if (!timestamp) warnings.push({ code: 'TIMESTAMP_UNKNOWN', field: 'timestamp', message: '文件未提供可识别的时间，使用导入时间', args: {} })

  const validMetrics = METRIC_KEYS.filter((key) => metrics[key].value !== null)
  if (validMetrics.length === 0) {
    throw new ApiFailure('NO_VALID_ROWS', '没有可用的性能指标', { expected: METRIC_KEYS })
  }

  const workload = {
    model: str(obj.model_id ?? obj.model ?? meta.model_id ?? workloadMeta.model),
    cards: pick(obj, ['cards', 'num_cards']) ?? pick(workloadMeta, ['cards', 'num_cards']),
    input_len: pick(obj, ['input_len', 'random_input_len']) ?? pick(workloadMeta, ['input_len', 'random_input_len']),
    output_len: pick(obj, ['output_len', 'random_output_len']) ?? pick(workloadMeta, ['output_len', 'random_output_len']),
    concurrency: pick(obj, ['concurrency', 'max_concurrency']) ?? pick(workloadMeta, ['concurrency', 'max_concurrency']),
    request_rate_rps: parseRequestRate(obj, workloadMeta),
    request_rate_mode: requestRateMode(obj, workloadMeta),
    dataset: str(obj.dataset ?? meta.dataset ?? workloadMeta.dataset),
    precision: str(obj.precision ?? meta.precision ?? workloadMeta.precision),
  }
  const env = {
    hardware: str(obj.hardware ?? meta.hardware),
    cann: str(obj.cann ?? meta.cann ?? obj.cann_version),
    framework: str(obj.framework ?? meta.framework ?? 'vllm'),
    framework_version: str(obj.framework_version ?? meta.framework_version ?? obj.vllm_version),
    backend: str(obj.backend ?? meta.backend ?? 'vllm-ascend'),
    tensor_parallel: pick(obj, ['tensor_parallel', 'tp']) ?? pick(meta, ['tensor_parallel', 'tp']),
    notes: null,
  }
  const hotspots = parseHotspotsFromJson(obj)
  return {
    format: 'vllm-json',
    run: makeRun({
      label: str(obj.label ?? obj.run_label) || str(obj.model_id ?? obj.model) || 'imported-run',
      timestamp,
      metrics,
      workload,
      env,
      hotspots,
      format: 'vllm-json',
      fieldSources,
      missingReasons: {},
      ignoredFields: [],
      warnings,
      acceptedRows: 1,
      rejectedRows: 0,
    }),
    warnings,
  }
}

function str(value) {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

function parseRequestRate(obj, workloadMeta) {
  const raw = obj.request_rate ?? workloadMeta.request_rate
  if (raw === 'inf' || raw === Infinity) return null
  return num(raw)
}
function requestRateMode(obj, workloadMeta) {
  const raw = obj.request_rate ?? workloadMeta.request_rate
  if (raw === 'inf' || raw === Infinity) return 'unbounded'
  if (num(raw) !== null) return 'finite'
  return 'unknown'
}

function parseHotspotsFromJson(obj) {
  const list = Array.isArray(obj.hotspots) ? obj.hotspots : Array.isArray(obj.op_summary) ? obj.op_summary : []
  const total = list.reduce((sum, row) => sum + (num(row.total_duration_us) ?? 0), 0)
  return list.slice(0, 50).map((row) => ({
    op_name: String(row.op_name ?? row.name ?? 'unknown'),
    op_type: str(row.op_type ?? row.type),
    task_type: str(row.task_type),
    calls: num(row.calls),
    total_duration_us: num(row.total_duration_us) ?? 0,
    mean_duration_us: num(row.mean_duration_us),
    share_pct: total > 0 ? round(((num(row.total_duration_us) ?? 0) / total) * 100, 2) : 0,
    source_rows: [],
  }))
}

function makeRun(input) {
  return {
    run_id: newId('run'),
    label: input.label,
    created_at: nowIso(),
    timestamp: input.timestamp ?? null,
    timestamp_source: input.timestamp ? 'input' : 'unknown',
    source: {
      ...baseSource('import', false),
      path: input.filename ? safeBasename(input.filename) : null,
      source_ref: input.sha ? input.sha : '',
      sha256: input.sha ?? null,
    },
    env: input.env,
    workload: input.workload,
    metrics: input.metrics,
    hotspots: input.hotspots ?? [],
    snapshot_id: null,
    provenance: {
      format: input.format,
      parser_version: PARSER_VERSION,
      accepted_rows: input.acceptedRows ?? 1,
      rejected_rows: input.rejectedRows ?? 0,
      total_hotspot_duration_us: input.hotspots?.length ? round(input.hotspots.reduce((s, h) => s + h.total_duration_us, 0), 2) : null,
      field_sources: input.fieldSources ?? {},
      missing_reasons: input.missingReasons ?? {},
      ignored_fields: input.ignoredFields ?? [],
    },
    _warnings: input.warnings ?? [],
  }
}

function safeBasename(name) {
  const s = String(name ?? '').replace(/\\/g, '/').split('/').pop()
  return s && s !== '.' && s !== '..' ? s.slice(0, 120) : null
}

/** 极简 RFC4180 CSV 解析（支持引号、转义、BOM、CRLF）。 */
export function parseCsv(text) {
  let input = String(text ?? '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (rows.length > MAX_CSV_ROWS + 2) throw new ApiFailure('INPUT_TOO_LARGE', `CSV 超过 ${MAX_CSV_ROWS} 行`)
    } else if (ch === '\r') {
      // 忽略，等待 \n
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const CSV_METRIC_COLUMNS = {
  request_throughput_rps: ['request_throughput_rps', 'request_throughput'],
  output_throughput_tps: ['output_throughput_tps', 'output_throughput'],
  total_throughput_tps: ['total_throughput_tps', 'total_token_throughput'],
  ttft_p50_ms: ['ttft_p50_ms', 'median_ttft_ms'],
  ttft_p99_ms: ['ttft_p99_ms', 'p99_ttft_ms'],
  tpot_p50_ms: ['tpot_p50_ms', 'median_tpot_ms'],
  tpot_p99_ms: ['tpot_p99_ms', 'p99_tpot_ms'],
  itl_p50_ms: ['itl_p50_ms', 'median_itl_ms'],
  itl_p99_ms: ['itl_p99_ms', 'p99_itl_ms'],
  success_rate_pct: ['success_rate_pct', 'success_rate'],
}

/** 解析 benchmark 指标 CSV；每一行产出一个 run。 */
export function parseBenchmarkCsv(raw, filename = null) {
  const rows = parseCsv(raw)
  if (rows.length < 2) throw new ApiFailure('NO_VALID_ROWS', 'CSV 没有数据行')
  const header = rows[0].map((h) => h.trim())
  const index = new Map(header.map((h, i) => [h.toLowerCase(), i]))
  const get = (row, names) => {
    for (const name of names) {
      const i = index.get(name.toLowerCase())
      if (i !== undefined && row[i] !== undefined && row[i] !== '') return row[i]
    }
    return null
  }
  const runs = []
  const warnings = []
  const rejected = []
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]
    if (row.length === 1 && row[0].trim() === '') continue
    if (row.length > 128) {
      rejected.push({ row: r + 1, reason: '列数超过 128' })
      continue
    }
    const metrics = emptyMetrics()
    const fieldSources = {}
    for (const [key, names] of Object.entries(CSV_METRIC_COLUMNS)) {
      const value = num(get(row, names))
      if (value !== null) {
        setMetric(metrics, key, value)
        fieldSources[key] = 'direct'
      }
    }
    const valid = METRIC_KEYS.filter((key) => metrics[key].value !== null)
    if (valid.length === 0) {
      rejected.push({ row: r + 1, reason: '没有有效性能指标' })
      continue
    }
    const timestamp = isoOrNull(get(row, ['timestamp', 'date']))
    if (!timestamp) warnings.push({ code: 'TIMESTAMP_UNKNOWN', field: 'timestamp', message: `第 ${r + 1} 行缺少可识别时间`, args: {} })
    const workload = {
      model: str(get(row, ['model', 'model_id'])),
      cards: num(get(row, ['cards'])),
      input_len: num(get(row, ['input_len'])),
      output_len: num(get(row, ['output_len'])),
      concurrency: num(get(row, ['concurrency'])),
      request_rate_rps: num(get(row, ['request_rate_rps'])),
      request_rate_mode: str(get(row, ['request_rate_mode'])) ?? 'unknown',
      dataset: str(get(row, ['dataset'])),
      precision: str(get(row, ['precision'])),
    }
    const env = {
      hardware: str(get(row, ['hardware'])),
      cann: str(get(row, ['cann'])),
      framework: str(get(row, ['framework'])),
      framework_version: str(get(row, ['framework_version'])),
      backend: str(get(row, ['backend'])),
      tensor_parallel: num(get(row, ['tensor_parallel'])),
      notes: null,
    }
    runs.push(
      makeRun({
        label: str(get(row, ['label'])) || `csv-row-${r}`,
        timestamp,
        metrics,
        workload,
        env,
        hotspots: [],
        format: 'benchmark-csv',
        filename,
        fieldSources,
        warnings,
        acceptedRows: 1,
        rejectedRows: 0,
      }),
    )
  }
  if (runs.length === 0) {
    throw new ApiFailure('NO_VALID_ROWS', 'CSV 中没有可用的性能指标', { rejected })
  }
  return { runs, warnings, rejected }
}

/** 解析 msprof op_summary CSV，仅产出热点。 */
export function parseMsprofCsv(raw) {
  const rows = parseCsv(raw)
  if (rows.length < 2) throw new ApiFailure('NO_VALID_ROWS', 'msprof CSV 没有数据行')
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const idx = (names) => {
    for (const name of names) {
      const i = header.indexOf(name.toLowerCase())
      if (i >= 0) return i
    }
    return -1
  }
  const opNameIdx = idx(['Op Name', 'op_name', 'name'])
  const durationIdx = idx(['Task Duration(us)', 'task_duration_us', 'duration_us'])
  if (opNameIdx < 0 || durationIdx < 0) {
    throw new ApiFailure('PARSE_ERROR', 'msprof CSV 缺少 Op Name 或 Task Duration(us) 列')
  }
  const opTypeIdx = idx(['OP Type', 'op_type'])
  const taskTypeIdx = idx(['Task Type', 'task_type'])
  const groups = new Map()
  let total = 0
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]
    if (!row || row.length <= durationIdx) continue
    const name = String(row[opNameIdx] ?? '').trim()
    const duration = num(row[durationIdx])
    if (!name || duration === null || duration <= 0) continue
    const opType = opTypeIdx >= 0 ? str(row[opTypeIdx]) : null
    const taskType = taskTypeIdx >= 0 ? str(row[taskTypeIdx]) : null
    const key = `${name}\u0000${opType ?? ''}\u0000${taskType ?? ''}`
    const item = groups.get(key) ?? { op_name: name, op_type: opType, task_type: taskType, calls: 0, total_duration_us: 0, source_rows: [] }
    item.calls += 1
    item.total_duration_us += duration
    item.source_rows.push(r + 1)
    groups.set(key, item)
    total += duration
  }
  if (groups.size === 0) throw new ApiFailure('NO_VALID_ROWS', 'msprof CSV 中没有有效算子耗时')
  const hotspots = [...groups.values()]
    .map((item) => ({
      ...item,
      mean_duration_us: round(item.total_duration_us / item.calls, 2),
      share_pct: round((item.total_duration_us / total) * 100, 2),
      total_duration_us: round(item.total_duration_us, 2),
    }))
    .sort((a, b) => b.total_duration_us - a.total_duration_us)
    .slice(0, 50)
  return { hotspots, totalDurationUs: round(total, 2), acceptedRows: groups.size }
}

/* ------------------------------------------------------------------ */
/* 比较                                                                */
/* ------------------------------------------------------------------ */

export function compareRuns(baseline, candidate, thresholdPct = 5) {
  const threshold = clampThreshold(thresholdPct)
  const issues = []
  const comparability = evaluateComparability(baseline, candidate, issues)
  const metrics = METRIC_KEYS.map((key) => {
    const meta = METRIC_META[key]
    const base = baseline.metrics?.[key]?.value ?? null
    const cand = candidate.metrics?.[key]?.value ?? null
    const missingReason = base === null ? baseline.metrics?.[key]?.missing_reason ?? '基线缺失' : cand === null ? candidate.metrics?.[key]?.missing_reason ?? '候选缺失' : null
    let verdict = 'stable'
    let deltaAbs = null
    let deltaPct = null
    let adverse = null
    if (base === null || cand === null) {
      verdict = 'missing'
    } else {
      deltaAbs = round(cand - base, 4)
      if (base === 0) {
        verdict = 'zero_baseline'
        deltaPct = null
        adverse = null
      } else {
        deltaPct = round((100 * (cand - base)) / Math.abs(base), 2)
        adverse = meta.direction === 'lower' ? deltaPct : meta.direction === 'higher' ? -deltaPct : null
        // -0 不能无损往返 JSON（JSON.stringify(-0) === "0"），统一归一为 0
        if (Object.is(deltaAbs, -0)) deltaAbs = 0
        if (Object.is(deltaPct, -0)) deltaPct = 0
        if (Object.is(adverse, -0)) adverse = 0
        if (comparability !== 'matched') verdict = 'descriptive'
        else if (adverse !== null && adverse >= threshold) verdict = 'regressed'
        else if (adverse !== null && adverse <= -threshold) verdict = 'improved'
        else if (meta.direction === 'neutral') verdict = 'descriptive'
        else verdict = 'stable'
      }
    }
    return {
      key,
      unit: meta.unit,
      direction: meta.direction,
      baseline: base,
      candidate: cand,
      delta_abs: deltaAbs,
      delta_pct: deltaPct,
      adverse_delta_pct: adverse,
      verdict,
      threshold,
      missing_reason: missingReason,
    }
  })

  const primary = metrics.filter((m) => PRIMARY_METRICS.includes(m.key))
  let conclusion
  let code
  if (comparability === 'mismatch') {
    conclusion = 'not_comparable'
    code = 'comparison.not_comparable'
  } else if (comparability === 'unknown') {
    conclusion = 'inconclusive'
    code = 'comparison.inconclusive'
  } else if (primary.some((m) => m.verdict === 'regressed')) {
    conclusion = 'regressed'
    code = 'comparison.regressed'
  } else if (primary.some((m) => m.verdict === 'missing')) {
    conclusion = 'inconclusive'
    code = 'comparison.inconclusive'
  } else if (metrics.some((m) => m.verdict === 'improved')) {
    conclusion = 'improved'
    code = 'comparison.improved'
  } else if (metrics.every((m) => m.verdict === 'stable' || m.verdict === 'missing' || m.verdict === 'zero_baseline')) {
    conclusion = 'stable'
    code = 'comparison.stable'
  } else {
    conclusion = 'stable'
    code = 'comparison.stable'
  }

  const verdictCounts = { improved: 0, regressed: 0, stable: 0, descriptive: 0, missing: 0, zero_baseline: 0 }
  for (const m of metrics) verdictCounts[m.verdict] += 1

  return {
    baseline_run_id: baseline.run_id,
    candidate_run_id: candidate.run_id,
    comparable: comparability === 'matched',
    comparability,
    comparability_issues: issues,
    metrics,
    primary_metrics: PRIMARY_METRICS,
    incomplete: metrics.some((m) => m.verdict === 'missing'),
    summary: {
      conclusion,
      code,
      args: { threshold, baseline_label: baseline.label, candidate_label: candidate.label },
      message: conclusionMessage(conclusion, threshold),
    },
    verdict_counts: verdictCounts,
    computed_at: nowIso(),
    algorithm_version: ALGORITHM_VERSION,
    threshold_pct: threshold,
  }
}

function clampThreshold(value) {
  const n = num(value)
  if (n === null) return 5
  return Math.min(50, Math.max(0.1, n))
}

function conclusionMessage(conclusion, threshold) {
  switch (conclusion) {
    case 'regressed':
      return `候选存在超过 ±${threshold}% 的主要指标回归。`
    case 'improved':
      return `候选存在超过 ±${threshold}% 的改善，且主要指标无回归。`
    case 'stable':
      return `主要指标在 ±${threshold}% 内保持稳定。`
    case 'not_comparable':
      return '环境或 workload 关键条件不一致，仅展示描述性差值。'
    default:
      return '关键条件或指标不足，结论不确定。'
  }
}

function evaluateComparability(baseline, candidate, issues) {
  const checks = [
    ['workload', 'model', baseline.workload?.model, candidate.workload?.model],
    ['workload', 'cards', baseline.workload?.cards, candidate.workload?.cards],
    ['workload', 'input_len', baseline.workload?.input_len, candidate.workload?.input_len],
    ['workload', 'output_len', baseline.workload?.output_len, candidate.workload?.output_len],
    ['workload', 'concurrency', baseline.workload?.concurrency, candidate.workload?.concurrency],
    ['workload', 'dataset', baseline.workload?.dataset, candidate.workload?.dataset],
    ['workload', 'precision', baseline.workload?.precision, candidate.workload?.precision],
    ['env', 'cann', baseline.env?.cann, candidate.env?.cann],
    ['env', 'framework', baseline.env?.framework, candidate.env?.framework],
    ['env', 'framework_version', baseline.env?.framework_version, candidate.env?.framework_version],
    ['env', 'backend', baseline.env?.backend, candidate.env?.backend],
    ['env', 'tensor_parallel', baseline.env?.tensor_parallel, candidate.env?.tensor_parallel],
  ]
  let mismatch = false
  let unknown = false
  for (const [scope, field, a, b] of checks) {
    if (a === null || a === undefined || b === null || b === undefined) {
      unknown = true
      issues.push({ code: 'COMPARABILITY_UNKNOWN', field: `${scope}.${field}`, message: `${scope}.${field} 缺失，无法确认可比性`, args: { baseline: a, candidate: b } })
    } else if (String(a) !== String(b)) {
      mismatch = true
      issues.push({ code: 'COMPARABILITY_MISMATCH', field: `${scope}.${field}`, message: `${scope}.${field} 不一致`, args: { baseline: a, candidate: b } })
    }
  }
  if (mismatch) return 'mismatch'
  if (unknown) return 'unknown'
  return 'matched'
}

/* ------------------------------------------------------------------ */
/* 洞察                                                                */
/* ------------------------------------------------------------------ */

export function generateInsights({ snapshot = null, runs = [], comparison = null, thresholdPct = 5, previousSnapshot = null } = {}) {
  const insights = []
  const skipped = []
  const push = (rule, severity, title, evidence, suggestion, confidence = 'observed') => {
    insights.push({
      id: newId('ins'),
      severity,
      rule_id: rule,
      code: `rule.${rule}`,
      args: {},
      title,
      evidence,
      suggestion,
      confidence,
      created_at: nowIso(),
    })
  }

  if (snapshot && Array.isArray(snapshot.npu?.cards)) {
    for (const card of snapshot.npu.cards) {
      for (const chip of card.chips ?? []) {
        if (chip.hbm_usage_rate_pct !== null && chip.hbm_usage_rate_pct >= 90) {
          push(
            'HBM_PRESSURE',
            'warning',
            `NPU ${card.card_id} chip ${chip.chip_id} HBM 使用率 ${chip.hbm_usage_rate_pct}%`,
            [{ ref: `snapshot:card_${card.card_id}/chip_${chip.chip_id}/hbm_usage_rate_pct`, field: 'hbm_usage_rate_pct', value: chip.hbm_usage_rate_pct, unit: '%', collected_at: snapshot.captured_at }],
            '检查残留进程或减少常驻权重后重新采集。',
          )
        }
        if (chip.temp_c !== null && chip.temp_c >= 85) {
          push(
            'TEMP_HIGH',
            'warning',
            `NPU ${card.card_id} chip ${chip.chip_id} 温度 ${chip.temp_c}°C`,
            [{ ref: `snapshot:card_${card.card_id}/chip_${chip.chip_id}/temp_c`, field: 'temp_c', value: chip.temp_c, unit: '°C', collected_at: snapshot.captured_at }],
            '检查散热与风扇状态，避免持续高温运行。',
          )
        }
        const prev = previousSnapshot?.npu?.cards
          ?.find((c) => c.card_id === card.card_id)
          ?.chips?.find((c) => c.chip_id === chip.chip_id)
        if (prev && prev.power_w && chip.power_w) {
          const change = ((chip.power_w - prev.power_w) / prev.power_w) * 100
          if (Math.abs(change) >= 30) {
            push(
              'POWER_CHANGE',
              'notice',
              `NPU ${card.card_id} chip ${chip.chip_id} 功耗变化 ${round(change, 1)}%`,
              [
                { ref: `snapshot:card_${card.card_id}/chip_${chip.chip_id}/power_w`, field: 'power_w', value: chip.power_w, unit: 'W', collected_at: snapshot.captured_at },
                { ref: 'snapshot:previous/power_w', field: 'power_w', value: prev.power_w, unit: 'W', collected_at: previousSnapshot?.captured_at ?? null },
              ],
              '确认是否有新负载启动或任务结束；功耗变化本身不构成性能回归。',
            )
          }
        }
      }
    }
  }

  if (comparison) {
    const byKey = new Map(comparison.metrics.map((m) => [m.key, m]))
    const ttft = byKey.get('ttft_p99_ms')
    const tpot = byKey.get('tpot_p99_ms')
    const success = byKey.get('success_rate_pct')
    if (comparison.comparability === 'matched' && ttft?.verdict === 'regressed' && tpot?.verdict !== 'regressed') {
      push(
        'TTFT_REGRESSION',
        'warning',
        `TTFT p99 回归 ${ttft.adverse_delta_pct}%（${ttft.baseline} → ${ttft.candidate} ms）`,
        [{ ref: 'compare:candidate/ttft_p99_ms', field: 'ttft_p99_ms', value: ttft.candidate, unit: 'ms', collected_at: comparison.computed_at }],
        '检查请求排队、prefill 批处理与输入长度变化。',
      )
    }
    if (comparison.comparability === 'matched' && tpot?.verdict === 'regressed') {
      push(
        'TPOT_REGRESSION',
        'warning',
        `TPOT p99 回归 ${tpot.adverse_delta_pct}%（${tpot.baseline} → ${tpot.candidate} ms）`,
        [{ ref: 'compare:candidate/tpot_p99_ms', field: 'tpot_p99_ms', value: tpot.candidate, unit: 'ms', collected_at: comparison.computed_at }],
        '检查 decode 阶段批大小、KV cache 与算子耗时。',
      )
    }
    if (success && success.candidate !== null && success.candidate < 99) {
      push(
        'SUCCESS_LOW',
        'critical',
        `候选成功率 ${success.candidate}%，低于 99%`,
        [{ ref: 'compare:candidate/success_rate_pct', field: 'success_rate_pct', value: success.candidate, unit: '%', collected_at: comparison.computed_at }],
        '优先检查超时、OOM 与请求错误日志，再比较性能。',
      )
    } else if (!success || success.candidate === null) {
      skipped.push({ rule_id: 'SUCCESS_LOW', reason: '成功率缺失' })
    }

    const candidate = runs.find((r) => r.run_id === comparison.candidate_run_id)
    if (candidate?.hotspots?.length) {
      const top = candidate.hotspots[0]
      if (top.share_pct >= 30) {
        push(
          'HOTSPOT_CONCENTRATION',
          'info',
          `算子 ${top.op_name} 占总任务耗时 ${top.share_pct}%`,
          [{ ref: 'run:candidate/hotspots', field: 'share_pct', value: top.share_pct, unit: '%', collected_at: candidate.timestamp ?? candidate.created_at }],
          '优先分析该算子的输入形状、切分与融合机会。',
        )
      }
    } else if (comparison) {
      skipped.push({ rule_id: 'HOTSPOT_CONCENTRATION', reason: '该运行未提供算子级数据' })
    }

    // 并发饱和要求“同模型、其他 workload 条件一致、仅并发不同”，
    // 因此不能复用 comparison.comparability（并发不同会被判 mismatch）。
    const refRun = candidate ?? runs[runs.length - 1] ?? null
    const comparableFields = ['cards', 'input_len', 'output_len', 'dataset', 'precision']
    const sameWorkload = (r) =>
      Boolean(r.workload?.model) &&
      r.workload.model === refRun?.workload?.model &&
      comparableFields.every((k) => (r.workload?.[k] ?? null) === (refRun?.workload?.[k] ?? null))
    const concurrencyRuns = runs
      .filter(sameWorkload)
      .sort((a, b) => (a.workload?.concurrency ?? 0) - (b.workload?.concurrency ?? 0))
    if (concurrencyRuns.length >= 3) {
      const highest = concurrencyRuns[concurrencyRuns.length - 1]
      const previous = concurrencyRuns[concurrencyRuns.length - 2]
      const cHigh = highest.workload?.concurrency
      const cPrev = previous.workload?.concurrency
      const outHigh = highest.metrics?.output_throughput_tps?.value
      const outPrev = previous.metrics?.output_throughput_tps?.value
      const ttftHigh = highest.metrics?.ttft_p99_ms?.value
      const ttftPrev = previous.metrics?.ttft_p99_ms?.value
      if (cHigh && cPrev && cHigh >= 2 * cPrev && outHigh !== null && outPrev) {
        const outGain = ((outHigh - outPrev) / outPrev) * 100
        const ttftGain = ttftHigh !== null && ttftPrev ? ((ttftHigh - ttftPrev) / ttftPrev) * 100 : null
        if (outGain < 5 && ttftGain !== null && ttftGain >= 20 && (highest.metrics?.success_rate_pct?.value ?? 100) >= 99) {
          push(
            'CONCURRENCY_SATURATION',
            'notice',
            `并发 ${cPrev}→${cHigh} 时输出吞吐仅增 ${round(outGain, 1)}%，TTFT p99 增 ${round(ttftGain, 1)}%`,
            [
              { ref: 'run:high/concurrency', field: 'concurrency', value: cHigh, unit: null, collected_at: highest.timestamp ?? highest.created_at },
              { ref: 'run:high/output_throughput_tps', field: 'output_throughput_tps', value: outHigh, unit: 'token/s', collected_at: highest.timestamp ?? highest.created_at },
            ],
            '继续提高并发收益有限，优先排查调度与显存带宽瓶颈。',
            'heuristic',
          )
        } else {
          skipped.push({ rule_id: 'CONCURRENCY_SATURATION', reason: '并发序列未显示饱和特征' })
        }
      } else {
        skipped.push({ rule_id: 'CONCURRENCY_SATURATION', reason: '缺少可比较的并发与吞吐序列' })
      }
    } else {
      skipped.push({ rule_id: 'CONCURRENCY_SATURATION', reason: '至少需要 3 条同模型运行记录' })
    }
  } else {
    skipped.push({ rule_id: 'TTFT_REGRESSION', reason: '没有对比结果' })
    skipped.push({ rule_id: 'TPOT_REGRESSION', reason: '没有对比结果' })
    skipped.push({ rule_id: 'SUCCESS_LOW', reason: '没有对比结果' })
    skipped.push({ rule_id: 'HOTSPOT_CONCENTRATION', reason: '没有对比结果' })
    skipped.push({ rule_id: 'CONCURRENCY_SATURATION', reason: '没有对比结果' })
  }

  const rank = { critical: 0, warning: 1, notice: 2, info: 3 }
  insights.sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule_id.localeCompare(b.rule_id))
  const omitted = Math.max(0, insights.length - 20)
  return {
    insights: insights.slice(0, 20),
    skipped_rules: skipped,
    rule_version: RULE_VERSION,
    input_refs: [
      comparison ? `compare:${comparison.baseline_run_id}:${comparison.candidate_run_id}` : null,
      snapshot ? `snapshot:${snapshot.snapshot_id}` : null,
    ].filter(Boolean),
    omitted_count: omitted,
  }
}

/* ------------------------------------------------------------------ */
/* 快照与采集                                                          */
/* ------------------------------------------------------------------ */

function emptySnapshot(source, availability, error = null) {
  return {
    snapshot_id: newId('snap'),
    captured_at: nowIso(),
    availability,
    host: { alias: source.host ?? 'local', arch: null },
    software: { npu_smi: null, cann: null },
    npu: { card_count: 0, chip_count: 0, memory_unit: 'MiB', cards: [] },
    runtime: null,
    storage: null,
    collection: { duration_ms: 0, command_ids: [], stale: false, partial: false },
    error,
    source,
  }
}

function finalizeSnapshot({ source, npuSmi, arch, cards, warnings, durationMs, commandIds, partial }) {
  const cardsOut = cards.map((card) => ({
    card_id: card.card_id,
    model: card.model,
    power_w: null,
    temp_c: null,
    health: card.chips.every((c) => c.health === 'ok') ? 'ok' : card.chips.some((c) => c.health === 'critical') ? 'critical' : 'warning',
    chips: card.chips.map((chip) => ({
      chip_id: chip.chip_id,
      phy_id: chip.phy_id,
      bus_id: chip.bus_id,
      health: chip.health,
      health_raw: chip.health_raw,
      temp_c: chip.temp_c,
      power_w: chip.power_w,
      aicore_pct: chip.aicore_pct,
      npu_util_pct: chip.npu_util_pct,
      aivector_pct: chip.aivector_pct,
      aicpu_pct: chip.aicpu_pct,
      ctrlcpu_pct: chip.ctrlcpu_pct,
      hbm_used_mb: chip.hbm_used_mb,
      hbm_total_mb: chip.hbm_total_mb,
      hbm_usage_rate_pct: chip.hbm_usage_rate_pct,
      hbm_reported_usage_rate_pct: chip.hbm_reported_usage_rate_pct,
      ddr_bandwidth_pct: chip.ddr_bandwidth_pct,
      hbm_bandwidth_pct: chip.hbm_bandwidth_pct,
      aicube_pct: chip.aicube_pct,
      processes: chip.processes,
      processes_state: chip.processes_state,
      missing_reasons: chip.missing_reasons,
    })),
    processes: card.processes,
  }))
  const chipCount = cardsOut.reduce((sum, card) => sum + card.chips.length, 0)
  return {
    snapshot_id: newId('snap'),
    captured_at: nowIso(),
    availability: cardsOut.length === 0 ? 'no_device' : 'available',
    host: { alias: source.host ?? 'local', arch: arch ?? null },
    software: { npu_smi: npuSmi ?? null, cann: null },
    npu: { card_count: cardsOut.length, chip_count: chipCount, memory_unit: 'MiB', cards: cardsOut },
    runtime: null,
    storage: null,
    collection: {
      duration_ms: durationMs,
      command_ids: commandIds,
      stale: false,
      partial: Boolean(partial),
    },
    error: null,
    source,
    _warnings: warnings,
  }
}

async function runCommand(ctx, cfg, argv, signal) {
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd: cfg.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 256 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 1500,
      signal,
      env: {},
    })
  } catch (error) {
    const e = new ApiFailure('COMMAND_MISSING', `无法启动命令 ${argv[0]}`, { reason: String(error?.message ?? error) })
    e.code = error?.code === 'ENOENT' ? 'COMMAND_MISSING' : 'COMMAND_FAILED'
    throw e
  }
  const timer = setTimeout(() => handle.terminate(), cfg.timeout)
  try {
    const outcome = await handle.done
    const out = handle.collected.stdout?.readFrom(0)?.text ?? ''
    const err = handle.collected.stderr?.readFrom(0)?.text ?? ''
    return { exitCode: outcome.exitCode, signal: outcome.signal, stdout: out, stderr: err }
  } catch (error) {
    const e = new ApiFailure('COMMAND_FAILED', '命令执行失败', { reason: String(error?.message ?? error) })
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

async function collectLocal(ctx, cfg, { force } = {}) {
  const started = Date.now()
  const source = baseSource('local', false)
  const commandIds = ['npu-smi info']
  let resolved
  try {
    resolved = await ctx.subprocess.resolveExecutable(cfg.npuSmiPath, {})
  } catch (error) {
    return { result: empty('snapshot', source, emptySnapshot(source, 'command_missing'), [], { code: 'COMMAND_MISSING', message: '未找到 npu-smi', retryable: false, details: null }) }
  }
  const run = await runCommand(ctx, cfg, [resolved, 'info'])
  if (run.exitCode !== 0) {
    const code = run.exitCode === 215 ? 'USAGES_ARG_REQUIRED' : 'COMMAND_FAILED'
    return {
      result: degraded('snapshot', source, emptySnapshot(source, 'unknown'), [
        { code, field: null, message: run.exitCode === 215 ? '该版本裸 -t usages 需要 -i 参数' : `npu-smi info 退出码 ${run.exitCode}`, args: { exit_code: run.exitCode } },
      ]),
    }
  }
  const parsed = parseNpuSmiInfo(run.stdout)
  if (parsed.cards.length === 0) {
    return { result: empty('snapshot', source, emptySnapshot(source, 'no_device'), parsed.warnings, { code: 'NO_DEVICE', message: '未发现 NPU 设备', retryable: false, details: null }) }
  }
  const warnings = []
  const usages = new Map()
  // 逐卡采集（真实环境 8 卡 16 chip；并发上限 2）
  const cardIds = parsed.cards.map((c) => c.card_id)
  let cursor = 0
  const worker = async () => {
    while (cursor < cardIds.length) {
      const idx = cursor++
      const cardId = cardIds[idx]
      commandIds.push(`npu-smi info -t usages -i ${cardId}`)
      try {
        const u = await runCommand(ctx, cfg, [resolved, 'info', '-t', 'usages', '-i', String(cardId)])
        if (u.exitCode === 0) usages.set(cardId, parseUsages(u.stdout))
        else warnings.push({ code: 'USAGES_INCOMPLETE', field: `card.${cardId}`, message: `npu-smi info -t usages -i ${cardId} 退出码 ${u.exitCode}`, args: { exit_code: u.exitCode } })
      } catch (error) {
        warnings.push({ code: 'USAGES_INCOMPLETE', field: `card.${cardId}`, message: String(error?.message ?? error), args: {} })
      }
    }
  }
  await Promise.all([worker(), worker()])
  const mergeWarnings = mergeUsages(parsed.cards, usages)
  for (const message of mergeWarnings) warnings.push({ code: 'USAGES_INCOMPLETE', field: null, message, args: {} })
  const partial = warnings.length > 0
  const snapshot = finalizeSnapshot({
    source,
    npuSmi: parsed.npu_smi,
    arch: process.arch,
    cards: parsed.cards,
    warnings,
    durationMs: Date.now() - started,
    commandIds,
    partial,
  })
  return { result: partial ? degraded('snapshot', source, snapshot, warnings) : ok('snapshot', source, snapshot), snapshot }
}

// t44 C：SSH 采集合并为每环境 1 条连接——info + 逐卡 usages 在远端一次执行，@@CARD:<id>@@ 分段回传。
export function buildSshRemoteCommand(npuSmiPath) {
  const npu = quotePosix(String(npuSmiPath || 'npu-smi'))
  // 卡号用 `npu-smi info -l` 的 NPU ID 提取，不依赖型号名带 Ascend 前缀。
  // 旧实现按 `| <id> Ascend...` 匹配，B 系列（型号 910B3）会得到空列表，导致 usages 全缺、占用显示未知。
  return `info=$(${npu} info); printf '%s\\n' "$info"; cards=$(${npu} info -l 2>/dev/null | sed -n 's/.*NPU ID *: *\\([0-9][0-9]*\\).*/\\1/p' | sort -nu); for i in $cards; do printf '@@CARD:%s@@\\n' "$i"; ${npu} info -t usages -i "$i"; done`
}

export function parseCombinedSshOutput(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n')
  const markerRe = /^@@CARD:(\d+)@@\s*$/
  const first = lines.findIndex((line) => markerRe.test(line))
  const infoText = first < 0 ? lines.join('\n') : lines.slice(0, first).join('\n')
  const usagesByCard = new Map()
  if (first >= 0) {
    let currentId = null
    let buffer = []
    const flush = () => {
      if (currentId === null || usagesByCard.has(currentId)) return
      while (buffer.length > 0 && buffer[buffer.length - 1] === '') buffer.pop()
      usagesByCard.set(currentId, buffer.join('\n'))
    }
    for (const line of lines.slice(first)) {
      const match = line.match(markerRe)
      if (match) { flush(); currentId = Number(match[1]); buffer = [] }
      else buffer.push(line)
    }
    flush()
  }
  return { infoText, usagesByCard }
}

// stderr 摘要：压平空白、截断 160 字符，并把 hostAlias（user@host 或裸 host）脱敏为 <host>。
export function summarizeSshStderr(stderr, hostAlias) {
  let text = String(stderr ?? '').replace(/\s+/g, ' ').trim()
  if (hostAlias) {
    const alias = String(hostAlias)
    const bare = alias.includes('@') ? alias.slice(alias.lastIndexOf('@') + 1) : alias
    text = text.split(alias).join('<host>')
    if (bare && bare !== alias) text = text.split(bare).join('<host>')
  }
  return text.slice(0, 160)
}

async function collectSsh(ctx, cfg) {
  const started = Date.now()
  const source = { ...baseSource('ssh', false), host: cfg.ssh.hostAlias }
  const sshArgs = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'ConnectionAttempts=1',
    '-o', 'ClearAllForwardings=yes',
    cfg.ssh.hostAlias,
  ]
  let resolved
  try {
    resolved = await ctx.subprocess.resolveExecutable('ssh', {})
  } catch {
    return { result: empty('snapshot', source, emptySnapshot(source, 'command_missing'), [], { code: 'COMMAND_MISSING', message: '未找到 ssh 客户端', retryable: false, details: null }) }
  }
  // 每环境仅 1 条 SSH：远端一次执行 info + 逐卡 usages；聚合超时 max(env.timeoutMs, 45s)。
  const remote = buildSshRemoteCommand(cfg.ssh.npuSmiPath)
  const effective = { ...cfg, timeout: Math.max(cfg.timeout ?? 0, SSH_AGGREGATE_MIN_TIMEOUT_MS) }
  const retryDelayMs = Number.isFinite(cfg.sshRetryDelayMs) ? cfg.sshRetryDelayMs : SSH_RETRY_DELAY_MS
  let run = await runCommand(ctx, effective, [resolved, ...sshArgs, remote])
  if (run.exitCode === 255) {
    // exit 255（连接/认证失败）→ 等待后重试 1 次，仍失败按 SSH_UNAVAILABLE 处理（stale 兜底在 collectEnv）。
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, retryDelayMs)))
    run = await runCommand(ctx, effective, [resolved, ...sshArgs, remote])
  }
  if (run.exitCode === 255) {
    const summary = summarizeSshStderr(run.stderr, cfg.ssh.hostAlias)
    return {
      result: degraded('snapshot', source, emptySnapshot(source, 'unreachable'), [
        { code: 'SSH_UNAVAILABLE', field: null, message: 'SSH 连接或认证失败（只读，未修改远端；已重试 1 次）', args: { exit_code: 255 } },
      ], { code: 'SSH_UNAVAILABLE', message: summary ? `SSH 不可用：${summary}` : 'SSH 不可用', retryable: true, details: summary ? { stderr: summary } : null }),
    }
  }
  if (run.exitCode !== 0) {
    return { result: degraded('snapshot', source, emptySnapshot(source, 'unknown'), [{ code: 'COMMAND_FAILED', field: null, message: `远端 npu-smi 退出码 ${run.exitCode}`, args: {} }]) }
  }
  const combined = parseCombinedSshOutput(run.stdout)
  const parsed = parseNpuSmiInfo(combined.infoText)
  const commandIds = ['ssh: npu-smi info + 逐卡 usages（单连接聚合）']
  const warnings = []
  const usages = new Map()
  for (const card of parsed.cards) {
    const section = combined.usagesByCard.get(card.card_id)
    if (section == null) {
      warnings.push({ code: 'USAGES_INCOMPLETE', field: `card.${card.card_id}`, message: `远端聚合输出缺少卡 ${card.card_id} 的 usages 段`, args: {} })
      continue
    }
    usages.set(card.card_id, parseUsages(section))
  }
  for (const message of mergeUsages(parsed.cards, usages)) warnings.push({ code: 'USAGES_INCOMPLETE', field: null, message, args: {} })
  const snapshot = finalizeSnapshot({
    source,
    npuSmi: parsed.npu_smi,
    arch: null,
    cards: parsed.cards,
    warnings,
    durationMs: Date.now() - started,
    commandIds,
    partial: warnings.length > 0,
  })
  // 远端只执行常量命令，不做任何写操作
  return { result: warnings.length ? degraded('snapshot', source, snapshot, warnings) : ok('snapshot', source, snapshot), snapshot }
}

function demoSnapshot() {
  const source = { ...baseSource('demo', true), host: 'demo', source_ref: 'fixtures/npu-snapshot.sample.json' }
  const localCards = []
  for (let cardId = 0; cardId < 8; cardId += 1) {
    const chips = []
    for (let chipId = 0; chipId < 2; chipId += 1) {
      chips.push({
        chip_id: chipId,
        phy_id: cardId * 2 + chipId,
        bus_id: `0000:${(0x81 + cardId * 4).toString(16).toUpperCase()}:00.0`,
        health: 'ok',
        health_raw: 'OK',
        temp_c: chipId === 0 ? 46 + (cardId % 4) : 48,
        power_w: chipId === 0 ? 160 + cardId * 3.5 : null,
        aicore_pct: 0,
        npu_util_pct: 0,
        aivector_pct: 0,
        aicpu_pct: 0,
        ctrlcpu_pct: 6,
        hbm_used_mb: 2900 + cardId * 30 + chipId * 10,
        hbm_total_mb: 65536,
        hbm_usage_rate_pct: 4.5,
        hbm_reported_usage_rate_pct: 4,
        ddr_bandwidth_pct: 0,
        hbm_bandwidth_pct: 0,
        aicube_pct: 0,
        processes: [],
        processes_state: 'none_reported',
        missing_reasons: chipId === 1 ? { power_w: '该芯片未上报功耗' } : {},
      })
    }
    localCards.push({ card_id: cardId, model: 'Ascend910', power_w: null, temp_c: null, health: 'ok', chips, processes: [] })
  }
  return {
    snapshot_id: newId('snap'),
    captured_at: nowIso(),
    availability: 'available',
    host: { alias: 'demo', arch: 'aarch64' },
    software: { npu_smi: '26.1.1', cann: '8.1.RC2' },
    npu: { card_count: 8, chip_count: 16, memory_unit: 'MiB', cards: localCards },
    runtime: null,
    storage: null,
    collection: { duration_ms: 0, command_ids: ['demo:fixture'], stale: false, partial: false },
    error: null,
    source,
    _warnings: [],
  }
}

function demoRuns() {
  const mk = (label, mul, conc) => {
    const metrics = emptyMetrics()
    const base = {
      request_throughput_rps: 8.2 * mul,
      output_throughput_tps: 1240 * mul,
      total_throughput_tps: 5100 * mul,
      ttft_p50_ms: 190 / mul,
      ttft_p99_ms: 620 / mul,
      tpot_p50_ms: 24 / mul,
      tpot_p99_ms: 41 / mul,
      itl_p50_ms: 24 / mul,
      itl_p99_ms: 43 / mul,
      success_rate_pct: 100,
    }
    for (const [key, value] of Object.entries(base)) setMetric(metrics, key, round(value, 2))
    return makeRun({
      label,
      timestamp: nowIso(),
      metrics,
      workload: { model: 'Qwen3-8B', cards: 8, input_len: 4096, output_len: 512, concurrency: conc, request_rate_rps: null, request_rate_mode: 'unbounded', dataset: 'demo', precision: 'w8a8' },
      env: { hardware: 'Ascend910 ×8', cann: '8.1.RC2', framework: 'vllm', framework_version: '0.30.0', backend: 'vllm-ascend', tensor_parallel: 8, notes: 'demo fixture' },
      hotspots: [
        { op_name: 'aclnnMatmul', op_type: 'MatMul', task_type: 'AI_CORE', calls: 8192, total_duration_us: 8_400_000, mean_duration_us: 1025.4, share_pct: 42.1, source_rows: [] },
        { op_name: 'aclnnFlashAttention', op_type: 'FlashAttention', task_type: 'AI_CORE', calls: 4096, total_duration_us: 5_200_000, mean_duration_us: 1269.5, share_pct: 26.1, source_rows: [] },
        { op_name: 'aclnnRmsNorm', op_type: 'RmsNorm', task_type: 'AI_VECTOR', calls: 16384, total_duration_us: 1_900_000, mean_duration_us: 116.0, share_pct: 9.5, source_rows: [] },
      ],
      format: 'vllm-json',
      fieldSources: {},
      acceptedRows: 1,
      warnings: [],
    })
  }
  const baseline = mk('demo-baseline', 1, 32)
  const candidate = mk('demo-candidate', 0.95, 32)
  // 让演示同时覆盖“吞吐回归 + TTFT 回归但 TPOT 稳定”，以命中 TTFT_REGRESSION 规则
  setMetric(candidate.metrics, 'ttft_p50_ms', 215.2)
  setMetric(candidate.metrics, 'ttft_p99_ms', 700.6)
  setMetric(candidate.metrics, 'tpot_p50_ms', 24.6)
  setMetric(candidate.metrics, 'tpot_p99_ms', 42.0)
  setMetric(candidate.metrics, 'itl_p50_ms', 24.5)
  setMetric(candidate.metrics, 'itl_p99_ms', 44.0)
  baseline.source = { ...baseSource('demo', true), host: 'demo', source_ref: 'demo:baseline' }
  candidate.source = { ...baseSource('demo', true), host: 'demo', source_ref: 'demo:candidate' }
  baseline.hotspots.forEach((h) => { h.share_pct = h.share_pct })
  return [baseline, candidate]
}

/* ------------------------------------------------------------------ */
/* 仓储                                                                */
/* ------------------------------------------------------------------ */

class Store {
  constructor(dataDir) {
    this.dataDir = expandHome(dataDir)
    this.file = join(this.dataDir, 'store.json')
    this.bak = join(this.dataDir, 'store.json.bak')
    // R3：真实/导入数据与演示数据分仓存放；演示开关不持久化，避免跨重启掩盖真实数据
    this.state = { schema: STORE_SCHEMA, revision: 0, updated_at: nowIso(), runs: [], snapshots: [], demo_runs: [], demo_snapshots: [], import_keys: {}, env_states: {} }
    this.warnings = []
    this.queue = Promise.resolve()
  }

  load() {
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    } catch { /* 目录可能已存在 */ }
    const read = (path) => {
      if (!existsSync(path)) return null
      const text = readFileSync(path, 'utf8')
      return JSON.parse(text)
    }
    let data = null
    try {
      data = read(this.file)
    } catch (error) {
      this.warnings.push({ code: 'STORE_RECOVERED', field: null, message: `store.json 损坏，尝试从备份恢复：${String(error?.message ?? error).slice(0, 160)}`, args: {} })
      try {
        mkdirSync(join(this.dataDir, 'quarantine'), { recursive: true, mode: 0o700 })
        writeFileSync(join(this.dataDir, 'quarantine', `store-${Date.now()}.json`), existsSync(this.file) ? readFileSync(this.file) : '')
      } catch { /* 隔离失败不阻断恢复 */ }
      try {
        data = read(this.bak)
      } catch { data = null }
    }
    if (!data) return this
    if (data.schema !== STORE_SCHEMA) {
      this.warnings.push({ code: 'SCHEMA_UNSUPPORTED', field: null, message: `未知仓储 schema：${String(data.schema)}`, args: {} })
      return this
    }
    // R3：旧仓储可能把演示条目混在 runs/snapshots 里，加载时按 source.is_demo 迁出；
    // 演示开关（data.demo）为旧字段，不再恢复，避免重启后真实数据被演示数据掩盖。
    const realRuns = []
    const demoRuns = []
    for (const run of Array.isArray(data.runs) ? data.runs : []) {
      if (run?.source?.is_demo) demoRuns.push(run)
      else realRuns.push(run)
    }
    for (const run of Array.isArray(data.demo_runs) ? data.demo_runs : []) demoRuns.push(run)
    const realSnapshots = []
    const demoSnapshots = []
    for (const snap of Array.isArray(data.snapshots) ? data.snapshots : []) {
      if (snap?.source?.is_demo) demoSnapshots.push(snap)
      else realSnapshots.push(snap)
    }
    for (const snap of Array.isArray(data.demo_snapshots) ? data.demo_snapshots : []) demoSnapshots.push(snap)
    const dedupeById = (items, key) => {
      const seen = new Set()
      return items.filter((item) => {
        const id = item?.[key]
        if (id == null || seen.has(id)) return false
        seen.add(id)
        return true
      })
    }
    this.state = {
      schema: STORE_SCHEMA,
      revision: Number.isInteger(data.revision) ? data.revision : 0,
      updated_at: typeof data.updated_at === 'string' ? data.updated_at : nowIso(),
      runs: dedupeById(realRuns, 'run_id'),
      snapshots: dedupeById(realSnapshots, 'snapshot_id'),
      demo_runs: dedupeById(demoRuns, 'run_id'),
      demo_snapshots: dedupeById(demoSnapshots, 'snapshot_id'),
      import_keys: isPlainObject(data.import_keys) ? data.import_keys : {},
      env_states: isPlainObject(data.env_states) ? data.env_states : {},
    }
    return this
  }

  get runs() { return this.state.runs }
  get snapshots() { return this.state.snapshots }
  get demoRuns() { return this.state.demo_runs }
  get demoSnapshots() { return this.state.demo_snapshots }

  latestSnapshot(list = this.state.snapshots) {
    const sorted = [...list].sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)))
    return sorted[0] ?? null
  }

  findRun(id) {
    return this.state.runs.find((r) => r.run_id === id)
      ?? this.state.demo_runs.find((r) => r.run_id === id)
      ?? null
  }

  async mutate(fn) {
    const task = this.queue.then(async () => {
      const before = JSON.stringify(this.state)
      const result = await fn(this.state)
      if (JSON.stringify(this.state) !== before) await this.save()
      return result
    })
    this.queue = task.catch(() => {})
    return task
  }

  async save() {
    this.state.revision += 1
    this.state.updated_at = nowIso()
    if (this.state.runs.length > MAX_RUNS) this.state.runs = this.state.runs.slice(-MAX_RUNS)
    if (this.state.snapshots.length > MAX_SNAPSHOTS) this.state.snapshots = this.state.snapshots.slice(-MAX_SNAPSHOTS)
    if (this.state.demo_runs.length > MAX_RUNS) this.state.demo_runs = this.state.demo_runs.slice(-MAX_RUNS)
    if (this.state.demo_snapshots.length > MAX_SNAPSHOTS) this.state.demo_snapshots = this.state.demo_snapshots.slice(-MAX_SNAPSHOTS)
    let text = JSON.stringify(this.state)
    while (Buffer.byteLength(text) > STORE_LIMIT_BYTES && (this.state.runs.length > 0 || this.state.demo_runs.length > 0)) {
      // 先淘汰真实运行，再淘汰演示运行（演示数据不挤占真实数据配额）
      if (this.state.runs.length > 0) this.state.runs.shift()
      else this.state.demo_runs.shift()
      text = JSON.stringify(this.state)
    }
    const tmp = join(this.dataDir, `.store-${randomUUID()}.tmp`)
    writeFileSync(tmp, text, { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch { /* best effort */ }
    if (existsSync(this.file)) {
      try {
        writeFileSync(this.bak, readFileSync(this.file), { mode: 0o600 })
      } catch { /* 备份失败时继续主写入 */ }
    }
    renameSync(tmp, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch { /* best effort */ }
  }
}

function expandHome(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return join(homedir(), '.local', 'share', 'dsh-ascend-perf')
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2))
  return isAbsolute(dir) ? dir : join(homedir(), dir)
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

function detectFormat(content) {
  const trimmed = content.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  const firstLine = trimmed.split(/\r?\n/, 1)[0].toLowerCase()
  if (firstLine.includes('op name') || firstLine.includes('task duration')) return 'msprof'
  return 'csv'
}

export function importContent(content, { filename = null, skipBadRows = false } = {}) {
  if (typeof content !== 'string') throw new ApiFailure('INVALID_ARGUMENT', 'content 必须是字符串')
  if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
    throw new ApiFailure('INPUT_TOO_LARGE', '文件超过 1 MiB', { limit: MAX_IMPORT_BYTES })
  }
  const sha = sha256(content)
  const format = detectFormat(content)
  if (format === 'json') {
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      throw new ApiFailure('PARSE_ERROR', 'JSON 解析失败', { reason: String(error?.message ?? error) })
    }
    if (Array.isArray(parsed)) {
      if (parsed.length > MAX_JSON_OBJECTS) throw new ApiFailure('INPUT_TOO_LARGE', `JSON 数组超过 ${MAX_JSON_OBJECTS} 个对象`)
      const runs = []
      const warnings = []
      for (const [i, item] of parsed.entries()) {
        try {
          const out = parseVllmJson(item)
          runs.push({ ...out.run, source: { ...out.run.source, path: safeBasename(filename), sha256: sha, source_ref: sha } })
          warnings.push(...out.warnings)
        } catch (error) {
          if (!skipBadRows) throw error
          warnings.push({ code: 'ROW_SKIPPED', field: `index.${i}`, message: String(error.message ?? error), args: {} })
        }
      }
      if (runs.length === 0) throw new ApiFailure('NO_VALID_ROWS', 'JSON 中没有可用对象')
      return { format: 'vllm-json', runs, warnings, sha256: sha, rejected: [] }
    }
    const out = parseVllmJson(parsed)
    return {
      format: 'vllm-json',
      runs: [{ ...out.run, source: { ...out.run.source, path: safeBasename(filename), sha256: sha, source_ref: sha } }],
      warnings: out.warnings,
      sha256: sha,
      rejected: [],
    }
  }
  const result = format === 'msprof' ? parseMsprofCsv(content) : parseBenchmarkCsv(content, filename)
  if (format === 'msprof') {
    return { format: 'msprof-op-summary-csv', hotspots: result.hotspots, warnings: [], sha256: sha, rejected: [] }
  }
  const rejected = result.rejected ?? []
  if (rejected.length && !skipBadRows) {
    throw new ApiFailure('PARSE_ERROR', `有 ${rejected.length} 行无有效性能指标`, { rejected: rejected.slice(0, 20) })
  }
  return {
    format: 'benchmark-csv',
    runs: result.runs.map((run) => ({ ...run, source: { ...run.source, sha256: sha, source_ref: sha } })),
    warnings: result.warnings ?? [],
    sha256: sha,
    rejected,
  }
}

/* ------------------------------------------------------------------ */
/* 导出 text                                                           */
/* ------------------------------------------------------------------ */

export function formatCompareMarkdown(comparison, baseline, candidate) {
  const lines = []
  lines.push(`# 昇腾性能对比：${baseline?.label ?? comparison.baseline_run_id} → ${candidate?.label ?? comparison.candidate_run_id}`)
  lines.push('')
  lines.push(`- 结论：${comparison.summary.conclusion}（${comparison.summary.message}）`)
  lines.push(`- 可比性：${comparison.comparability}`)
  lines.push(`- 阈值：±${comparison.threshold_pct}%`)
  lines.push(`- 计算时间：${comparison.computed_at}`)
  lines.push('')
  lines.push('| 指标 | 基线 | 候选 | 差值 | 变化 | 判定 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const m of comparison.metrics) {
    lines.push(`| ${m.key} | ${fmt(m.baseline)} | ${fmt(m.candidate)} | ${fmt(m.delta_abs)} | ${m.delta_pct === null ? '—' : `${m.delta_pct}%`} | ${m.verdict} |`)
  }
  lines.push('')
  if (comparison.comparability_issues.length) {
    lines.push('## 可比性问题')
    for (const issue of comparison.comparability_issues) lines.push(`- ${issue.message}`)
  }
  return lines.join('\n')
}

function fmt(value) {
  return value === null || value === undefined ? '—' : String(round(value, 4))
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig)
  // 配置文件化（t17）：envs 与采集频率的唯一持久来源是 configDir/envs.json。
  // 读取顺序：envs.json → 迁移 settings.json（v2 envs / v1 单目标）→ npu-ssh.md / npu.env 播种。
  const envsFile = readEnvsConfig(cfg.configDir)
  let envsConfigError = envsFile?.error ?? null
  const settingsRaw = readSettings(cfg.dataDir)
  applySettings(cfg, settingsRaw)
  const envsSource = envsFile?.payload ?? (envsConfigError ? null : settingsRaw ?? {})
  applyEnvSettings(cfg, envsSource)
  // 写回只写 envs.json；envs.json 已存在或读取失败时不覆盖（读取失败不得清掉用户待修复的文件）
  if (!envsFile?.payload && !envsConfigError) writeEnvsConfig(cfg.configDir, envsConfigPayload(cfg))
  const store = new Store(cfg.dataDir).load()
  const storeWarnings = store.warnings.slice()
  let inflight = null
  let lastCollectAt = 0
  // R3：演示开关是进程内状态，不跨重启持久化；演示数据存放在独立 demo_runs/demo_snapshots
  let demoForced = false

  // 二期调优：独立 TuningStore（dataDir/tuning-v1）；真实执行默认关闭，只允许 demo 完整运行。
  let tuning = null
  let tuningInitError = null
  try {
    tuning = new TuneService({ dataDir: cfg.dataDir, config: cfg.tuning })
  } catch (error) {
    tuningInitError = { code: error?.code ?? 'STORE_IO', message: String(error?.message ?? error) }
  }
  const tuneToolDefs = tuning ? createTuneTools({ service: tuning }) : []
  const tuneRouteDefs = tuning ? createTuneRoutes({ service: tuning }) : []

  // 三期部署 v2（t30）：以 envs 环境为目标的「代码基线差异」可编辑部署计划（纯本地文本，不执行任何步骤）。
  let deploy = null
  let deployInitError = null
  try {
    deploy = new DeployPlanService({
      configDir: cfg.configDir,
      // 环境只读注入：读 envs 配置与 env_states 占用缓存，不触发采集、不连远端。
      getEnv: (envId) => {
        const env = (cfg.envs ?? []).find((item) => item.id === envId)
        if (!env) return null
        const record = (store.state.env_states ?? {})[envId] ?? null
        return { env, record, occupancy: summarizeEnvOccupancy(record?.snapshot ?? null) }
      },
    })
  } catch (error) {
    deployInitError = { code: error?.code ?? 'STORE_IO', message: String(error?.message ?? error) }
  }
  const deployToolDefs = deploy ? createDeployTools({ service: deploy }) : []
  const deployRouteDefs = deploy ? createDeployRoutes({ service: deploy }) : []

  const visibleRuns = () => (demoForced ? store.demoRuns : store.runs)
  const visibleSnapshots = () => (demoForced ? store.demoSnapshots : store.snapshots)
  const latestVisibleSnapshot = () => store.latestSnapshot(visibleSnapshots())
  const isDemoRun = (run) => Boolean(run?.source?.is_demo)
  function assertSameEvidenceKind(baseline, candidate) {
    if (isDemoRun(baseline) !== isDemoRun(candidate)) {
      throw apiError('INVALID_ARGUMENT', '演示数据与真实数据不能混合对比；请退出演示模式后重试')
    }
  }

  function sourceWarnings() {
    return storeWarnings.map((w) => ({ ...w, field: w.field ?? null, args: w.args ?? {} }))
  }

  async function collect({ target = cfg.ssh.enabled ? 'ssh' : 'local', refresh = true, force = false } = {}) {
    if (demoForced) return { result: ok('snapshot', { ...baseSource('demo', true), host: 'demo' }, demoSnapshot()), snapshot: null }
    if (!refresh) {
      const cached = store.latestSnapshot()
      if (cached) {
        const stale = Date.now() - new Date(cached.captured_at).getTime() > STALE_MS
        const data = { ...cached, collection: { ...cached.collection, stale } }
        return { result: stale ? degraded('snapshot', cached.source, data, [{ code: 'SNAPSHOT_STALE', field: null, message: '快照已过期', args: {} }]) : ok('snapshot', cached.source, data), snapshot: cached }
      }
    }
    if (inflight) return inflight
    const run = (async () => {
      let out
      try {
        out = target === 'ssh' ? await collectSsh(ctx, cfg) : await collectLocal(ctx, cfg, { force })
      } catch (error) {
        const source = baseSource(target === 'ssh' ? 'ssh' : 'local', false)
        const code = error?.code ?? 'COMMAND_FAILED'
        const res = failure('snapshot', source, code, String(error?.message ?? error).slice(0, 512), { exit_code: error?.details?.exit_code ?? null }, true)
        return { result: { ...res, warnings: [...res.warnings, ...sourceWarnings()] } }
      }
      lastCollectAt = Date.now()
      // 空态/失败态（如未安装 npu-smi）没有 out.snapshot，但 result.data 仍是
      // 本次采集的可展示快照；必须一并落库，否则 /state 永远看不到设备状态。
      const collectedSnapshot = out.snapshot
        ?? (out.result?.kind === 'snapshot' && out.result.data?.snapshot_id ? out.result.data : null)
      if (collectedSnapshot) {
        await store.mutate((state) => {
          state.snapshots.push(collectedSnapshot)
          if (state.snapshots.length > MAX_SNAPSHOTS) state.snapshots = state.snapshots.slice(-MAX_SNAPSHOTS)
        })
      }
      return { ...out, result: { ...out.result, warnings: [...(out.result.warnings ?? []), ...sourceWarnings()] } }
    })()
    inflight = run.finally(() => { inflight = null })
    return inflight
  }

  async function persistImport(parsed) {
    return store.mutate((state) => {
      const duplicateKeys = []
      for (const run of parsed.runs) {
        if (run.source.sha256 && state.import_keys[run.source.sha256]) duplicateKeys.push(state.import_keys[run.source.sha256])
      }
      if (duplicateKeys.length === parsed.runs.length && parsed.runs.length > 0) {
        const existing = duplicateKeys.map((id) => state.runs.find((r) => r.run_id === id)).filter(Boolean)
        return { deduplicated: true, runs: existing }
      }
      for (const run of parsed.runs) {
        state.runs.push(run)
        if (run.source.sha256) state.import_keys[run.source.sha256] = run.run_id
      }
      if (state.runs.length > MAX_RUNS) state.runs = state.runs.slice(-MAX_RUNS)
      return { deduplicated: false, runs: parsed.runs }
    })
  }

  /* ------------------------- 多环境采集与轮询 ------------------------- */

  function summarizeEnvRecord(record) {
    const snapshot = record?.snapshot ?? null
    return {
      env_id: record?.env_id ?? null,
      collected_at: record?.collected_at ?? null,
      availability: record?.availability ?? 'unknown',
      kind: record?.kind ?? null,
      error: record?.error ?? null,
      warnings: record?.warnings ?? [],
      card_count: snapshot?.npu?.card_count ?? null,
      chip_count: snapshot?.npu?.chip_count ?? null,
    }
  }

  function envsPayload() {
    const states = store.state.env_states ?? {}
    return (cfg.envs ?? []).map((env) => {
      const record = states[env.id] ?? null
      return {
        id: env.id,
        name: env.name,
        mode: env.mode,
        hostAlias: env.hostAlias,
        enabled: env.enabled,
        collected_at: record?.collected_at ?? null,
        availability: record?.availability ?? 'pending',
        last_success_at: record?.last_success_at ?? null,
        snapshot: record?.snapshot ?? null,
        occupancy: summarizeEnvOccupancy(record?.snapshot ?? null),
        error: record?.error ?? null,
        warnings: record?.warnings ?? [],
      }
    })
  }

  async function collectEnv(env) {
    const effective = {
      ...cfg,
      npuSmiPath: env.npuSmiPath,
      timeout: env.timeoutMs,
      ssh: env.mode === 'ssh'
        ? { ...cfg.ssh, enabled: true, hostAlias: env.hostAlias, npuSmiPath: env.npuSmiPath }
        : { ...cfg.ssh, enabled: false, hostAlias: null, npuSmiPath: env.npuSmiPath },
    }
    let out
    try {
      out = env.mode === 'ssh' ? await collectSsh(ctx, effective) : await collectLocal(ctx, effective, {})
    } catch (error) {
      const source = { ...baseSource(env.mode, false), env: { id: env.id, name: env.name } }
      out = { result: failure('snapshot', source, String(error?.code ?? 'COMMAND_FAILED'), String(error?.message ?? error).slice(0, 256), {}, true) }
    }
    const fresh = out.snapshot ?? (out.result?.kind === 'snapshot' && out.result.data?.snapshot_id ? out.result.data : null)
    // 连接失败但存在旧的成功快照时保留旧档（§14.6-⑧）：
    // - SSH 连接抖动（重试后仍 255）→ availability='stale' + last_success_at + stderr 摘要，UI 显示上次数据；
    // - 其余失败 → availability 如实反映本次尝试，UI 用旧档渲染并叠加角标。
    const prev = (store.state.env_states ?? {})[env.id] ?? null
    const freshOk = fresh?.availability === 'available'
    const prevOk = prev?.snapshot?.availability === 'available'
    const sshFlap = !freshOk && out.result?.error?.code === 'SSH_UNAVAILABLE' && prevOk
    const snapshot = freshOk ? fresh : (prevOk ? prev.snapshot : fresh)
    const record = {
      env_id: env.id,
      collected_at: nowIso(),
      availability: freshOk ? 'available' : sshFlap ? 'stale' : fresh?.availability ?? 'unreachable',
      // 上次成功采集时间：成功即更新，失败沿用历史（stale 角标显示「上次 HH:MM」）。
      last_success_at: freshOk ? nowIso() : prev?.last_success_at ?? null,
      snapshot,
      kind: out.result?.kind ?? 'failure',
      error: sshFlap
        ? { code: 'SSH_UNAVAILABLE', message: out.result.error?.message ?? 'SSH 不可用（已重试 1 次）', retryable: true, details: out.result.error?.details ?? null }
        : out.result?.error ?? null,
      warnings: (out.result?.warnings ?? []).slice(0, 8),
    }
    await store.mutate((state) => {
      if (!isPlainObject(state.env_states)) state.env_states = {}
      state.env_states[env.id] = record
    })
    return record
  }

  let pollTimer = null
  let polling = false

  async function pollOnce() {
    if (polling) return { schema: SCHEMA, skipped: true, envs: envsPayload() }
    polling = true
    try {
      // t44 C：有界并发 2——单连接后每环境一次 SSH，串行写 Store；不同环境（不同 sshd）至多 2 条并发。
      const pendingEnvs = (cfg.envs ?? []).filter((item) => item.enabled)
      const results = []
      let cursor = 0
      async function worker() {
        while (cursor < pendingEnvs.length) {
          const env = pendingEnvs[cursor]
          cursor += 1
          try {
            results.push(await collectEnv(env))
          } catch { /* collectEnv 已把失败写入 env_states */ }
        }
      }
      await Promise.all([worker(), worker()])
      return { schema: SCHEMA, collected: results.map(summarizeEnvRecord), envs: envsPayload() }
    } finally {
      polling = false
    }
  }

  function stopEnvPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  function restartEnvPolling() {
    stopEnvPolling()
    pollTimer = setInterval(() => { pollOnce().catch(() => {}) }, cfg.pollIntervalMs ?? DEFAULT_POLL_MS)
    if (typeof pollTimer?.unref === 'function') pollTimer.unref()
  }

  // 「刷新全部」时重新读取 envs.json：配置文件是唯一入口，用户改完文件点一次刷新即生效。
  function reloadEnvsConfig() {
    const file = readEnvsConfig(cfg.configDir)
    if (file?.payload) {
      const before = JSON.stringify([cfg.envs ?? [], cfg.pollIntervalMs ?? DEFAULT_POLL_MS])
      applyEnvSettings(cfg, file.payload)
      envsConfigError = null
      const after = JSON.stringify([cfg.envs ?? [], cfg.pollIntervalMs ?? DEFAULT_POLL_MS])
      if (before !== after) restartEnvPolling()
    } else if (file?.error) {
      envsConfigError = file.error
    }
  }

  // 空态导入（SSH 主机 / 粘贴 JSON）共用落盘：合并→镜像主环境→原子写 envs.json→重启轮询。
  function applyImportedEnvs(newEnvs, pollIntervalMs = null) {
    cfg.envs = [...(cfg.envs ?? []), ...newEnvs].slice(0, MAX_ENVS)
    const ms = Number(pollIntervalMs)
    if (Number.isFinite(ms)) cfg.pollIntervalMs = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(ms)))
    mirrorPrimaryEnv(cfg)
    writeEnvsConfig(cfg.configDir, envsConfigPayload(cfg))
    envsConfigError = null
    restartEnvPolling()
    // 首轮采集放后台跑（最多 16 个环境 × 15s 超时不能阻塞 HTTP 响应），
    // 采集结束后 store 更新，UI 下一次 /state 即可见。
    pollOnce().catch(() => {})
  }

  function startEnvPolling() {
    if (pollTimer) return
    restartEnvPolling()
    const kick = setTimeout(() => { pollOnce().catch(() => {}) }, 2500)
    if (typeof kick?.unref === 'function') kick.unref()
  }

  function statePayload() {
    const snapshot = latestVisibleSnapshot()
    return {
      schema: SCHEMA,
      demo: demoForced,
      demo_active: demoForced,
      real_run_count: store.runs.length,
      demo_run_count: store.demoRuns.length,
      threshold_pct: cfg.regressionThreshold,
      config: publicConfig(cfg),
      runs: visibleRuns().map((run) => ({
        run_id: run.run_id,
        label: run.label,
        created_at: run.created_at,
        timestamp: run.timestamp,
        source: run.source,
        workload: run.workload,
        metrics: run.metrics,
        hotspots_count: run.hotspots?.length ?? 0,
      })),
      snapshot,
      envs: demoForced ? [] : envsPayload(),
      envs_config_error: envsConfigError,
      source: snapshot?.source ?? { ...baseSource('local', false), source_ref: 'none' },
      warnings: sourceWarnings(),
    }
  }

  /* ------------------------------ tools ------------------------------ */

  const toolDefs = [
    {
      name: 'ascend_status',
      description: '只读读取本机（或配置的 SSH 目标）昇腾 NPU 状态：卡/芯片、温度、功耗、HBM、健康与进程。不启停服务、不跑 benchmark、不写远端。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['local', 'ssh'], description: '采集目标，默认按插件配置' },
          refresh: { type: 'boolean', description: 'true 重新采集；false 读取最近快照' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderStatus },
      timeoutMs: cfg.timeout + 5000,
      async execute(args) {
        const out = await collect({ target: args?.target ?? (cfg.ssh.enabled ? 'ssh' : 'local'), refresh: args?.refresh !== false })
        return out.result
      },
    },
    {
      name: 'ascend_perf_import',
      description: '导入 vLLM benchmark JSON / benchmark CSV / msprof op_summary CSV 到本机私有仓储；支持 list/get/load_demo/delete_runs/reset_store。导入为未验证数据（evidence_kind=unverified_import）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['import', 'list', 'get', 'load_demo', 'delete_runs', 'reset_store'] },
          content: { type: 'string', description: 'UTF-8 文件内容（import）' },
          filename: { type: 'string' },
          label: { type: 'string' },
          run_id: { type: 'string' },
          run_ids: { type: 'array', items: { type: 'string' } },
          skip_bad_rows: { type: 'boolean' },
          target_run_id: { type: 'string', description: 'msprof 热点导入到该运行' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderImport },
      async execute(args) {
        const action = args?.action
        if (action === 'list') {
          return {
            schema: SCHEMA,
            runs: visibleRuns().map((r) => ({ run_id: r.run_id, label: r.label, timestamp: r.timestamp, created_at: r.created_at, source: r.source })),
            demo: demoForced,
            demo_active: demoForced,
            real_run_count: store.runs.length,
            demo_run_count: store.demoRuns.length,
          }
        }
        if (action === 'get') {
          const run = store.findRun(args.run_id)
          if (!run) throw apiError('INVALID_ARGUMENT', `未找到 run：${args.run_id}`)
          return { schema: SCHEMA, run }
        }
        if (action === 'delete_runs') {
          const ids = Array.isArray(args.run_ids) ? args.run_ids : args.run_id ? [args.run_id] : []
          const removed = await store.mutate((state) => {
            const list = demoForced ? state.demo_runs : state.runs
            const kept = list.filter((r) => !ids.includes(r.run_id))
            if (demoForced) state.demo_runs = kept
            else state.runs = kept
            return list.length - kept.length
          })
          return { schema: SCHEMA, deleted: removed }
        }
        if (action === 'reset_store') {
          const removed = await store.mutate((state) => {
            const count = state.runs.length + state.demo_runs.length
            state.runs = []
            state.snapshots = []
            state.demo_runs = []
            state.demo_snapshots = []
            state.import_keys = {}
            return count
          })
          demoForced = false
          return { schema: SCHEMA, deleted: removed }
        }
        if (action === 'load_demo') {
          const seeded = await demoSeed()
          demoForced = true
          return { schema: SCHEMA, demo: true, demo_active: true, snapshot: seeded.snapshot, runs: seeded.runs.map((r) => ({ run_id: r.run_id, label: r.label })) }
        }
        // import
        if (!args?.content) throw apiError('INVALID_ARGUMENT', '缺少 content')
        const parsed = importContent(args.content, { filename: args.filename, skipBadRows: Boolean(args.skip_bad_rows) })
        if (parsed.hotspots) {
          if (!args.target_run_id) throw apiError('INVALID_ARGUMENT', '导入 msprof 热点需要 target_run_id')
          const run = store.findRun(args.target_run_id)
          if (!run) throw apiError('INVALID_ARGUMENT', `未找到 run：${args.target_run_id}`)
          await store.mutate(() => {
            run.hotspots = parsed.hotspots
            run.provenance.total_hotspot_duration_us = parsed.hotspots.reduce((s, h) => s + h.total_duration_us, 0)
          })
          return { schema: SCHEMA, format: parsed.format, run_id: run.run_id, hotspots: parsed.hotspots.length, warnings: parsed.warnings }
        }
        if (args.label) for (const run of parsed.runs) run.label = String(args.label).slice(0, 120)
        const saved = await persistImport(parsed)
        return {
          schema: SCHEMA,
          format: parsed.format,
          deduplicated: saved.deduplicated,
          runs: saved.runs.map((r) => ({ run_id: r.run_id, label: r.label, timestamp: r.timestamp, source: r.source })),
          warnings: parsed.warnings,
          rejected: parsed.rejected ?? [],
        }
      },
    },
    {
      name: 'ascend_perf_compare',
      description: '对比两次导入运行（baseline/candidate），按阈值（默认 5%）给出 10 项指标判定与可比性结论；action=export 时导出 Markdown/JSON。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['compare', 'export'] },
          baseline_run_id: { type: 'string' },
          candidate_run_id: { type: 'string' },
          threshold_pct: { type: 'number' },
          format: { type: 'string', enum: ['markdown', 'json'] },
        },
        required: ['baseline_run_id', 'candidate_run_id'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderCompare },
      async execute(args) {
        const baseline = store.findRun(args.baseline_run_id)
        const candidate = store.findRun(args.candidate_run_id)
        if (!baseline || !candidate) throw apiError('INVALID_ARGUMENT', 'baseline 或 candidate 不存在')
        if (baseline.run_id === candidate.run_id) throw apiError('INVALID_ARGUMENT', '不能与自身对比')
        assertSameEvidenceKind(baseline, candidate)
        const comparison = compareRuns(baseline, candidate, args.threshold_pct ?? cfg.regressionThreshold)
        if (args.action === 'export') {
          const content = args.format === 'json'
            ? JSON.stringify({ schema: SCHEMA, comparison }, null, 2)
            : formatCompareMarkdown(comparison, baseline, candidate)
          if (Buffer.byteLength(content) > EXPORT_LIMIT_BYTES) throw apiError('EXPORT_TOO_LARGE', '导出内容超过 64 KiB')
          return { schema: SCHEMA, filename: `ascend-compare-${baseline.label}-vs-${candidate.label}.${args.format === 'json' ? 'json' : 'md'}`, mime: args.format === 'json' ? 'application/json' : 'text/markdown', content, sha256: sha256(content) }
        }
        return { schema: SCHEMA, comparison }
      },
    },
    {
      name: 'ascend_perf_insight',
      description: '基于快照与运行/对比生成带证据的性能洞察（8 条固定规则，最多 20 条，含 skipped_rules）。',
      parameters: {
        type: 'object',
        properties: {
          baseline_run_id: { type: 'string' },
          candidate_run_id: { type: 'string' },
          run_ids: { type: 'array', items: { type: 'string' } },
          snapshot_id: { type: 'string' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderInsight },
      async execute(args) {
        const snapshot = latestVisibleSnapshot()
        const runs = visibleRuns()
        let comparison = null
        if (args?.baseline_run_id && args?.candidate_run_id) {
          const baseline = store.findRun(args.baseline_run_id)
          const candidate = store.findRun(args.candidate_run_id)
          if (!baseline || !candidate) throw apiError('INVALID_ARGUMENT', 'baseline 或 candidate 不存在')
          assertSameEvidenceKind(baseline, candidate)
          comparison = compareRuns(baseline, candidate, cfg.regressionThreshold)
        }
        const report = generateInsights({ snapshot, runs, comparison, thresholdPct: cfg.regressionThreshold })
        return { schema: SCHEMA, ...report }
      },
    },
  ]

  ctx.effect(() => {
    const disposers = toolDefs.concat(tuneToolDefs, deployToolDefs).map((def) => ctx.tools.register(def))
    return () => disposers.forEach((dispose) => dispose())
  }, 'ascend-perf: agent tools')

  ctx.effect(() => {
    startEnvPolling()
    return () => stopEnvPolling()
  }, 'ascend-perf: env polling')

  /* ------------------------------ REST ------------------------------ */

  const routes = [
    { path: '/state', method: 'GET', handler: () => statePayload() },
    {
      path: '/config',
      method: 'GET',
      handler: () => ({ schema: SCHEMA, config: publicConfig(cfg) }),
    },
    {
      path: '/config',
      method: 'POST',
      handler: (body) => {
        const config = updateSettings(cfg, cfg.dataDir, cfg.configDir, body)
        if (body?.envs !== undefined || body?.pollIntervalMs !== undefined) restartEnvPolling()
        return { schema: SCHEMA, config }
      },
    },
    {
      // t44 A：重新加载配置——只读 envs.json（不写盘），成功后触发一次全量采集。
      // 损坏时保留旧配置并返回 400 CONFIG_READ_FAILED；/state 的 envs_config_error 同步展示错误卡。
      path: '/config/reload',
      method: 'POST',
      async handler() {
        reloadEnvsConfig()
        if (envsConfigError) {
          throw apiError('CONFIG_READ_FAILED', envsConfigError.message ?? 'envs.json 读取失败')
        }
        const out = await pollOnce()
        return {
          schema: SCHEMA,
          reloaded: true,
          env_count: (cfg.envs ?? []).length,
          pollIntervalMs: cfg.pollIntervalMs,
          config: publicConfig(cfg),
          envs: out.envs ?? [],
        }
      },
    },
    {
      path: '/status',
      method: 'POST',
      async handler(body) {
        if (body?.refresh_all === true) {
          // 刷新全部前重读 envs.json：配置文件化后 UI 不再提供编辑入口
          reloadEnvsConfig()
          return pollOnce()
        }
        if (typeof body?.env_id === 'string' && body.env_id) {
          const env = (cfg.envs ?? []).find((item) => item.id === body.env_id)
          if (!env) throw apiError('INVALID_ARGUMENT', `环境不存在：${body.env_id}`)
          const record = await collectEnv(env)
          return { schema: SCHEMA, env: summarizeEnvRecord(record), envs: envsPayload() }
        }
        const out = await collect({ target: body?.target ?? (cfg.ssh.enabled ? 'ssh' : 'local'), refresh: body?.refresh !== false })
        return out.result
      },
    },
    {
      path: '/import',
      method: 'POST',
      async handler(body) {
        if (!body?.content) throw apiError('INVALID_ARGUMENT', '缺少 content')
        const parsed = importContent(body.content, { filename: body.filename, skipBadRows: Boolean(body.skip_bad_rows) })
        if (parsed.hotspots) {
          if (!body.target_run_id) throw apiError('INVALID_ARGUMENT', '缺少 target_run_id')
          const run = store.findRun(body.target_run_id)
          if (!run) throw apiError('INVALID_ARGUMENT', '目标运行不存在')
          await store.mutate(() => { run.hotspots = parsed.hotspots })
          return { schema: SCHEMA, hotspots: parsed.hotspots.length, run_id: run.run_id }
        }
        const saved = await persistImport(parsed)
        return {
          schema: SCHEMA,
          format: parsed.format,
          deduplicated: saved.deduplicated,
          runs: saved.runs.map((r) => ({ run_id: r.run_id, label: r.label, timestamp: r.timestamp })),
          warnings: parsed.warnings,
        }
      },
    },
    {
      path: '/compare',
      method: 'POST',
      async handler(body) {
        const baseline = store.findRun(body?.baseline_run_id)
        const candidate = store.findRun(body?.candidate_run_id)
        if (!baseline || !candidate) throw apiError('INVALID_ARGUMENT', '运行不存在')
        assertSameEvidenceKind(baseline, candidate)
        return { schema: SCHEMA, comparison: compareRuns(baseline, candidate, body?.threshold_pct ?? cfg.regressionThreshold) }
      },
    },
    {
      path: '/export',
      method: 'POST',
      async handler(body) {
        const baseline = store.findRun(body?.baseline_run_id)
        const candidate = store.findRun(body?.candidate_run_id)
        if (!baseline || !candidate) throw apiError('INVALID_ARGUMENT', '运行不存在')
        assertSameEvidenceKind(baseline, candidate)
        const comparison = compareRuns(baseline, candidate, body?.threshold_pct ?? cfg.regressionThreshold)
        const format = body?.format === 'json' ? 'json' : 'markdown'
        const content = format === 'json' ? JSON.stringify({ schema: SCHEMA, comparison }, null, 2) : formatCompareMarkdown(comparison, baseline, candidate)
        if (Buffer.byteLength(content) > EXPORT_LIMIT_BYTES) throw apiError('EXPORT_TOO_LARGE', '导出内容超过 64 KiB')
        return {
          schema: SCHEMA,
          filename: `ascend-compare-${baseline.label}-vs-${candidate.label}.${format === 'json' ? 'json' : 'md'}`,
          mime: format === 'json' ? 'application/json' : 'text/markdown',
          content,
          sha256: sha256(content),
        }
      },
    },
    {
      path: '/insight',
      method: 'POST',
      async handler(body) {
        const snapshot = latestVisibleSnapshot()
        const runs = visibleRuns()
        let comparison = null
        if (body?.baseline_run_id && body?.candidate_run_id) {
          const baseline = store.findRun(body.baseline_run_id)
          const candidate = store.findRun(body.candidate_run_id)
          if (baseline && candidate) {
            assertSameEvidenceKind(baseline, candidate)
            comparison = compareRuns(baseline, candidate, cfg.regressionThreshold)
          }
        }
        return { schema: SCHEMA, ...generateInsights({ snapshot, runs, comparison, thresholdPct: cfg.regressionThreshold }) }
      },
    },
    {
      path: '/demo',
      method: 'POST',
      async handler(body) {
        demoForced = body?.enabled !== false
        if (demoForced) await demoSeed()
        return { schema: SCHEMA, demo: demoForced, demo_active: demoForced }
      },
    },
    {
      path: '/delete-run',
      method: 'POST',
      async handler(body) {
        const id = body?.run_id
        const removed = await store.mutate((state) => {
          const list = demoForced ? state.demo_runs : state.runs
          const kept = list.filter((r) => r.run_id !== id)
          if (demoForced) state.demo_runs = kept
          else state.runs = kept
          return list.length - kept.length
        })
        return { schema: SCHEMA, deleted: removed }
      },
    },
    {
      path: '/envs/import/ssh/preview',
      method: 'POST',
      handler() {
        const file = readSshHostsStore(cfg.sshHostsFile)
        if (file.error) {
          return { schema: SCHEMA, available: false, reason: file.error, storeFile: cfg.sshHostsFile, hosts: [], rows: [], draft: [], capacity: 0 }
        }
        const preview = sshHostsImportPreview(file.hosts, cfg.envs ?? [])
        return { schema: SCHEMA, available: true, storeFile: cfg.sshHostsFile, ...preview }
      },
    },
    {
      path: '/envs/import/ssh',
      method: 'POST',
      handler(body) {
        const file = readSshHostsStore(cfg.sshHostsFile)
        if (file.error) throw apiError(file.error.code, file.error.message)
        const preview = sshHostsImportPreview(file.hosts, cfg.envs ?? [])
        let selected = preview.draft
        if (Array.isArray(body?.aliases) && body.aliases.length > 0) {
          const wanted = new Set(body.aliases.map((a) => String(a)))
          selected = selected.filter((env) => wanted.has(env.hostAlias))
        }
        if (selected.length === 0) throw apiError('INVALID_ARGUMENT', '没有可导入的主机（别名无效、重复或超出 16 个上限）')
        applyImportedEnvs(selected)
        return { schema: SCHEMA, imported: selected.length, config: publicConfig(cfg), envs: envsPayload() }
      },
    },
    {
      path: '/envs/import/json',
      method: 'POST',
      handler(body) {
        if (typeof body?.text !== 'string' || !body.text.trim()) throw apiError('INVALID_ARGUMENT', '缺少 text（粘贴的 JSON 内容）')
        const parsed = parseEnvsImportText(body.text)
        if (parsed.error) throw apiError(parsed.error.code, parsed.error.message)
        const validated = validateEnvsImport(parsed.envs, cfg.envs ?? [])
        if (validated.errors) {
          return { schema: SCHEMA, imported: 0, errors: validated.errors }
        }
        applyImportedEnvs(validated.envs, parsed.pollIntervalMs)
        return { schema: SCHEMA, imported: validated.envs.length, errors: [], config: publicConfig(cfg), envs: envsPayload() }
      },
    },
    ...tuneRouteDefs,
    ...deployRouteDefs,
  ]

  async function demoSeed() {
    const demo = demoRuns()
    const snap = { ...demoSnapshot(), source: { ...baseSource('demo', true), host: 'demo' } }
    await store.mutate((state) => {
      // 只写演示分仓，绝不触碰真实 runs/snapshots
      if (!state.demo_snapshots.some((s) => s.source?.source_ref === snap.source.source_ref)) state.demo_snapshots.push(snap)
      for (const run of demo) {
        if (!state.demo_runs.some((r) => r.run_id === run.run_id)) state.demo_runs.push(run)
      }
    })
    return { runs: demo, snapshot: snap }
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/api/ascend-perf',
      async handler(req, res) {
        const send = (status, payload) => {
          const body = JSON.stringify(payload)
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
        }
        try {
          // R1：鉴权 fail-closed。取不到 connection、鉴权服务异常或未认证时一律拒绝，
          // 只有 requestRejection 明确放行（返回 falsy）才继续处理请求。
          let conn
          try {
            conn = ctx.get?.('connection')
          } catch {
            conn = null
          }
          if (!conn || typeof conn.requestRejection !== 'function') {
            res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ schema: SCHEMA, error: { code: 'AUTH_UNAVAILABLE', message: '鉴权服务不可用，已拒绝请求', retryable: true, details: null } }))
            return
          }
          let rejected
          try {
            rejected = conn.requestRejection({ headers: req.headers, method: req.method, url: req.url })
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ schema: SCHEMA, error: { code: 'AUTH_ERROR', message: `鉴权检查失败：${String(error?.message ?? error).slice(0, 256)}`, retryable: true, details: null } }))
            return
          }
          if (rejected) {
            res.writeHead(typeof rejected === 'number' ? rejected : 401)
            res.end()
            return
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const pathname = url.pathname.replace(/\/+$/, '')
          const routePath = pathname.replace(/^\/api\/ascend-perf/, '') || '/state'
          const method = String(req.method ?? 'GET').toUpperCase()
          // 精确路径优先；带 :id 的路由（部署计划等）回退到 pattern 正则匹配，捕获组经 params 传入。
          let route = routes.find((r) => r.path === routePath && r.method === method)
          let params = []
          if (!route) {
            for (const candidate of routes) {
              if (candidate.method !== method || !(candidate.pattern instanceof RegExp)) continue
              const match = candidate.pattern.exec(routePath)
              if (match) { route = candidate; params = match.slice(1); break }
            }
          }
          if (!route) {
            if (routes.some((r) => r.path === routePath || (r.pattern instanceof RegExp && r.pattern.test(routePath)))) return send(405, { schema: SCHEMA, error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的方法' } })
            return send(404, { schema: SCHEMA, error: { code: 'NOT_FOUND', message: '未知接口' } })
          }
          const query = Object.fromEntries(url.searchParams)
          if (route.method === 'GET' || route.method === 'DELETE') {
            const data = await route.handler({}, query, params)
            return send(200, data)
          }
          const body = await readJsonBody(req, MAX_IMPORT_BYTES + 64 * 1024)
          const data = await route.handler(body, query, params)
          return send(200, data)
        } catch (error) {
          const code = error?.code ?? 'STORE_IO'
          send(400, { schema: SCHEMA, error: { code, message: String(error?.message ?? error).slice(0, 512), retryable: false, details: error?.details ?? null } })
        }
      },
    })
    return () => dispose()
  }, 'ascend-perf: web routes')

  // 暴露只读诊断（不注册为服务，避免污染命名空间）
  // 不向 ctx 注入自定义属性：Cordis 要求先 provide，本插件无需跨插件共享服务
}

/* ------------------------------------------------------------------ */
/* 工具渲染 + 杂项                                                     */
/* ------------------------------------------------------------------ */

function apiError(code, message) {
  return new ApiFailure(code, message)
}

function renderStatus(_args, value) {
  const snapshot = value?.data
  const errors = value?.error
  if (errors) return [{ type: 'text', text: `昇腾状态采集失败：${errors.code} ${errors.message}` }]
  if (!snapshot) return [{ type: 'text', text: '昇腾状态：无数据' }]
  const head = `昇腾状态：${snapshot.availability}，${snapshot.npu.card_count} 卡 / ${snapshot.npu.chip_count} chip，npu-smi ${snapshot.software.npu_smi ?? '未知'}`
  const lines = [head]
  for (const card of snapshot.npu.cards.slice(0, 8)) {
    lines.push(`- NPU ${card.card_id} ${card.model ?? ''}：` + card.chips.map((c) => `chip${c.chip_id} ${c.temp_c ?? '—'}°C ${c.power_w ?? '—'}W HBM ${c.hbm_used_mb ?? '—'}/${c.hbm_total_mb ?? '—'}MB`).join('；'))
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderImport(args, value) {
  const action = args?.action ?? 'import'
  const labelOf = (r) => `${r.label}（${r.run_id}）`
  if (action === 'list') {
    const runs = value?.runs ?? []
    if (!runs.length) return [{ type: 'text', text: '运行记录：暂无（可导入 benchmark 或加载演示数据）' }]
    return [{ type: 'text', text: `运行记录 ${runs.length} 条：\n` + runs.map((r) => `- ${labelOf(r)}`).join('\n') }]
  }
  if (action === 'get') return [{ type: 'text', text: `运行 ${labelOf(value.run)}` }]
  if (action === 'delete_runs') return [{ type: 'text', text: `已移除 ${value?.deleted ?? 0} 条运行` }]
  if (action === 'reset_store') return [{ type: 'text', text: `已清空仓储（移除 ${value?.deleted ?? 0} 条运行与全部快照）` }]
  if (action === 'load_demo') {
    const runs = value?.runs ?? []
    return [{ type: 'text', text: `已加载演示数据：快照 ${value?.snapshot?.snapshot_id ?? 'demo'}，${runs.length} 条运行\n` + runs.map((r) => `- ${labelOf(r)}`).join('\n') }]
  }
  if (value?.hotspots !== undefined) return [{ type: 'text', text: `已导入 ${value.hotspots} 条算子热点` }]
  if (value?.runs) {
    return [{ type: 'text', text: `已导入 ${value.runs.length} 条运行：${value.runs.map((r) => r.label).join('、')}${value.deduplicated ? '（复用已有记录）' : ''}\n` + value.runs.map((r) => `- ${labelOf(r)}`).join('\n') }]
  }
  return [{ type: 'text', text: `运行记录：${value?.runs?.length ?? 0} 条` }]
}

function renderCompare(_args, value) {
  const comparison = value?.comparison
  if (!comparison) return [{ type: 'text', text: `对比导出：${value?.filename ?? '已生成'}` }]
  const lines = [
    `对比结论：${comparison.summary.conclusion}（${comparison.summary.message}）`,
    `可比性：${comparison.comparability}；阈值 ±${comparison.threshold_pct}%`,
  ]
  for (const m of comparison.metrics) {
    lines.push(`- ${m.key}: ${fmt(m.baseline)} → ${fmt(m.candidate)} (${m.delta_pct === null ? '—' : `${m.delta_pct}%`}) ${m.verdict}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderInsight(_args, value) {
  const insights = value?.insights ?? []
  if (insights.length === 0) return [{ type: 'text', text: `洞察：未命中规则（跳过 ${value?.skipped_rules?.length ?? 0} 条）` }]
  return [{ type: 'text', text: insights.map((i) => `[${i.severity}] ${i.title} → ${i.suggestion}`).join('\n') }]
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new ApiFailure('INPUT_TOO_LARGE', '请求体超过限制'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new ApiFailure('PARSE_ERROR', '请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => reject(new ApiFailure('PARSE_ERROR', String(error?.message ?? error))))
  })
}

function normalizePorts(raw) {
  const list = Array.isArray(raw) ? raw : [8000]
  const ports = []
  for (const item of list.slice(0, 4)) {
    const port = Number(item)
    if (Number.isInteger(port) && port >= 1024 && port <= 65535 && !ports.includes(port)) ports.push(port)
  }
  return ports.length ? ports : [8000]
}

const SETTINGS_FILE = 'settings.json'
const SAFE_HOST_ALIAS = /^[A-Za-z0-9_.:@-]+$/
const SAFE_NPU_PATH = /^[A-Za-z0-9_./~-]+$/

function readSettings(dataDir) {
  try {
    const file = join(dataDir, SETTINGS_FILE)
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return isPlainObject(raw) ? raw : null
  } catch {
    return null
  }
}

function writeSettings(dataDir, settings) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = join(dataDir, SETTINGS_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  try { chmodSync(dataDir, 0o700) } catch { /* best effort */ }
}

const MAX_ENVS = 16
const DEFAULT_POLL_MS = 300000
const MIN_POLL_MS = 60000
const MAX_POLL_MS = 3600000
const SSH_TARGET_RE = /[A-Za-z_][A-Za-z0-9_.-]*@[A-Za-z0-9.-]+/g

// t44 C：SSH 聚合采集——单连接最低 45s 超时；exit 255 重试 1 次、间隔 1.5s（测试可经 cfg.sshRetryDelayMs 注入）。
const SSH_AGGREGATE_MIN_TIMEOUT_MS = 45000
const SSH_RETRY_DELAY_MS = 1500

/* ------------------------------ envs.json（配置文件化） ------------------------------ */

const ENVS_CONFIG_FILE = 'envs.json'

// 返回 { payload }（读到配置）、{ error }（文件存在但不可解析）或 null（文件不存在）。
function readEnvsConfig(configDir) {
  const file = join(configDir, ENVS_CONFIG_FILE)
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!isPlainObject(raw)) return { error: { code: 'CONFIG_READ_FAILED', message: `${file} 必须是 JSON 对象` } }
    return { payload: raw }
  } catch (error) {
    return { error: { code: 'CONFIG_READ_FAILED', message: `${file} 读取失败：${String(error?.message ?? error).slice(0, 200)}` } }
  }
}

function writeEnvsConfig(configDir, payload) {
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const file = join(configDir, ENVS_CONFIG_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  try { chmodSync(configDir, 0o700) } catch { /* best effort */ }
}

function envsConfigPayload(cfg) {
  return { version: 1, pollIntervalMs: cfg.pollIntervalMs ?? DEFAULT_POLL_MS, envs: cfg.envs ?? [] }
}

/* ------------------------------ 占用判定（§14.3，与 client.js 同规则） ------------------------------ */

// chip 级：可见进程 → 占用；否则 HBM ≥5%（缺率值时用 used/total 计算）或 AICore ≥5% → 占用；
// 未命中且 processes_state='unknown'（采集/解析异常，进程信息拿不到）→ 未知；
// none_reported（npu-smi 正常返回、进程列表为空）按低指标判空闲（t18：不再占用未知）。
export function chipOccupancyState(chip) {
  if (!chip) return 'unknown'
  const procs = Array.isArray(chip.processes) ? chip.processes : []
  if (chip.processes_state === 'observed' && procs.length > 0) return 'occupied'
  let hbmRate = null
  if (typeof chip.hbm_usage_rate_pct === 'number') hbmRate = chip.hbm_usage_rate_pct
  else if (typeof chip.hbm_used_mb === 'number' && typeof chip.hbm_total_mb === 'number' && chip.hbm_total_mb > 0) hbmRate = (chip.hbm_used_mb / chip.hbm_total_mb) * 100
  if (hbmRate !== null && hbmRate >= 10) return 'occupied' // 5% 左右是 910B 空闲基线（b02 实测 5.2%），阈值过低会把空闲误判为占用
  if (typeof chip.aicore_pct === 'number' && chip.aicore_pct >= 5) return 'occupied'
  if (chip.processes_state === 'unknown') return 'unknown'
  return 'idle'
}

// 环境级：total = 占用 + 空闲（未知不计入分母）；0 占用→空闲；≥⌈0.75×total⌉（total<4 需全部）→高负载；其余部分占用；total=0→占用未知。
export function summarizeEnvOccupancy(snapshot) {
  if (!snapshot || snapshot.availability !== 'available' || !Array.isArray(snapshot.npu?.cards)) return null
  let occupied = 0
  let idle = 0
  let unknown = 0
  let chipCount = 0
  const procs = new Map()
  for (const card of snapshot.npu.cards) {
    for (const chip of card.chips ?? []) {
      chipCount += 1
      const state = chipOccupancyState(chip)
      if (state === 'occupied') {
        occupied += 1
        for (const proc of chip.processes ?? []) {
          const key = proc?.name || String(proc?.pid)
          const cur = procs.get(key) ?? { name: key, count: 0, memory_mb_sum: 0 }
          cur.count += 1
          cur.memory_mb_sum += typeof proc?.memory_mb === 'number' ? proc.memory_mb : 0
          procs.set(key, cur)
        }
      } else if (state === 'idle') idle += 1
      else unknown += 1
    }
  }
  const total = occupied + idle
  let tier = 'unknown'
  if (total >= 1) {
    const need = total < 4 ? total : Math.ceil(0.75 * total)
    tier = occupied === 0 ? 'idle' : occupied >= need ? 'busy' : 'partial'
  }
  return {
    state: tier,
    busy_chip_count: occupied,
    total_chip_count: total,
    unknown_chip_count: unknown,
    chip_count: chipCount,
    top_processes: [...procs.values()]
      .sort((a, b) => b.count - a.count || b.memory_mb_sum - a.memory_mb_sum)
      .slice(0, 3)
      .map((p) => ({ name: p.name, count: p.count, memory_mb_sum: Math.round(p.memory_mb_sum) })),
  }
}

function safeHostAlias(value) {
  const alias = typeof value === 'string' ? value.trim() : ''
  if (!alias || alias.length > 128 || alias.startsWith('-') || !SAFE_HOST_ALIAS.test(alias)) return null
  return alias
}

function safeNpuPath(value) {
  const path = typeof value === 'string' ? value.trim() : ''
  if (!path || path.length > 512 || !SAFE_NPU_PATH.test(path)) return null
  return path
}

function normalizeEnvInput(raw, index) {
  if (!isPlainObject(raw)) throw apiError('INVALID_ARGUMENT', `envs[${index}] 必须是对象`)
  const mode = raw.mode === 'local' ? 'local' : raw.mode === 'ssh' ? 'ssh' : null
  if (!mode) throw apiError('INVALID_ARGUMENT', `envs[${index}].mode 必须是 local 或 ssh`)
  let hostAlias = null
  if (mode === 'ssh') {
    hostAlias = safeHostAlias(raw.hostAlias ?? raw.alias)
    if (!hostAlias) throw apiError('INVALID_ARGUMENT', `envs[${index}].hostAlias 无效（仅支持字母数字与 _ . : @ -，最长 128）`)
  }
  const npuSmiPath = safeNpuPath(raw.npuSmiPath ?? 'npu-smi') ?? 'npu-smi'
  const timeoutRaw = Number(raw.timeoutMs ?? 15000)
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(60000, Math.max(1000, Math.round(timeoutRaw))) : 15000
  const id = typeof raw.id === 'string' && /^env-[A-Za-z0-9_-]{1,48}$/.test(raw.id) ? raw.id : `env-${newId('v').slice(-12)}`
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 64) : (mode === 'local' ? '本机' : hostAlias)
  return { id, name, mode, hostAlias, npuSmiPath, timeoutMs, enabled: raw.enabled !== false }
}

function parseSshTargetFile(text) {
  const found = []
  const seen = new Set()
  for (const match of String(text ?? '').matchAll(SSH_TARGET_RE)) {
    const target = match[0]
    if (safeHostAlias(target) && !seen.has(target)) {
      seen.add(target)
      found.push(target)
    }
  }
  return found
}

/* ------------------------------ envs 空态导入（SSH 主机 / 粘贴 JSON） ------------------------------ */

// 读 DSH ssh 插件主机仓（$DSH_HOME/dsh-ssh.json）：只取 alias/host/user/tags 等非敏感字段。
// auth（密码/私钥路径/passphrase）绝不读取、绝不出现在返回值或 envs.json 中。
export function readSshHostsStore(file) {
  try {
    if (!existsSync(file)) {
      return { error: { code: 'SSH_HOSTS_NOT_FOUND', message: `未找到 DSH SSH 主机配置（${file}）。可先在 DSH 的 SSH 面板添加主机，或改用「粘贴 JSON 导入」。` } }
    }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const hosts = Array.isArray(raw?.hosts) ? raw.hosts : []
    const entries = []
    for (const item of hosts) {
      if (!isPlainObject(item)) continue
      const alias = typeof item.alias === 'string' ? item.alias.trim() : ''
      if (!alias) continue
      entries.push({
        alias,
        user: typeof item.user === 'string' ? item.user : '',
        host: typeof item.host === 'string' ? item.host : '',
        tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string').slice(0, 16) : [],
      })
    }
    if (entries.length === 0) return { error: { code: 'SSH_HOSTS_EMPTY', message: `SSH 主机配置（${file}）中没有可用主机。` } }
    return { hosts: entries }
  } catch (error) {
    return { error: { code: 'SSH_HOSTS_READ_FAILED', message: `读取 SSH 主机配置失败：${String(error?.message ?? error).slice(0, 200)}` } }
  }
}

// 由主机别名生成合法环境 id（env-[A-Za-z0-9_-]{1,48}），并避开已占用 id。
function envIdFromAlias(alias, taken) {
  const slug = alias.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'host'
  let id = `env-${slug}`.slice(0, 53)
  let n = 2
  while (taken.has(id)) {
    id = `env-${slug}-${n++}`.slice(0, 53)
  }
  taken.add(id)
  return id
}

// 生成 SSH 导入预览：rows 逐台给出 skip 原因；draft 为可导入的环境草稿
// （tag 含 ascend/npu 的主机优先，随后按别名排序，受 MAX_ENVS 剩余容量截断）。
export function sshHostsImportPreview(hosts, existingEnvs) {
  const existing = Array.isArray(existingEnvs) ? existingEnvs : []
  const takenAliases = new Set(existing.filter((e) => e?.mode === 'ssh').map((e) => e?.hostAlias).filter(Boolean))
  const takenIds = new Set(existing.map((e) => e?.id).filter(Boolean))
  const capacity = Math.max(0, MAX_ENVS - existing.length)
  const rows = []
  for (const item of hosts) {
    const aliasOk = safeHostAlias(item?.alias)
    let skip = null
    if (!aliasOk) skip = '别名无效（仅支持字母数字与 _ . : @ -）'
    else if (takenAliases.has(aliasOk)) skip = 'hostAlias 已存在'
    const tags = Array.isArray(item?.tags) ? item.tags : []
    const ascend = tags.some((tag) => {
      const lower = String(tag).toLowerCase()
      return lower.includes('ascend') || lower.includes('npu')
    })
    rows.push({ alias: item?.alias ?? '', user: item?.user ?? '', host: item?.host ?? '', tags, ascend, skip })
  }
  const draft = rows
    .filter((row) => !row.skip)
    .sort((a, b) => Number(b.ascend) - Number(a.ascend) || String(a.alias).localeCompare(String(b.alias)))
    .slice(0, capacity)
    .map((row) => ({
      id: envIdFromAlias(row.alias, takenIds),
      name: row.alias,
      mode: 'ssh',
      hostAlias: row.alias,
      npuSmiPath: 'npu-smi',
      timeoutMs: 15000,
      enabled: true,
    }))
  return { rows, draft, capacity }
}

// 解析粘贴的 JSON：接受环境数组或 {envs:[...]}（可带 pollIntervalMs）。
export function parseEnvsImportText(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch (error) {
    return { error: { code: 'INVALID_JSON', message: `JSON 解析失败：${String(error?.message ?? error).slice(0, 200)}` } }
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.envs) ? parsed.envs : null
  if (!list) return { error: { code: 'INVALID_ARGUMENT', message: '内容必须是环境数组，或形如 {"envs": [...]} 的对象' } }
  const pollIntervalMs = isPlainObject(parsed) && typeof parsed.pollIntervalMs === 'number' ? parsed.pollIntervalMs : null
  return { envs: list, pollIntervalMs }
}

// 逐条校验导入环境：任何一条非法都返回完整错误清单且不落盘（全有或全无）。
export function validateEnvsImport(list, existingEnvs) {
  const existing = Array.isArray(existingEnvs) ? existingEnvs : []
  const errors = []
  if (!Array.isArray(list) || list.length === 0) return { errors: [{ index: -1, message: '环境列表为空' }] }
  if (existing.length + list.length > MAX_ENVS) {
    errors.push({ index: -1, message: `环境总数超过上限：现有 ${existing.length} 个 + 导入 ${list.length} 个 > ${MAX_ENVS}` })
  }
  const seenIds = new Set(existing.map((e) => e?.id).filter(Boolean))
  const seenAliases = new Set(existing.filter((e) => e?.mode === 'ssh').map((e) => e?.hostAlias).filter(Boolean))
  const envs = []
  list.forEach((raw, index) => {
    try {
      const env = normalizeEnvInput(raw, index)
      if (seenIds.has(env.id)) throw apiError('INVALID_ARGUMENT', `envs[${index}].id 与现有环境重复：${env.id}`)
      if (env.mode === 'ssh' && seenAliases.has(env.hostAlias)) throw apiError('INVALID_ARGUMENT', `envs[${index}].hostAlias 与现有环境重复：${env.hostAlias}`)
      seenIds.add(env.id)
      if (env.mode === 'ssh') seenAliases.add(env.hostAlias)
      envs.push(env)
    } catch (error) {
      errors.push({ index, message: String(error?.message ?? error).replace(/^Error: /, '') })
    }
  })
  return errors.length > 0 ? { errors } : { envs }
}


function seedEnvs(cfg, raw) {
  // envs 数组（含空数组）视为显式配置：不再落入播种分支
  if (Array.isArray(raw?.envs)) {
    const ids = new Set()
    const envs = raw.envs.slice(0, MAX_ENVS).map((entry, index) => {
      const env = normalizeEnvInput(entry, index)
      if (ids.has(env.id)) env.id = `env-${newId('v').slice(-12)}`
      ids.add(env.id)
      return env
    })
    return { envs, changed: false }
  }
  const envs = []
  const seen = new Set()
  const push = (env) => {
    const key = env.mode === 'local' ? 'local' : env.hostAlias
    if (!seen.has(key)) {
      seen.add(key)
      envs.push(env)
    }
  }
  // 旧版单目标配置迁移为第一个环境
  const legacyAlias = safeHostAlias(raw?.ssh?.hostAlias)
  if (raw?.target === 'ssh' && legacyAlias) {
    push(normalizeEnvInput({ mode: 'ssh', hostAlias: legacyAlias, npuSmiPath: raw.ssh.npuSmiPath, timeoutMs: raw.timeout, name: legacyAlias }, 0))
  }
  // 无任何环境时，从插件配置目录的 npu-ssh.md / npu.env 静默播种（用户手工维护的登录方式文件）
  try {
    const md = readFileSync(join(cfg.configDir, 'npu-ssh.md'), 'utf8')
    for (const target of parseSshTargetFile(md).slice(0, MAX_ENVS)) {
      push(normalizeEnvInput({ mode: 'ssh', hostAlias: target, name: target }, envs.length))
    }
  } catch { /* 文件不存在或不可读：跳过播种 */ }
  if (envs.length === 0) {
    try {
      const envText = readFileSync(join(cfg.configDir, 'npu.env'), 'utf8')
      const matched = envText.match(/^NPU_SSH_TARGET=(.+)$/m)
      const target = matched ? matched[1].trim() : null
      if (target && safeHostAlias(target)) push(normalizeEnvInput({ mode: 'ssh', hostAlias: target, name: target }, 0))
    } catch { /* 文件不存在或不可读：跳过播种 */ }
  }
  return { envs, changed: envs.length > 0 }
}

function mirrorPrimaryEnv(cfg) {
  const primary = cfg.envs.find((env) => env.enabled && env.mode === 'ssh') ?? cfg.envs.find((env) => env.enabled) ?? cfg.envs[0] ?? null
  cfg.primaryEnvId = primary?.id ?? null
  if (!primary) return
  if (primary.mode === 'ssh') {
    cfg.ssh.enabled = true
    cfg.ssh.hostAlias = primary.hostAlias
  } else {
    cfg.ssh.enabled = false
  }
  cfg.ssh.npuSmiPath = primary.npuSmiPath
  cfg.npuSmiPath = primary.npuSmiPath
  cfg.timeout = primary.timeoutMs
}

function applyEnvSettings(cfg, raw) {
  const { envs, changed } = seedEnvs(cfg, raw)
  cfg.envs = envs
  const poll = Number(raw?.pollIntervalMs)
  cfg.pollIntervalMs = Number.isFinite(poll) ? Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(poll))) : DEFAULT_POLL_MS
  mirrorPrimaryEnv(cfg)
  return changed
}

function settingsV2Payload(cfg) {
  return {
    version: 2,
    pollIntervalMs: cfg.pollIntervalMs ?? DEFAULT_POLL_MS,
    envs: cfg.envs ?? [],
    target: cfg.ssh.enabled ? 'ssh' : 'local',
    npuSmiPath: cfg.npuSmiPath,
    timeout: cfg.timeout,
    regressionThreshold: cfg.regressionThreshold,
    ssh: { hostAlias: cfg.ssh.hostAlias, npuSmiPath: cfg.ssh.npuSmiPath },
  }
}

function publicConfig(cfg) {
  return {
    version: 2,
    configFile: join(cfg.configDir, ENVS_CONFIG_FILE),
    pollIntervalMs: cfg.pollIntervalMs ?? DEFAULT_POLL_MS,
    envs: (cfg.envs ?? []).map((env) => ({ id: env.id, name: env.name, mode: env.mode, hostAlias: env.hostAlias, npuSmiPath: env.npuSmiPath, timeoutMs: env.timeoutMs, enabled: env.enabled })),
    target: cfg.ssh.enabled ? 'ssh' : 'local',
    npuSmiPath: cfg.npuSmiPath,
    timeout: cfg.timeout,
    regressionThreshold: cfg.regressionThreshold,
    ssh: {
      hostAlias: cfg.ssh.hostAlias,
      npuSmiPath: cfg.ssh.npuSmiPath,
    },
  }
}

function applySettings(cfg, raw) {
  if (!isPlainObject(raw)) return
  const npu = safeNpuPath(raw.npuSmiPath)
  if (npu) cfg.npuSmiPath = npu
  const timeout = Number(raw.timeout)
  if (Number.isFinite(timeout)) cfg.timeout = Math.min(60000, Math.max(1000, timeout))
  const threshold = Number(raw.regressionThreshold)
  if (Number.isFinite(threshold)) cfg.regressionThreshold = Math.min(50, Math.max(0.1, threshold))
  const target = raw.target === 'ssh' ? 'ssh' : 'local'
  if (target === 'ssh') {
    const alias = safeHostAlias(raw.ssh?.hostAlias)
    const sshNpu = safeNpuPath(raw.ssh?.npuSmiPath)
    if (alias) {
      cfg.ssh.enabled = true
      cfg.ssh.hostAlias = alias
      if (sshNpu) cfg.ssh.npuSmiPath = sshNpu
    }
  } else {
    cfg.ssh.enabled = false
  }
}

function updateSettings(cfg, dataDir, configDir, body) {
  if (!isPlainObject(body)) throw apiError('INVALID_ARGUMENT', '配置必须是对象')
  // v2：多环境整体替换 + 轮询间隔 —— t17 起持久化到 configDir/envs.json（工具/API 通道，UI 不再调用）
  if (body.envs !== undefined || body.pollIntervalMs !== undefined) {
    const next = settingsV2Payload(cfg)
    if (body.pollIntervalMs !== undefined) {
      const value = Number(body.pollIntervalMs)
      if (!Number.isFinite(value) || value < MIN_POLL_MS || value > MAX_POLL_MS) throw apiError('INVALID_ARGUMENT', `pollIntervalMs 必须在 ${MIN_POLL_MS}–${MAX_POLL_MS} ms 之间`)
      next.pollIntervalMs = Math.round(value)
    }
    if (body.envs !== undefined) {
      if (!Array.isArray(body.envs) || body.envs.length === 0) throw apiError('INVALID_ARGUMENT', 'envs 必须是非空数组')
      if (body.envs.length > MAX_ENVS) throw apiError('INVALID_ARGUMENT', `环境数量最多 ${MAX_ENVS} 个`)
      const ids = new Set()
      next.envs = body.envs.map((entry, index) => {
        const env = normalizeEnvInput(entry, index)
        if (ids.has(env.id)) throw apiError('INVALID_ARGUMENT', `envs[${index}].id 重复：${env.id}`)
        ids.add(env.id)
        return env
      })
    }
    applyEnvSettings(cfg, next)
    mirrorPrimaryEnv(cfg)
    writeEnvsConfig(configDir, envsConfigPayload(cfg))
    return publicConfig(cfg)
  }
  const next = publicConfig(cfg)
  if (body.target !== undefined) {
    if (body.target !== 'local' && body.target !== 'ssh') throw apiError('INVALID_ARGUMENT', 'target 必须是 local 或 ssh')
    next.target = body.target
  }
  if (body.npuSmiPath !== undefined) {
    const value = safeNpuPath(body.npuSmiPath)
    if (!value) throw apiError('INVALID_ARGUMENT', 'npu-smi 路径包含不支持的字符')
    next.npuSmiPath = value
  }
  if (body.timeout !== undefined) {
    const value = Number(body.timeout)
    if (!Number.isFinite(value) || value < 1000 || value > 60000) throw apiError('INVALID_ARGUMENT', 'timeout 必须在 1000–60000 ms 之间')
    next.timeout = Math.round(value)
  }
  if (next.target === 'ssh') {
    const rawAlias = body.sshAlias !== undefined ? body.sshAlias : body.ssh?.hostAlias
    const alias = safeHostAlias(rawAlias)
    if (!alias) throw apiError('INVALID_ARGUMENT', 'SSH 别名不能为空，且只能包含字母、数字、_ . : @ -')
    next.ssh.hostAlias = alias
    if (body.sshNpuSmiPath !== undefined || body.ssh?.npuSmiPath !== undefined) {
      const sshNpu = safeNpuPath(body.sshNpuSmiPath ?? body.ssh?.npuSmiPath)
      if (!sshNpu) throw apiError('INVALID_ARGUMENT', '远端 npu-smi 路径包含不支持的字符')
      next.ssh.npuSmiPath = sshNpu
    }
  }
  applySettings(cfg, next)
  writeSettings(dataDir, next)
  return next
}

function normalizeConfig(raw) {
  const timeout = Number(raw?.timeout)
  const threshold = Number(raw?.regressionThreshold)
  const ssh = isPlainObject(raw?.ssh) ? raw.ssh : {}
  return {
    npuSmiPath: typeof raw?.npuSmiPath === 'string' && raw.npuSmiPath.trim() ? raw.npuSmiPath.trim() : 'npu-smi',
    timeout: Number.isFinite(timeout) ? Math.min(60000, Math.max(1000, timeout)) : 15000,
    regressionThreshold: Number.isFinite(threshold) ? Math.min(50, Math.max(0.1, threshold)) : 5,
    demoMode: Boolean(raw?.demoMode),
    dataDir: typeof raw?.dataDir === 'string' && raw.dataDir.trim() ? raw.dataDir.trim() : join(homedir(), '.local', 'share', 'dsh-ascend-perf'),
    configDir: typeof raw?.configDir === 'string' && raw.configDir.trim() ? raw.configDir.trim() : join(homedir(), '.config', 'ascend-perf'),
    // DSH ssh 插件主机仓（~/.dsh/dsh-ssh.json）：仅用于「从 SSH 主机导入」空态引导，可注入用于测试。
    sshHostsFile: typeof raw?.sshHostsFile === 'string' && raw.sshHostsFile.trim() ? raw.sshHostsFile.trim() : join(homedir(), '.dsh', 'dsh-ssh.json'),
    // t44 C：exit 255 重试间隔（默认 1.5s）；测试注入 0/1 避免真等。
    sshRetryDelayMs: Number.isFinite(raw?.sshRetryDelayMs) ? raw.sshRetryDelayMs : null,
    cwd: '/',
    tuning: {
      // 真实执行器硬开关：即使配置为 true，也还需要 Host 授权桥；当前实现始终拒绝真实启动。
      enableRealExecutors: false,
      ports: normalizePorts(raw?.tuning?.ports),
    },
    ssh: {
      enabled: Boolean(ssh.enabled),
      hostAlias: typeof ssh.hostAlias === 'string' && ssh.hostAlias.trim() ? ssh.hostAlias.trim() : null,
      npuSmiPath: typeof ssh.npuSmiPath === 'string' && ssh.npuSmiPath.trim() ? ssh.npuSmiPath.trim() : 'npu-smi',
    },
  }
}
