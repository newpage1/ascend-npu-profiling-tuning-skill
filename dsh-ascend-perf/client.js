/**
 * 昇腾性能工作台 —— Client 侧（右侧栏面板）。
 *
 * 仅依赖 `react`，通过 window.__ModuleLoader__ 加载；样式只使用 --dsw-alias-* 设计令牌，
 * 所有文案经 Client locale service 提供 zh/en。界面只读取 Host REST 结果，不推断数据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ascend-perf',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const NS = 'dsh-ascend-perf'
    const TAB_ID = 'dsh-ascend-perf'
    const TAB_KIND = 'ascend-perf'
    const API = '/api/ascend-perf'
    // 发布构建会把这里替换为 'env'：插件市场 v1 只注册「环境信息」视图；
    // 本地完整版保持 'full'，服务部署/性能调优继续打磨。
    const EDITION = 'env'

    const DEFAULT_TUNE_SPEC = {
      schema: 'dsh-ascend-perf/tune-spec-v1',
      label: 'Qwen3-8B 演示调优',
      executor: 'demo',
      target_id: 'demo-ascend',
      profile_id: 'demo-vllm-v1',
      model_asset_id: 'demo-qwen3-8b',
      dataset_asset_id: 'synthetic-random-v1',
      fixed: { dtype: 'bfloat16', quantization: 'none', tensor_parallel: 1, device_ids: [0], served_model_name: 'tune-model' },
      baseline: { max_num_seqs: 16, max_num_batched_tokens: 2048, gpu_memory_utilization: 0.85, max_model_len: 4096 },
      space: { max_num_seqs: [8, 16, 32], max_num_batched_tokens: [1024, 2048, 4096] },
      workload: { input_len: 512, output_len: 128, num_prompts: 1000, max_concurrency: 32, request_rate_mode: 'unbounded', seed: 42, stream: true, ignore_eos: true },
      objective: { metric: 'output_throughput_tps', direction: 'higher', constraints: { ttft_p99_ms_max: 800, tpot_p99_ms_max: 60, success_rate_pct_min: 99 }, min_gain_pct: 3, noise_floor_pct: 2, tie_epsilon_pct: 1 },
      search: { method: 'grid', seed: 42, max_candidates: 4 },
      measurement: { warmup_runs: 1, repeats: 3, confirm_repeats: 2, confirm_top_k: 1, baseline_check_every: 3, baseline_drift_pct_max: 5 },
      budget: { max_trials: 12, max_bench_invocations: 64, max_total_seconds: 7200, max_total_tokens: 50000000, startup_timeout_s: 180, bench_timeout_s: 90, shutdown_grace_s: 10, cleanup_reserve_s: 30, max_failed_trials: 2, max_consecutive_failures: 2, patience: 6 },
    }

    const zh = {
      'meta.title': '昇腾性能调优',
      'panel.title': '昇腾环境监控',
      'panel.guideDescription': '多环境 NPU 占用视图：从 envs.json 读取环境，只读采集 npu-smi，展示空闲/部分/高负载、占用进程与逐卡逐 chip 详情。',
      'action.refresh': '刷新状态',
      'action.import': '导入运行',
      'action.loadDemo': '加载演示数据',
      'action.exitDemo': '退出演示',
      'action.compare': '开始对比',
      'action.export': '导出摘要',
      'action.copy': '复制',
      'action.delete': '移除',
      'action.retry': '重试',
      'action.cancel': '取消',
      'section.setup': '采集目标',
      'envs.title': '多环境占用',
      'envs.configManaged': '环境在配置文件中管理',
      'envs.configFile': '环境配置：{path}',
      'envs.autoEvery': '每 {n} 分钟自动采集',
      'envs.autoEveryDefault': '自动采集',
      'envs.modeLocal': '本机',
      'envs.modeSsh': 'SSH',
      'envs.fallbackName': '环境 {n}',
      'envs.f.mode': '模式',
      'envs.tier.idle': '空闲',
      'envs.tier.partial': '部分占用',
      'envs.tier.busy': '高负载',
      'envs.tier.unknown': '占用未知',
      'envs.tier.disabled': '已停用',
      'envs.tier.count': '{occ}/{total} chip 占用',
      'envs.chipAbnormal': '{k} chip 异常',
      'envs.procsLabel': '占用进程',
      'envs.procsNone': '无占用进程',
      'envs.procsUnavailable': '进程信息不可用',
      'envs.procsUnavailableByMetrics': '进程信息不可用（按指标判定占用）',
      'envs.procsMore': '…另 {n} 个进程',
      'envs.chip.idle': '空闲',
      'envs.chip.occupied': '占用',
      'envs.chip.unknown': '未知',
      'envs.f.name': '名称',
      'envs.f.hostAlias': 'SSH 目标（user@host 或 ~/.ssh 别名）',
      'envs.f.npuSmiPath': 'npu-smi 路径',
      'envs.f.timeoutMs': '超时（ms）',
      'envs.f.enabled': '启用自动采集',
      'envs.f.enabledHint': '关闭仅停止自动采集，仍可手动刷新',
      'envs.config.open': '环境配置',
      'envs.config.title': '环境配置',
      'envs.config.poll': '采集频率（分钟）',
      'envs.config.add': '添加环境',
      'envs.config.remove': '删除',
      'envs.config.save': '保存',
      'envs.config.cancel': '取消',
      'envs.config.saved': '已保存环境配置（写入 envs.json）',
      'envs.config.limit': '最多 16 个环境',
      'envs.config.err.poll': '采集频率需为 1–60 的整数分钟',
      'envs.config.err.nameEmpty': '名称不能为空',
      'envs.config.err.nameLong': '名称最长 64 个字符',
      'envs.config.err.hostRequired': 'SSH 目标不能为空',
      'envs.config.err.hostInvalid': '仅允许字母、数字、点、下划线、冒号、@、连字符',
      'envs.config.err.hostUserHost': 'user@host 形式不合法（用户名与主机名仅字母数字点下划线连字符）',
      'envs.config.err.pathInvalid': '路径仅允许字母、数字、点、斜杠、下划线、连字符',
      'envs.config.err.timeoutRange': '超时需为 1000–60000 的整数',
      'envs.reload': '重新加载配置',
      'envs.reload.done': '已重新加载配置：{n} 个环境',
      'envs.inlineTitle': '指标摘要',
      'envs.expandCards': '展开 {n} 卡详情',
      'envs.collapseCards': '收起卡详情',
      'envs.conn.unreachable': '连接失败',
      'envs.conn.commandMissing': '缺少 npu-smi',
      'envs.conn.noDevice': '未检测到 NPU',
      'envs.conn.pending': '未采集',
      'envs.conn.stale': '数据过期',
      'envs.conn.collecting': '采集中',
      'envs.conn.flap': '连接抖动 · 上次 {time}',
      'envs.firstCollect': '首次采集将在几秒内自动开始，或点击“刷新”。',
      'envs.staleHint': '上次成功采集较早，占用视图可能已过期。',
      'envs.disabledHint': '停用仅停止自动采集，仍可手动刷新。',
      'envs.import.title': '还没有环境配置',
      'envs.import.desc': '通过下面任一方式导入，或手动编辑配置文件（0600）：{path}',
      'envs.import.viaSsh': '从 SSH 主机导入',
      'envs.import.sshHint': '读取 DSH SSH 插件的主机配置（{file}）；tag 含 ascend/npu 的主机优先。只保存主机别名引用，不保存任何密码或私钥。',
      'envs.import.sshPreview': '浏览 SSH 主机',
      'envs.import.sshUnavailable': 'SSH 主机配置不可用',
      'envs.import.sshNoDraft': '没有可导入的主机（别名无效、重复或已达 16 个上限）',
      'envs.import.sshImport': '导入 {n} 个环境并开始采集',
      'envs.import.capacity': '还可导入 {n} 个（上限 16）',
      'envs.import.viaJson': '粘贴 JSON 导入',
      'envs.import.jsonHint': '粘贴 envs.json 的 envs 数组或整份内容，逐条校验后写入配置文件。',
      'envs.import.jsonPlaceholder': '{"envs":[{"name":"集群A","mode":"ssh","hostAlias":"root@10.0.0.1","npuSmiPath":"npu-smi","timeoutMs":15000}]}',
      'envs.import.jsonImport': '校验并导入',
      'envs.import.errorEntry': '第 {i} 条：{msg}',
      'envs.import.manualDesc': '手动方式：直接编辑 {path}（结构见 README），保存后点「刷新全部」热加载。',
      'envs.import.done': '已导入 {n} 个环境，正在后台采集…',
      'envs.configError.title': '配置读取失败',
      'envs.configError.desc': '{path} 无法读取，请修复后点击「刷新全部」：',
      'envs.tooltip.occWhy': '占用 = 可见进程，或 HBM / AICore 利用率 ≥5%；未知 = 进程与指标均缺失。',
      'envs.tooltip.occChip': '空闲 = 无进程且 HBM/AICore <5%；占用 = 有进程或 ≥5%；未知 = 信号缺失。',
      'envs.refreshAll': '刷新全部',
      'envs.updatedAt': '采集于 {time}',
      'section.device': '设备与环境',
      'section.runs': '运行与对比',
      'section.insights': '洞察',
      'source.local': '本机 npu-smi',
      'source.ssh': 'SSH 只读采集',
      'source.import': '导入记录',
      'source.demo': '演示数据',
      'state.loading': '正在读取设备…',
      'state.loadingDetail': '首次采集可能需要几秒。',
      'state.timeout': '采集超时（15 秒）。',
      'state.timeoutDesc': '命令未在预期时间内返回，可重试或改用导入。',
      'state.noTool': '未找到 npu-smi',
      'state.noToolDesc': '本机未安装昇腾工具，或 PATH 对 DSH 不可见。',
      'device.model': '型号 / 拓扑',
      'device.temp': '芯片温度',
      'device.power': '总功耗',
      'device.aicore': 'AICore 利用率',
      'device.hbm': 'HBM 显存',
      'device.procs': '占用进程',
      'device.showCards': '展开 {n} 卡详情',
      'device.hideCards': '收起卡详情',
      'state.notCollected': '尚未采集设备状态',
      'state.notCollectedDesc': '点击“刷新状态”开始只读采集，或加载演示数据先看界面与计算。',
      'state.noDevice': '未发现 NPU 设备',
      'state.noDeviceDesc': '工具存在但返回的设备列表为空，请确认驱动与容器设备透传。',
      'state.sshFail': 'SSH 只读采集失败',
      'state.sshFailDesc': '请检查 SSH 目标、密钥与远端权限；失败不会修改远端。',
      'state.error': '读取失败',
      'state.emptyRuns': '还没有运行记录',
      'state.emptyRunsDesc': '导入基线（baseline）与候选（candidate）的 benchmark 结果后即可对比。',
      'state.emptyCompare': '请选择基线与候选运行。',
      'state.emptyInsight': '完成一次对比后，将根据指标变化生成带证据的建议。',
      'state.demo': '演示数据，非真机',
      'state.demoDesc': '仅用于验证界面与计算，导出内容带 DEMO 标识。',
      'state.stale': '数据已过期',
      'state.staleDesc': '上次采集于 {time}；重新采集以获得当前状态。',
      'state.missing': '缺失',
      'state.unverified': '未验证导入',
      'state.readonly': '设备与远端只读；导入只写入本机私有仓储。',
      'metric.request_throughput_rps': '请求吞吐',
      'metric.output_throughput_tps': '输出吞吐',
      'metric.total_throughput_tps': '总吞吐',
      'metric.ttft_p50_ms': 'TTFT p50',
      'metric.ttft_p99_ms': 'TTFT p99',
      'metric.tpot_p50_ms': 'TPOT p50',
      'metric.tpot_p99_ms': 'TPOT p99',
      'metric.itl_p50_ms': 'ITL p50',
      'metric.itl_p99_ms': 'ITL p99',
      'metric.success_rate_pct': '成功率',
      'compare.baseline': '基线',
      'compare.candidate': '候选',
      'compare.threshold': '阈值 ±{value}%',
      'compare.conclusion.regressed': '存在性能回归',
      'compare.conclusion.improved': '存在性能改善',
      'compare.conclusion.stable': '主要指标稳定',
      'compare.conclusion.inconclusive': '结论不确定',
      'compare.conclusion.not_comparable': '不可比较',
      'compare.verdict.improved': '改善',
      'compare.verdict.regressed': '回归',
      'compare.verdict.stable': '稳定',
      'compare.verdict.descriptive': '描述性',
      'compare.verdict.missing': '缺失',
      'compare.verdict.zero_baseline': '零基线',
      'compare.matched': '环境与 workload 一致',
      'compare.mismatch': '关键条件不一致，只展示描述性差值，不能据此判定改善/回归',
      'compare.unknown': '关键条件未知，结论为不确定',
      'compare.missingValue': '缺失',
      'compare.counts': '{regressed} 回归 · {improved} 改善 · {stable} 稳定 · {missing} 缺失',
      'insight.empty': '本次对比未触发规则。',
      'insight.skipped': '已跳过规则',
      'insight.evidence': '证据',
      'insight.suggestion': '建议',
      'insight.confidenceObserved': '实测',
      'insight.confidenceHeuristic': '推断',
      'import.title': '导入运行数据',
      'import.privacy': '文件在本机由插件解析，不上传云端；导入会写入 Host 私有仓储。',
      'import.choose': '选择 benchmark JSON / CSV 文件',
      'import.success': '已导入 {label}',
      'import.demoHidden': '当前为演示模式：真实数据已保存，退出演示后可见。',
      'import.deduplicated': '该文件已导入，已复用原记录。',
      'import.tooLarge': '文件超过 1 MiB',
      'import.unsupported': '不支持的格式或版本',
      'import.parseError': '解析失败',
      'import.noValidRows': '没有可用的性能指标',
      'import.invalidArgument': '请求参数不合法',
      'import.paste': '或粘贴 JSON / CSV',
      'import.pasteHint': '可直接粘贴 vllm bench serve 输出、ais_bench summary 或 msprof CSV。',
      'import.file': '选择文件（≤ 1 MiB）',
      'import.submit': '解析并导入',
      'import.needContent': '请选择文件或粘贴内容',
      'error.generation': '操作失败',
      'rule.HBM_PRESSURE.title': 'HBM 使用率偏高',
      'rule.TTFT_REGRESSION.title': '首 token 延迟回归',
      'rule.TPOT_REGRESSION.title': '单 token 延迟回归',
      'rule.CONCURRENCY_SATURATION.title': '并发接近饱和',
      'rule.SUCCESS_LOW.title': '成功率低于 99%',
      'rule.TEMP_HIGH.title': '芯片温度偏高',
      'rule.POWER_CHANGE.title': '功耗显著变化',
      'rule.HOTSPOT_CONCENTRATION.title': '算子热点集中',
      'tune.tab': '性能调优',
      'tune.guide': '用 grid/random 搜索 vLLM 调度参数：先预览计划与预算，再在演示执行器中完整跑通，最后查看推荐与 Pareto。',
      'tune.title': '性能调优',
      'tune.jobsTitle': '调优作业',
      'tune.specTitle': '调优规格',
      'tune.specHint': 'JSON 规格；演示目标只允许 demo 执行器。数值参数会做越界与 128 倍数校验。',
      'tune.preview': '预览计划（dry-run）',
      'tune.start': '启动演示运行',
      'tune.pause': '暂停',
      'tune.resume': '恢复',
      'tune.stop': '停止',
      'tune.report': '刷新报告',
      'tune.executor': '执行器',
      'tune.candidates': '候选 {value} 个',
      'tune.pruned': '剔除 {value} 个',
      'tune.fit': '预算评估：{value}',
      'tune.timeoutUpper': '超时上界 ≤ {value} 秒（非承诺）',
      'tune.blockers': '阻断项',
      'tune.previewTitle': '命令预览（模板化，未执行）',
      'tune.planHash': '计划哈希',
      'tune.jobState': '作业状态：{value}',
      'tune.progress': '已完成 {done}/{total}，成功 {ok}，失败 {bad}',
      'tune.trial': '试次',
      'tune.params': '参数',
      'tune.output': '输出吞吐',
      'tune.ttft': 'TTFT p99',
      'tune.tpot': 'TPOT p99',
      'tune.state': '状态',
      'tune.recommended': '推荐参数',
      'tune.confirmed': '已确认测量',
      'tune.provisional': '临时推荐（未确认）',
      'tune.pareto': 'Pareto 前沿 {value} 个',
      'tune.limitations': '限制与说明',
      'tune.noJob': '还没有调优作业；先预览计划再启动演示运行。',
      'tune.blocked': '该计划存在阻断项，未启动任何执行（共享环境不会被自动启停）。',
      'tune.realDisabled': '真实执行默认关闭；本页只运行 demo 执行器，演示数据零真实副作用。',
      'tune.reportMissing': '暂无报告。',
      'tune.waiting': '等待首个试次…',
      'tune.failed': '失败原因',
      'tune.cleanup': '清理状态：{value}',
      'deploy.seg.envs': '环境信息',
      'deploy.seg.envsShort': '环境',
      'deploy.seg.aria': '视图切换',
      'deploy.seg.tune': '性能调优',
      'deploy.seg.deploy': '服务部署',
      'deploy.seg.tuneShort': '调优',
      'deploy.seg.deployShort': '部署',
      'deploy.title': '服务部署（部署计划）',
      'deploy.readonly': '计划仅是文本：不执行任何步骤（不 git / 不 pip / 不启停服务 / 不跑 benchmark / 不连 NPU）',
      'deploy.envsHint': '目标环境来自 envs.json（在「环境信息」段维护）',
      'deploy.envNone': '没有启用中的环境：先在「环境信息」段添加或启用环境',
      'deploy.envBusy': '环境当前{tier}：仍可生成计划，执行前需确认占用方',
      'deploy.wiz.title': '生成部署计划',
      'deploy.wiz.env': '① 目标环境',
      'deploy.wiz.baseline': '② 基线（对照）',
      'deploy.wiz.component': '代码组件（基线/候选同组件）',
      'deploy.wiz.candidate': '③ 候选（待验证）',
      'deploy.wiz.ref': '分支或 tag',
      'deploy.wiz.commit': 'commit（7–40 位十六进制，留空取 HEAD）',
      'deploy.wiz.model': '④ 模型与启动参数',
      'deploy.wiz.modelPath': '模型绝对路径',
      'deploy.wiz.modelName': '服务名（可选，默认取路径末段）',
      'deploy.wiz.generate': '生成计划',
      'deploy.wiz.generating': '生成中…',
      'deploy.wiz.regenHint': '已有草稿：再次点击确认覆盖',
      'deploy.f.port': '端口 port（1024–65535）',
      'deploy.f.tensorParallel': '张量并行 tensor_parallel（1–8）',
      'deploy.f.maxNumSeqs': '并发 max_num_seqs（1–1024）',
      'deploy.f.maxBatchedTokens': '批量 max_num_batched_tokens（128–131072）',
      'deploy.f.healthTimeout': '健康检查超时 health_timeout_s（5–3600）',
      'deploy.v.env': '请选择目标环境',
      'deploy.v.ref': '分支/tag 不能为空（字母、数字、.、_、-、/）',
      'deploy.v.commit': 'commit 必须是 7–40 位十六进制，或留空',
      'deploy.v.path': '模型路径必须是以 / 开头的绝对路径',
      'deploy.v.port': '端口须为 1024–65535 的整数',
      'deploy.v.tp': 'tensor_parallel 须为 1–8 的整数',
      'deploy.v.seqs': 'max_num_seqs 须为 1–1024',
      'deploy.v.batched': 'max_num_batched_tokens 须为 128–131072',
      'deploy.v.health': 'health_timeout_s 须为 5–3600 的整数',
      'deploy.v.component': '代码组件必须是 vllm / vllm-ascend / lmcache / lmcache-ascend / mooncake',
      'deploy.editor.title': '部署计划',
      'deploy.editor.draft': '草稿（未保存）',
      'deploy.editor.saved': '已保存',
      'deploy.editor.steps': '步骤（{n}）',
      'deploy.editor.save': '保存计划',
      'deploy.editor.saving': '保存中…',
      'deploy.editor.close': '关闭',
      'deploy.editor.savedNotice': '计划已保存：{id}',
      'deploy.step.title': '标题',
      'deploy.step.detail': '说明',
      'deploy.step.command': '命令（文本占位，不会执行）',
      'deploy.step.scope': '归属',
      'deploy.step.up': '上移',
      'deploy.step.down': '下移',
      'deploy.step.del': '删除',
      'deploy.step.add': '新增步骤',
      'deploy.scope.candidate': '候选',
      'deploy.scope.baseline': '基线',
      'deploy.scope.both': '两者',
      'deploy.plans.title': '已保存计划',
      'deploy.plans.empty': '还没有保存的计划：生成后点「保存计划」落盘',
      'deploy.plans.updated': '更新于 {time}',
      'deploy.plans.steps': '{n} 步',
      'deploy.plans.open': '打开',
      'deploy.plans.del': '删除',
      'deploy.plans.delHint': '再次点击确认删除',
      'deploy.plans.deleted': '计划已删除',
      'deploy.state.loading': '正在读取计划…',
      'deploy.state.refresh': '刷新',
      'deploy.state.loadFailed': '计划列表加载失败',
      'deploy.footer': '计划仅是文本，不执行 · 保存于 configDir/plans.json（0600） · 真实执行待后续授权',
    }

    const en = {
      'meta.title': 'Ascend Performance Tuning',
      'panel.title': 'Ascend NPU Monitor',
      'panel.guideDescription': 'Fleet occupancy for Ascend NPUs: environments come from envs.json, npu-smi is read-only, with idle/partial/busy state, processes, and per-card/per-chip detail.',
      'action.refresh': 'Refresh status',
      'action.import': 'Import run',
      'action.loadDemo': 'Load demo data',
      'action.exitDemo': 'Exit demo',
      'action.compare': 'Compare',
      'action.export': 'Export summary',
      'action.copy': 'Copy',
      'action.delete': 'Remove',
      'action.retry': 'Retry',
      'action.cancel': 'Cancel',
      'section.setup': 'Collection target',
      'envs.title': 'Environments',
      'envs.configManaged': 'Environments are managed in a config file',
      'envs.configFile': 'Envs config: {path}',
      'envs.autoEvery': 'Auto-collect every {n} min',
      'envs.autoEveryDefault': 'Auto-collect',
      'envs.modeLocal': 'Local',
      'envs.modeSsh': 'SSH',
      'envs.fallbackName': 'Environment {n}',
      'envs.f.mode': 'Mode',
      'envs.tier.idle': 'Idle',
      'envs.tier.partial': 'Partially occupied',
      'envs.tier.busy': 'Highly occupied',
      'envs.tier.unknown': 'Occupancy unknown',
      'envs.tier.disabled': 'Disabled',
      'envs.tier.count': '{occ}/{total} chips occupied',
      'envs.chipAbnormal': '{k} chips abnormal',
      'envs.procsLabel': 'Occupying processes',
      'envs.procsNone': 'No occupying processes',
      'envs.procsUnavailable': 'Process info unavailable',
      'envs.procsUnavailableByMetrics': 'Process info unavailable (occupancy judged by metrics)',
      'envs.procsMore': '…{n} more processes',
      'envs.chip.idle': 'Idle',
      'envs.chip.occupied': 'Occupied',
      'envs.chip.unknown': 'Unknown',
      'envs.f.name': 'Name',
      'envs.f.hostAlias': 'SSH target (user@host or ~/.ssh alias)',
      'envs.f.npuSmiPath': 'npu-smi path',
      'envs.f.timeoutMs': 'Timeout (ms)',
      'envs.f.enabled': 'Enable auto collection',
      'envs.f.enabledHint': 'Off stops auto collection only; manual refresh still works',
      'envs.config.open': 'Environment config',
      'envs.config.title': 'Environment config',
      'envs.config.poll': 'Collection interval (minutes)',
      'envs.config.add': 'Add environment',
      'envs.config.remove': 'Remove',
      'envs.config.save': 'Save',
      'envs.config.cancel': 'Cancel',
      'envs.config.saved': 'Environment config saved (written to envs.json)',
      'envs.config.limit': 'At most 16 environments',
      'envs.config.err.poll': 'Interval must be 1–60 whole minutes',
      'envs.config.err.nameEmpty': 'Name is required',
      'envs.config.err.nameLong': 'Name must be at most 64 characters',
      'envs.config.err.hostRequired': 'SSH target is required',
      'envs.config.err.hostInvalid': 'Only letters, digits, dot, underscore, colon, @ and hyphen allowed',
      'envs.config.err.hostUserHost': 'Invalid user@host form (letters, digits, dot, underscore, hyphen only)',
      'envs.config.err.pathInvalid': 'Path allows letters, digits, dot, slash, underscore, hyphen only',
      'envs.config.err.timeoutRange': 'Timeout must be an integer in 1000–60000',
      'envs.reload': 'Reload config',
      'envs.reload.done': 'Config reloaded: {n} environment(s)',
      'envs.inlineTitle': 'Metric summary',
      'envs.expandCards': 'Show {n}-card details',
      'envs.collapseCards': 'Hide card details',
      'envs.conn.unreachable': 'Unreachable',
      'envs.conn.commandMissing': 'npu-smi missing',
      'envs.conn.noDevice': 'No NPU detected',
      'envs.conn.pending': 'Not collected',
      'envs.conn.stale': 'Stale data',
      'envs.conn.collecting': 'Collecting',
      'envs.conn.flap': 'Connection flap · last {time}',
      'envs.firstCollect': 'First collection starts within seconds, or press "Refresh".',
      'envs.staleHint': 'Last successful collection is old; occupancy view may be outdated.',
      'envs.disabledHint': 'Disabling only stops auto-collection; manual refresh still works.',
      'envs.import.title': 'No environments configured',
      'envs.import.desc': 'Import below, or edit the config file directly (0600): {path}',
      'envs.import.viaSsh': 'Import from SSH hosts',
      'envs.import.sshHint': 'Reads the DSH SSH plugin host config ({file}); hosts tagged ascend/npu first. Only host aliases are stored — never passwords or keys.',
      'envs.import.sshPreview': 'Browse SSH hosts',
      'envs.import.sshUnavailable': 'SSH host config unavailable',
      'envs.import.sshNoDraft': 'No importable hosts (invalid/duplicate alias, or the 16-env limit)',
      'envs.import.sshImport': 'Import {n} environments & start collecting',
      'envs.import.capacity': '{n} more allowed (max 16)',
      'envs.import.viaJson': 'Paste JSON',
      'envs.import.jsonHint': 'Paste the envs array or a full envs.json; entries are validated one by one before writing.',
      'envs.import.jsonPlaceholder': '{"envs":[{"name":"Cluster A","mode":"ssh","hostAlias":"root@10.0.0.1","npuSmiPath":"npu-smi","timeoutMs":15000}]}',
      'envs.import.jsonImport': 'Validate & import',
      'envs.import.errorEntry': 'Entry {i}: {msg}',
      'envs.import.manualDesc': 'Manual: edit {path} directly (see README), then press "Refresh all" to hot-reload.',
      'envs.import.done': 'Imported {n} environments; collecting in the background…',
      'envs.configError.title': 'Config read failed',
      'envs.configError.desc': '{path} cannot be read; fix it and press "Refresh all":',
      'envs.tooltip.occWhy': 'Occupied = visible processes, or HBM / AI Core utilization ≥5%; unknown = both processes and metrics missing.',
      'envs.tooltip.occChip': 'Idle = no processes and HBM/AICore <5%; occupied = processes present or ≥5%; unknown = signals missing.',
      'envs.refreshAll': 'Refresh all',
      'envs.updatedAt': 'Collected at {time}',
      'section.device': 'Devices & environment',
      'section.runs': 'Runs & comparison',
      'section.insights': 'Insights',
      'source.local': 'Local npu-smi',
      'source.ssh': 'SSH read-only',
      'source.import': 'Imported',
      'source.demo': 'Demo data',
      'state.loading': 'Reading devices…',
      'state.loadingDetail': 'The first collection may take a few seconds.',
      'state.timeout': 'Collection timed out (15 s).',
      'state.timeoutDesc': 'The command did not return in time; retry or use imports.',
      'state.noTool': 'npu-smi not found',
      'state.noToolDesc': 'Ascend tooling is not installed, or PATH is not visible to DSH.',
      'device.model': 'Model / topology',
      'device.temp': 'Chip temperature',
      'device.power': 'Total power',
      'device.aicore': 'AI Core utilization',
      'device.hbm': 'HBM memory',
      'device.procs': 'Active processes',
      'device.showCards': 'Show {n}-card details',
      'device.hideCards': 'Hide card details',
      'state.notCollected': 'Device state not collected yet',
      'state.notCollectedDesc': 'Click Refresh to run a read-only collection, or load demo data to inspect the panel.',
      'state.noDevice': 'No NPU device found',
      'state.noDeviceDesc': 'The tool exists but returned no devices; check the driver and passthrough.',
      'state.sshFail': 'SSH read-only collection failed',
      'state.sshFailDesc': 'Check the SSH target, key, and remote permissions; nothing is modified remotely.',
      'state.error': 'Read failed',
      'state.emptyRuns': 'No runs yet',
      'state.emptyRunsDesc': 'Import baseline and candidate benchmark results to compare.',
      'state.emptyCompare': 'Select a baseline and a candidate run.',
      'state.emptyInsight': 'Run a comparison to get evidence-backed suggestions from metric changes.',
      'state.demo': 'Demo data, not a real device',
      'state.demoDesc': 'For UI and calculation validation only; exports carry a DEMO marker.',
      'state.stale': 'Data is stale',
      'state.staleDesc': 'Last collected at {time}; refresh for the current state.',
      'state.missing': 'missing',
      'state.unverified': 'unverified import',
      'state.readonly': 'Devices and remotes are read-only; imports write only to the local private store.',
      'metric.request_throughput_rps': 'Request throughput',
      'metric.output_throughput_tps': 'Output throughput',
      'metric.total_throughput_tps': 'Total throughput',
      'metric.ttft_p50_ms': 'TTFT p50',
      'metric.ttft_p99_ms': 'TTFT p99',
      'metric.tpot_p50_ms': 'TPOT p50',
      'metric.tpot_p99_ms': 'TPOT p99',
      'metric.itl_p50_ms': 'ITL p50',
      'metric.itl_p99_ms': 'ITL p99',
      'metric.success_rate_pct': 'Success rate',
      'compare.baseline': 'Baseline',
      'compare.candidate': 'Candidate',
      'compare.threshold': 'Threshold ±{value}%',
      'compare.conclusion.regressed': 'Performance regression',
      'compare.conclusion.improved': 'Performance improvement',
      'compare.conclusion.stable': 'Primary metrics stable',
      'compare.conclusion.inconclusive': 'Inconclusive',
      'compare.conclusion.not_comparable': 'Not comparable',
      'compare.verdict.improved': 'improved',
      'compare.verdict.regressed': 'regressed',
      'compare.verdict.stable': 'stable',
      'compare.verdict.descriptive': 'descriptive',
      'compare.verdict.missing': 'missing',
      'compare.verdict.zero_baseline': 'zero baseline',
      'compare.matched': 'Environment and workload match',
      'compare.mismatch': 'Key conditions differ; only descriptive deltas are shown',
      'compare.unknown': 'Key conditions unknown; conclusion is inconclusive',
      'compare.missingValue': 'missing',
      'compare.counts': '{regressed} regressed · {improved} improved · {stable} stable · {missing} missing',
      'insight.empty': 'No rule fired for this comparison.',
      'insight.skipped': 'Skipped rules',
      'insight.evidence': 'Evidence',
      'insight.suggestion': 'Suggestion',
      'insight.confidenceObserved': 'observed',
      'insight.confidenceHeuristic': 'heuristic',
      'import.title': 'Import run data',
      'import.privacy': 'The file is parsed locally by the plugin and never uploaded; imports write to the Host private store.',
      'import.choose': 'Choose a benchmark JSON / CSV file',
      'import.success': 'Imported {label}',
      'import.demoHidden': 'Demo mode is on: the real data was saved and will appear after you exit demo.',
      'import.deduplicated': 'This file was already imported; the existing record is reused.',
      'import.tooLarge': 'File exceeds 1 MiB',
      'import.unsupported': 'Unsupported format or version',
      'import.parseError': 'Parse failed',
      'import.noValidRows': 'No usable performance metrics',
      'import.invalidArgument': 'Invalid request arguments',
      'import.paste': 'Or paste JSON / CSV',
      'import.pasteHint': 'Paste vllm bench serve output, an ais_bench summary, or msprof CSV.',
      'import.file': 'Choose a file (≤ 1 MiB)',
      'import.submit': 'Parse and import',
      'import.needContent': 'Choose a file or paste content',
      'error.generation': 'Operation failed',
      'rule.HBM_PRESSURE.title': 'High HBM usage',
      'rule.TTFT_REGRESSION.title': 'TTFT regression',
      'rule.TPOT_REGRESSION.title': 'TPOT regression',
      'rule.CONCURRENCY_SATURATION.title': 'Concurrency saturation',
      'rule.SUCCESS_LOW.title': 'Success rate below 99%',
      'rule.TEMP_HIGH.title': 'High chip temperature',
      'rule.POWER_CHANGE.title': 'Significant power change',
      'rule.HOTSPOT_CONCENTRATION.title': 'Concentrated operator hotspot',
      'tune.tab': 'Tuning',
      'tune.guide': 'Search vLLM scheduling parameters with grid/random: preview the plan and budget, run end-to-end in the demo executor, then inspect the recommendation and Pareto front.',
      'tune.title': 'Performance tuning',
      'tune.jobsTitle': 'Tuning jobs',
      'tune.specTitle': 'Tuning spec',
      'tune.specHint': 'JSON spec; the demo target only accepts the demo executor. Numeric values are range- and 128-multiple validated.',
      'tune.preview': 'Preview plan (dry-run)',
      'tune.start': 'Start demo run',
      'tune.pause': 'Pause',
      'tune.resume': 'Resume',
      'tune.stop': 'Stop',
      'tune.report': 'Refresh report',
      'tune.executor': 'Executor',
      'tune.candidates': '{value} candidates',
      'tune.pruned': '{value} pruned',
      'tune.fit': 'Budget: {value}',
      'tune.timeoutUpper': 'Timeout upper bound ≤ {value}s (not a promise)',
      'tune.blockers': 'Blockers',
      'tune.previewTitle': 'Command preview (templated, not executed)',
      'tune.planHash': 'Plan hash',
      'tune.jobState': 'Job state: {value}',
      'tune.progress': 'Done {done}/{total}, succeeded {ok}, failed {bad}',
      'tune.trial': 'Trial',
      'tune.params': 'Params',
      'tune.output': 'Output tps',
      'tune.ttft': 'TTFT p99',
      'tune.tpot': 'TPOT p99',
      'tune.state': 'State',
      'tune.recommended': 'Recommended parameters',
      'tune.confirmed': 'Confirmed measurement',
      'tune.provisional': 'Provisional (unconfirmed)',
      'tune.pareto': '{value} Pareto points',
      'tune.limitations': 'Limitations',
      'tune.noJob': 'No tuning job yet; preview a plan, then start a demo run.',
      'tune.blocked': 'This plan has blockers and started nothing (shared environments are never auto-started).',
      'tune.realDisabled': 'Real execution is disabled by default; this page runs the demo executor with zero real side effects.',
      'tune.reportMissing': 'No report yet.',
      'tune.waiting': 'Waiting for the first trial…',
      'tune.failed': 'Failure',
      'tune.cleanup': 'Cleanup: {value}',
      'deploy.seg.envs': 'Environments',
      'deploy.seg.envsShort': 'Env',
      'deploy.seg.aria': 'View switcher',
      'deploy.seg.tune': 'Tuning',
      'deploy.seg.deploy': 'Deployments',
      'deploy.seg.tuneShort': 'Tune',
      'deploy.seg.deployShort': 'Deploy',
      'deploy.title': 'Service deployment (plans)',
      'deploy.readonly': 'Plans are text only: no step is executed (no git, no pip, no service start/stop, no benchmarks, no NPU access)',
      'deploy.envsHint': 'Target environments come from envs.json (managed in the Environments view)',
      'deploy.envNone': 'No enabled environment: add or enable one in the Environments view first',
      'deploy.envBusy': 'Environment is currently {tier}: you can still generate a plan; confirm occupants before executing',
      'deploy.wiz.title': 'Generate deployment plan',
      'deploy.wiz.env': '① Target environment',
      'deploy.wiz.baseline': '② Baseline (reference)',
      'deploy.wiz.component': 'Code component (shared by baseline & candidate)',
      'deploy.wiz.candidate': '③ Candidate (under test)',
      'deploy.wiz.ref': 'branch or tag',
      'deploy.wiz.commit': 'commit (7–40 hex chars, empty = HEAD)',
      'deploy.wiz.model': '④ Model & launch params',
      'deploy.wiz.modelPath': 'absolute model path',
      'deploy.wiz.modelName': 'served name (optional, defaults to last path segment)',
      'deploy.wiz.generate': 'Generate plan',
      'deploy.wiz.generating': 'Generating…',
      'deploy.wiz.regenHint': 'A draft exists: click again to confirm overwriting',
      'deploy.f.port': 'port (1024–65535)',
      'deploy.f.tensorParallel': 'tensor_parallel (1–8)',
      'deploy.f.maxNumSeqs': 'max_num_seqs (1–1024)',
      'deploy.f.maxBatchedTokens': 'max_num_batched_tokens (128–131072)',
      'deploy.f.healthTimeout': 'health timeout health_timeout_s (5–3600)',
      'deploy.v.env': 'Select a target environment',
      'deploy.v.ref': 'branch/tag is required (letters, digits, ., _, -, /)',
      'deploy.v.commit': 'commit must be 7–40 hex chars, or empty',
      'deploy.v.path': 'model path must be an absolute path starting with /',
      'deploy.v.port': 'port must be an integer in 1024–65535',
      'deploy.v.tp': 'tensor_parallel must be an integer 1–8',
      'deploy.v.seqs': 'max_num_seqs must be 1–1024',
      'deploy.v.batched': 'max_num_batched_tokens must be 128–131072',
      'deploy.v.health': 'health_timeout_s must be an integer 5–3600',
      'deploy.v.component': 'Component must be one of vllm / vllm-ascend / lmcache / lmcache-ascend / mooncake',
      'deploy.editor.title': 'Deployment plan',
      'deploy.editor.draft': 'Draft (unsaved)',
      'deploy.editor.saved': 'Saved',
      'deploy.editor.steps': 'Steps ({n})',
      'deploy.editor.save': 'Save plan',
      'deploy.editor.saving': 'Saving…',
      'deploy.editor.close': 'Close',
      'deploy.editor.savedNotice': 'Plan saved: {id}',
      'deploy.step.title': 'Title',
      'deploy.step.detail': 'Detail',
      'deploy.step.command': 'Command (text placeholder, never executed)',
      'deploy.step.scope': 'Scope',
      'deploy.step.up': 'Move up',
      'deploy.step.down': 'Move down',
      'deploy.step.del': 'Delete',
      'deploy.step.add': 'Add step',
      'deploy.scope.candidate': 'Candidate',
      'deploy.scope.baseline': 'Baseline',
      'deploy.scope.both': 'Both',
      'deploy.plans.title': 'Saved plans',
      'deploy.plans.empty': 'No saved plans yet: generate one and click Save plan',
      'deploy.plans.updated': 'Updated {time}',
      'deploy.plans.steps': '{n} steps',
      'deploy.plans.open': 'Open',
      'deploy.plans.del': 'Delete',
      'deploy.plans.delHint': 'Click again to confirm deletion',
      'deploy.plans.deleted': 'Plan deleted',
      'deploy.state.loading': 'Loading plans…',
      'deploy.state.refresh': 'Refresh',
      'deploy.state.loadFailed': 'Failed to load plans',
      'deploy.footer': 'Plans are text, never executed · stored at configDir/plans.json (0600) · real execution awaits future authorization',
    }

    /* ------------------------------ styles ------------------------------ */

    const c = {
      text: 'var(--dsw-alias-label-primary, #16202e)',
      textSecondary: 'var(--dsw-alias-label-secondary, #475569)',
      textTertiary: 'var(--dsw-alias-label-tertiary, #6b7a8c)',
      border: 'var(--dsw-alias-border-l2, #d5dee9)',
      borderSoft: 'var(--dsw-alias-border-l1, #e3e9f1)',
      layer1: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      layer2: 'var(--dsw-alias-bg-layer-2, #f4f7fb)',
      layer3: '#e7edf5',
      brand: 'var(--dsw-alias-brand-primary, #0284c7)',
      success: 'var(--dsw-alias-state-success-primary, #059669)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      error: 'var(--dsw-alias-state-error-primary, #dc2626)',
      info: '#0891b2',
      hover: 'var(--dsw-alias-interactive-bg-hover, #f4f7fb)',
      shadow: '0 8px 24px -14px rgba(15,40,80,.28)',
      mono: "var(--dsw-alias-mono-font-family, 'JetBrains Mono', 'Cascadia Code', Consolas, monospace)",
    }

    const s = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '12px', color: c.text, fontSize: '13px', lineHeight: 1.5, height: '100%', maxHeight: '100%', minHeight: 0, boxSizing: 'border-box', overflowY: 'auto', overscrollBehavior: 'contain', backgroundImage: 'radial-gradient(circle at 12% -4%, rgba(2,132,199,.05), transparent 42%), radial-gradient(circle at 96% 8%, rgba(8,145,178,.04), transparent 38%)', backgroundSize: '100% 100%, 100% 100%', backgroundRepeat: 'no-repeat' },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      title: { fontSize: '15px', fontWeight: 600 },
      section: { border: `1px solid ${c.borderSoft}`, borderRadius: '12px', padding: '10px', background: c.layer1, display: 'flex', flexDirection: 'column', gap: '10px' },
      sectionTitle: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', fontWeight: 600, color: c.textSecondary, letterSpacing: '0.02em' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      button: { border: `1px solid ${c.border}`, background: c.layer2, color: c.text, borderRadius: '8px', padding: '5px 10px', fontSize: '12px', cursor: 'pointer' },
      buttonPrimary: { border: `1px solid ${c.brand}`, background: c.brand, color: '#fff', borderRadius: '8px', padding: '5px 10px', fontSize: '12px', cursor: 'pointer' },
      buttonGhost: { border: 'none', background: 'transparent', color: c.textSecondary, padding: '2px 4px', fontSize: '12px', cursor: 'pointer' },
      muted: { color: c.textTertiary, fontSize: '12px' },
      card: { border: `1px solid ${c.borderSoft}`, borderRadius: '12px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px', background: c.layer1, boxShadow: c.shadow },
      chipGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: '6px' },
      chip: { border: `1px solid ${c.borderSoft}`, borderRadius: '8px', padding: '6px', background: c.layer1, fontSize: '12px' },
      pill: { display: 'inline-flex', alignItems: 'center', gap: '4px', borderRadius: '999px', padding: '1px 8px', fontSize: '11px', border: `1px solid ${c.border}` },
      tag: { display: 'inline-flex', alignItems: 'center', gap: '4px', borderRadius: '6px', padding: '1px 6px', fontSize: '10.5px', background: c.layer3, color: c.textSecondary, whiteSpace: 'nowrap' },
      num: { fontFamily: c.mono, fontVariantNumeric: 'tabular-nums' },
      notice: { borderRadius: '8px', padding: '8px 10px', fontSize: '12px', border: `1px solid ${c.border}`, background: c.layer2, color: c.textSecondary },
      demoBanner: { borderRadius: '8px', padding: '6px 10px', fontSize: '12px', border: `1px dashed ${c.warn}`, color: c.warn },
      table: { display: 'flex', flexDirection: 'column', gap: '2px' },
      tr: { display: 'grid', gridTemplateColumns: '1.4fr 0.8fr 0.8fr 0.8fr', gap: '6px', alignItems: 'center', padding: '3px 0', borderBottom: `1px solid ${c.borderSoft}`, fontSize: '12px' },
      th: { color: c.textTertiary, fontSize: '11px' },
      select: { border: `1px solid ${c.border}`, borderRadius: '6px', padding: '4px 6px', background: c.layer1, color: c.text, fontSize: '12px', maxWidth: '100%' },
      inputText: { border: `1px solid ${c.border}`, borderRadius: '6px', padding: '5px 7px', background: c.layer1, color: c.text, fontSize: '12px', minWidth: 0, width: '100%', boxSizing: 'border-box' },
      textarea: { border: `1px solid ${c.border}`, borderRadius: '6px', padding: '6px 7px', background: c.layer1, color: c.text, fontSize: '12px', minHeight: '84px', resize: 'vertical', width: '100%', boxSizing: 'border-box', fontFamily: 'var(--dsw-alias-mono-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)' },
      fileInput: { fontSize: '12px', color: c.textSecondary, maxWidth: '100%' },
      field: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12px' },
      input: { display: 'none' },
      insight: { border: `1px solid ${c.borderSoft}`, borderLeft: `3px solid ${c.brand}`, borderRadius: '8px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', background: c.layer1 },
      code: { fontFamily: 'var(--dsw-alias-mono-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: '11px', color: c.textSecondary, wordBreak: 'break-all' },
      skeleton: { height: '12px', borderRadius: '6px', background: c.layer2 },
      footer: { color: c.textTertiary, fontSize: '11px', lineHeight: 1.4 },
    }

    /* ------------------------------ api ------------------------------ */

    async function apiGet(path) {
      const res = await fetch(`${API}${path}`, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' })
      const json = await readJson(res)
      if (!res.ok) throw withCode(json ?? { error: { code: `HTTP_${res.status}`, message: `HTTP ${res.status}` } })
      return json
    }

    async function apiPost(path, body) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body ?? {}),
      })
      const json = await readJson(res)
      if (!res.ok) throw withCode(json ?? { error: { code: `HTTP_${res.status}`, message: `HTTP ${res.status}` } })
      return json
    }

    async function apiPut(path, body) {
      const res = await fetch(`${API}${path}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body ?? {}),
      })
      const json = await readJson(res)
      if (!res.ok) throw withCode(json ?? { error: { code: `HTTP_${res.status}`, message: `HTTP ${res.status}` } })
      return json
    }

    async function apiDelete(path) {
      const res = await fetch(`${API}${path}`, { method: 'DELETE', headers: { accept: 'application/json' }, credentials: 'same-origin' })
      const json = await readJson(res)
      if (!res.ok) throw withCode(json ?? { error: { code: `HTTP_${res.status}`, message: `HTTP ${res.status}` } })
      return json
    }

    async function readJson(res) {
      // 401 等失败响应可能带空 body：解析失败时返回 null，由调用方补 HTTP_xxx 错误码。
      try { return await res.json() } catch { return null }
    }

    function withCode(payload) {
      const error = new Error(payload?.error?.message ?? 'request failed')
      error.code = payload?.error?.code ?? 'REQUEST_FAILED'
      error.payload = payload
      return error
    }

    const metricOrder = [
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

    function fmt(value, digits = 1) {
      if (value === null || value === undefined || Number.isNaN(value)) return null
      return String(Math.round(value * 10 ** digits) / 10 ** digits)
    }

    function timeText(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      return d.toLocaleString()
    }

    function verdictColor(verdict) {
      if (verdict === 'regressed') return c.error
      if (verdict === 'improved') return c.success
      if (verdict === 'missing' || verdict === 'zero_baseline' || verdict === 'descriptive') return c.textTertiary
      return c.textSecondary
    }

    /* ------------------------------ components ------------------------------ */

    function Pill({ children, tone }) {
      const color = tone === 'warn' ? c.warn : tone === 'error' ? c.error : tone === 'success' ? c.success : c.textSecondary
      return h('span', { style: { ...s.pill, color, borderColor: color } }, children)
    }

    function Section({ title, extra, children }) {
      return h('section', { style: s.section }, h('div', { style: s.sectionTitle }, h('span', null, title), extra ?? null), children)
    }

    function Empty({ title, desc, action }) {
      return h(
        'div',
        { style: { ...s.card, alignItems: 'flex-start' } },
        h('div', { style: { fontWeight: 600 } }, title),
        desc ? h('div', { style: s.muted }, desc) : null,
        action ?? null,
      )
    }

    function StateMsg({ title, desc, tone = 'muted' }) {
      const color = tone === 'error' ? c.error : tone === 'warn' ? c.warn : c.textSecondary
      return h('div', { style: { ...s.notice, color } }, h('div', { style: { fontWeight: 600 } }, title), desc ? h('div', { style: { marginTop: '2px' } }, desc) : null)
    }

    function SourceBar({ source, demo, t }) {
      const mode = demo ? 'demo' : source?.mode ?? 'local'
      return h(
        'div',
        { style: { ...s.row, justifyContent: 'space-between' } },
        h('span', { style: s.muted }, t(`source.${mode}`)),
        h('span', { style: s.muted }, source?.collected_at ? timeText(source.collected_at) : ''),
      )
    }

    /* ------------------------------ 占用视图组件（v1.2） ------------------------------ */

    // chip 级占用判定：与 Host 端 chipOccupancyState 同规则（§14.3 + t18 修正）
    // none_reported（npu-smi 正常、进程列表为空）+ 低指标 → 空闲；仅 processes_state='unknown'（解析异常）→ 未知。
    function chipOccState(chip) {
      if (!chip) return 'unknown'
      const procs = Array.isArray(chip.processes) ? chip.processes : []
      if (chip.processes_state === 'observed' && procs.length > 0) return 'occupied'
      let hbmRate = null
      if (typeof chip.hbm_usage_rate_pct === 'number') hbmRate = chip.hbm_usage_rate_pct
      else if (typeof chip.hbm_used_mb === 'number' && typeof chip.hbm_total_mb === 'number' && chip.hbm_total_mb > 0) hbmRate = (chip.hbm_used_mb / chip.hbm_total_mb) * 100
      if (hbmRate !== null && hbmRate >= 5) return 'occupied'
      if (typeof chip.aicore_pct === 'number' && chip.aicore_pct >= 5) return 'occupied'
      if (chip.processes_state === 'unknown') return 'unknown'
      return 'idle'
    }

    // 环境级占用汇总：total=占用+空闲（未知不计入分母）；档位 + 占用进程聚合 Top3
    // t29 v1.5：卡编号按型号——快照含 910C → 1..16；含 910B → 1..8；其他按实际卡数 1..N。
    // 展示编号一律 card_id+1（npu-smi 卡号 0 基）；型号只决定“应有卡数”（图例与校对用）。
    function cardNumbering(cards) {
      const list = cards ?? []
      const family = list.some((card) => /910C/i.test(String(card?.model ?? ''))) ? '910C'
        : list.some((card) => /910B/i.test(String(card?.model ?? ''))) ? '910B'
          : 'other'
      const expected = family === '910C' ? 16 : family === '910B' ? 8 : list.length
      return { family, expected }
    }

    function deriveEnvOccupancy(cards) {
      const chips = []
      const procs = new Map()
      const cardAggs = []
      let occupied = 0
      let idle = 0
      let unknown = 0
      for (const card of cards ?? []) {
        let cardOccupied = 0
        let cardUnknown = 0
        const nums = (pick) => (card.chips ?? []).map(pick).filter((v) => typeof v === 'number' && Number.isFinite(v))
        const tempMax = nums((ch) => ch.temp_c)
        const aicoreMax = nums((ch) => ch.aicore_pct)
        const hbmRateMax = nums((ch) => ch.hbm_usage_rate_pct ?? ch.hbm_reported_usage_rate_pct)
        for (const chip of card.chips ?? []) {
          const state = chipOccState(chip)
          chips.push({ card_id: card.card_id, chip_id: chip.chip_id, state, health: chip.health })
          if (state === 'occupied') {
            occupied += 1
            cardOccupied += 1
            for (const proc of chip.processes ?? []) {
              const key = proc?.name || String(proc?.pid)
              const cur = procs.get(key) ?? { name: key, count: 0, memory_mb_sum: 0 }
              cur.count += 1
              cur.memory_mb_sum += typeof proc?.memory_mb === 'number' ? proc.memory_mb : 0
              procs.set(key, cur)
            }
          } else if (state === 'idle') idle += 1
          else {
            unknown += 1
            cardUnknown += 1
          }
        }
        const chipCount = (card.chips ?? []).length
        cardAggs.push({
          card_id: card.card_id,
          number: (typeof card.card_id === 'number' ? card.card_id : 0) + 1,
          state: cardOccupied > 0 ? 'occupied' : cardUnknown > 0 ? 'unknown' : 'idle',
          occupied: cardOccupied,
          unknown: cardUnknown,
          chipCount,
          tempMax: tempMax.length > 0 ? Math.max(...tempMax) : null,
          powerSum: nums((ch) => ch.power_w).reduce((a, b) => a + b, 0) || null,
          aicoreMax: aicoreMax.length > 0 ? Math.max(...aicoreMax) : null,
          hbmRateMax: hbmRateMax.length > 0 ? Math.max(...hbmRateMax) : null,
        })
      }
      const total = occupied + idle
      let tier = 'unknown'
      if (total >= 1) {
        const need = total < 4 ? total : Math.ceil(0.75 * total)
        tier = occupied === 0 ? 'idle' : occupied >= need ? 'busy' : 'partial'
      }
      return {
        tier,
        occupied,
        idle,
        unknown,
        total,
        chips,
        cards: cardAggs,
        numbering: cardNumbering(cards),
        criticalCount: chips.filter((ch) => ch.health === 'critical').length,
        topProcesses: [...procs.values()].sort((a, b) => b.count - a.count || b.memory_mb_sum - a.memory_mb_sum).slice(0, 3),
      }
    }

    const OCC_TIER_COLOR = { idle: c.success, partial: c.warn, busy: c.warn, unknown: c.textTertiary, disabled: c.textTertiary }

    // 8px 状态点：空闲绿 / 占用琥珀 / 未知灰
    function UDot({ tone }) {
      const color = tone === 'idle' ? c.success : tone === 'occupied' || tone === 'busy' ? c.warn : tone === 'partial' ? c.warn : tone === 'error' ? c.error : tone === 'info' ? c.info : c.textTertiary
      return h('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '999px', background: color, flex: '0 0 auto' }, 'aria-hidden': 'true' })
    }

    // 主视觉徽标：点 + 档位文字 + {occ}/{total}
    function OccupancyPill({ tier, occupied, total, label, ariaLabel, testid }) {
      const color = OCC_TIER_COLOR[tier] ?? c.textTertiary
      return h(
        'span',
        {
          style: { ...s.pill, borderColor: color, color, background: 'transparent', fontWeight: 600 },
          'data-testid': testid,
          'aria-label': ariaLabel,
          title: ariaLabel,
        },
        h(UDot, { tone: tier }),
        label,
        Number.isFinite(occupied) && Number.isFinite(total) ? h('span', { style: { ...s.num, fontWeight: 500 } }, `${occupied}/${total}`) : null,
      )
    }

    // 连接态：次要描边角标
    function ConnBadge({ label, tone, testid }) {
      const color = tone === 'error' ? c.error : tone === 'warn' ? c.warn : c.textTertiary
      return h('span', { style: { ...s.pill, borderColor: color, color, background: 'transparent', fontSize: '10px', padding: '0 6px', fontWeight: 500 }, 'data-testid': testid, title: label }, label)
    }

    // 一行配置提示：环境在配置文件中管理 · 每 N 分钟自动采集 · 路径（点击复制）
    // + 「环境配置」弹窗编辑器（主入口，t44）与「重新加载配置」次级兜底（只读 envs.json + 全量采集）。
    function ConfigBar({ config, t, onOpenConfig, onReload, busy }) {
      const path = config?.configFile ?? null
      const minutes = Math.max(1, Math.round((config?.pollIntervalMs ?? 300000) / 60000))
      const short = path && path.length > 48 ? `${path.slice(0, 22)}…${path.slice(-22)}` : path
      return h(
        'div',
        { style: { ...s.row, gap: '6px', fontSize: '11.5px', color: c.textTertiary, flexWrap: 'wrap' }, 'data-testid': 'envs.configbar' },
        h(UDot, { tone: 'info' }),
        h('span', null, t('envs.configManaged'), ' · ', t('envs.autoEvery', { n: minutes })),
        path
          ? h('button', {
              type: 'button',
              style: { ...s.tag, fontFamily: c.mono, border: 'none', cursor: 'copy' },
              title: t('envs.configFile', { path }),
              onClick: () => { try { navigator.clipboard?.writeText(path) } catch { /* 复制失败忽略 */ } },
            }, short)
          : null,
        h('div', { style: { flex: 1 } }),
        typeof onOpenConfig === 'function'
          ? h('button', { type: 'button', style: { ...s.button, fontSize: '11.5px', padding: '2px 10px' }, onClick: onOpenConfig, disabled: busy, 'data-testid': 'envs.configbar.edit' }, t('envs.config.open'))
          : null,
        typeof onReload === 'function'
          ? h('button', { type: 'button', style: { ...s.buttonGhost, fontSize: '11.5px', padding: '2px 10px' }, onClick: onReload, disabled: busy, title: t('envs.reload'), 'data-testid': 'envs.configbar.reload' }, busy ? '…' : t('envs.reload'))
          : null,
      )
    }

    // 占用进程聚合行（表格化：名称 ×count Σ GiB，mono 数字）
    function OccProcRow({ occ, t, testid }) {
      const giB = (mb) => `${fmt(Math.round((mb / 1024) * 10) / 10)} GiB`
      const rows = occ.topProcesses.map((p) => ({
        name: p.name,
        count: p.count,
        mem: p.memory_mb_sum > 0 ? giB(p.memory_mb_sum) : null,
      }))
      // t19：空闲环境（无可见占用进程）不再渲染「无占用进程」占位行，卡更紧凑
      if (rows.length === 0 && occ.tier === 'idle') return null
      const fallback = occ.tier === 'idle'
        ? t('envs.procsNone')
        : occ.tier === 'unknown' ? t('envs.procsUnavailable') : t('envs.procsUnavailableByMetrics')
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '2px', whiteSpace: 'nowrap', overflow: 'hidden' }, 'data-testid': testid },
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', alignItems: 'center', fontSize: '11.5px' } },
          h('span', { style: s.muted }, `${t('envs.procsLabel')}`),
          h('span', { style: { ...s.muted, ...s.num, textAlign: 'right' } }, '×'),
          h('span', { style: { ...s.muted, ...s.num, textAlign: 'right' } }, 'Σ GiB'),
        ),
        rows.length
          ? rows.map((row) => h(
              'div',
              { key: row.name, style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', alignItems: 'center', fontSize: '12px', padding: '2px 4px', borderRadius: '6px' } },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 500 } }, row.name),
              h('span', { style: { ...s.num, color: c.warn, textAlign: 'right' } }, `×${row.count}`),
              h('span', { style: { ...s.num, color: c.textSecondary, textAlign: 'right' } }, row.mem ?? '—'),
            ))
          : h('div', { style: { ...s.muted, fontSize: '12px', padding: '2px 4px' } }, fallback),
      )
    }

    // 环境指标摘要：型号卡数 / 温度区间 / 功耗 / AICore 区间 / HBM used/total+占比
    function EnvMetricSummary({ cards, t }) {
      const a = aggChips(cards)
      if (a.chipCount === 0) return null
      const giB = (mb) => fmt(Math.round((mb / 1024) * 10) / 10)
      const cell = (label, value, tone) => h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: '6px', background: c.layer2, borderRadius: '8px', padding: '4px 8px' } },
        h('span', { style: s.muted }, label),
        h('span', { style: { ...s.num, color: tone === 'hot' ? c.warn : tone === 'crit' ? c.error : c.text } }, value),
      )
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
        cell(t('device.model'), `${a.models.length ? a.models.join(' / ') : '—'} · ${cards.length} 卡 / ${a.chipCount} chip`),
        a.tempRange !== null ? cell(t('device.temp'), `${a.tempRange} °C`, Number(String(a.tempRange).split('–').pop()) >= 80 ? 'crit' : Number(String(a.tempRange).split('–').pop()) >= 70 ? 'hot' : undefined) : null,
        a.powerSum !== null ? cell(t('device.power'), `≈ ${fmt(Math.round(a.powerSum))} W`) : null,
        a.aicoreRange !== null ? cell(t('device.aicore'), `${a.aicoreRange} %`, a.aicoreMax >= 90 ? 'hot' : undefined) : null,
        a.hbmUsedSum !== null && a.hbmTotalSum ? cell(t('device.hbm'), `${giB(a.hbmUsedSum)} / ${giB(a.hbmTotalSum)} GiB${a.hbmRateRange !== null ? `（${a.hbmRateRange}%）` : ''}`, a.hbmRateMax !== null && a.hbmRateMax >= 90 ? 'crit' : a.hbmRateMax !== null && a.hbmRateMax >= 75 ? 'hot' : undefined) : null,
      )
    }

    // t19：默认视图的一行内联摘要（型号 · chip 数 · 温度 · 功耗 · HBM），缺项跳过，单行 ellipsis
    function EnvInlineSummary({ cards, t, testid }) {
      const a = aggChips(cards)
      if (a.chipCount === 0) return null
      const giB = (mb) => fmt(Math.round((mb / 1024) * 10) / 10)
      const parts = []
      if (a.models.length) parts.push(a.models.join(' / '))
      parts.push(`${a.chipCount} chip`)
      if (a.tempRange !== null) parts.push(`${a.tempRange} °C`)
      if (a.powerSum !== null) parts.push(a.powerSum >= 1000 ? `≈${fmt(Math.round((a.powerSum / 1000) * 10) / 10)} kW` : `≈${fmt(Math.round(a.powerSum))} W`)
      if (a.hbmUsedSum !== null && a.hbmTotalSum) parts.push(`HBM ${giB(a.hbmUsedSum)}/${giB(a.hbmTotalSum)} GiB（${Math.round((a.hbmUsedSum / a.hbmTotalSum) * 100)}%）`)
      const text = parts.join(' · ')
      return h(
        'div',
        {
          style: { ...s.muted, fontSize: '12px', fontFamily: c.mono, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
          'data-testid': testid,
          title: text,
          'aria-label': `${t('envs.inlineTitle')}：${text}`,
        },
        text,
      )
    }

    // t29 v1.5：占用条按「卡」一卡一格（编号 1..N），格内聚合该卡占用与关键指标；
    // chip 级明细保留在「展开 N 卡详情」的逐 chip 行。
    function ChipStrip({ occ, t, testid }) {
      return h(
        'div',
        { role: 'list', style: { display: 'flex', flexWrap: 'wrap', gap: '4px' }, 'data-testid': testid },
          occ.cards.map((card) => {
            const look = card.state === 'occupied'
              ? { borderColor: c.warn, background: 'rgba(217,119,6,0.12)', color: c.warn, borderStyle: 'solid' }
              : card.state === 'idle'
                ? { borderColor: 'rgba(5,150,105,0.35)', background: 'transparent', color: 'rgba(5,150,105,0.8)', borderStyle: 'solid' }
                : { borderColor: c.textTertiary, background: 'transparent', color: c.textTertiary, borderStyle: 'dashed' }
            const label = `NPU ${card.number}（id ${card.card_id}）${t(`envs.chip.${card.state}`)} · ${card.occupied}/${card.chipCount} chip 占用`
            const detail = [
              card.tempMax !== null ? `温度峰值 ${Math.round(card.tempMax)}°C` : null,
              card.powerSum !== null ? `功率合计 ≈${Math.round(card.powerSum)}W` : null,
              card.aicoreMax !== null ? `AICore 峰值 ${Math.round(card.aicoreMax)}%` : null,
              card.hbmRateMax !== null ? `HBM 峰值 ${Math.round(card.hbmRateMax)}%` : null,
            ].filter(Boolean).join(' · ')
            return h('span', {
              key: `card-${card.card_id}`,
              role: 'listitem',
              style: { ...s.pill, fontSize: '10px', padding: '0 6px', fontFamily: c.mono, ...look },
              'data-testid': `envs.card.${card.card_id}`,
              'aria-label': label,
              title: `${label}${detail ? ` · ${detail}` : ''} · ${t('envs.tooltip.occChip')}`,
            }, `${card.number}`, h('span', { style: { opacity: 0.75, marginLeft: '3px' } }, `${card.occupied}/${card.chipCount}`))
          }),
      )
    }
    // 昇腾芯片意象：方形 die + 负载波形 + 对焦括号，纯 currentColor（深浅主题均可读），无外部资源依赖。
    function AscendIcon({ size = 14, className }) {
      // 原创组合：NPU 芯片轮廓 + 引脚（描边跟随主题色）+「昇」字符（昇腾暖色渐变）。
      // 非华为官方 logo，仅为语义关联；无任何外部资源。
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', className,
          style: { flex: 'none', display: 'inline-block', verticalAlign: '-2px', color: 'currentColor' },
        },
        h('rect', { x: '3.4', y: '3.4', width: '9.2', height: '9.2', rx: '2', stroke: 'currentColor', strokeWidth: '1.2', opacity: '0.5' }),
        h('path', { d: 'M1.4 6.2h1.4M1.4 8h1.4M1.4 9.8h1.4', stroke: 'currentColor', strokeWidth: '1.1', strokeLinecap: 'round', opacity: '0.5' }),
        h('path', { d: 'M13.2 6.2h1.4M13.2 8h1.4M13.2 9.8h1.4', stroke: 'currentColor', strokeWidth: '1.1', strokeLinecap: 'round', opacity: '0.5' }),
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: 'apf-asc-grad', x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0%', stopColor: '#E2452C' }),
            h('stop', { offset: '100%', stopColor: '#F5A623' }),
          ),
        ),
        h(
          'text',
          {
            x: '8', y: '8.8', textAnchor: 'middle', dominantBaseline: 'central',
            fontSize: '9', fontWeight: '800', fill: 'url(#apf-asc-grad)',
            fontFamily: "system-ui,-apple-system,'SF Pro Display','Segoe UI',sans-serif",
          },
          'A',
        ),
      )
    }

    // §t20 空态导入引导：仅 envs 为空时渲染；配置存在后由只读 ConfigBar + 环境卡接管。
    // SSH 导入只写 hostAlias 引用（密码/私钥永远留在 dsh-ssh 自己的 0600 文件里）。
    function ImportGuide({ config, busy, onRefreshAll, onImported, t }) {
      const [ssh, setSsh] = useState(null)
      const [sshBusy, setSshBusy] = useState(false)
      const [sshError, setSshError] = useState(null)
      const [text, setText] = useState('')
      const [jsonBusy, setJsonBusy] = useState(false)
      const [jsonErrors, setJsonErrors] = useState(null)
      const configFile = config?.configFile ?? 'envs.json'

      const loadPreview = async () => {
        setSshBusy(true)
        setSshError(null)
        try {
          setSsh(await apiPost('/envs/import/ssh/preview', {}))
        } catch (error) {
          setSshError(error?.message ?? String(error))
        } finally {
          setSshBusy(false)
        }
      }
      const confirmSsh = async () => {
        setSshBusy(true)
        setSshError(null)
        try {
          const out = await apiPost('/envs/import/ssh', {})
          if (typeof onImported === 'function') onImported(out?.imported ?? 0)
        } catch (error) {
          setSshError(error?.message ?? String(error))
        } finally {
          setSshBusy(false)
        }
      }
      const confirmJson = async () => {
        setJsonBusy(true)
        setJsonErrors(null)
        try {
          const out = await apiPost('/envs/import/json', { text })
          if ((out?.imported ?? 0) > 0) {
            if (typeof onImported === 'function') onImported(out.imported)
          } else {
            setJsonErrors(Array.isArray(out?.errors) && out.errors.length > 0 ? out.errors : [{ index: -1, message: t('envs.import.sshNoDraft') }])
          }
        } catch (error) {
          setJsonErrors([{ index: -1, message: error?.message ?? String(error) }])
        } finally {
          setJsonBusy(false)
        }
      }

      const sshBlock = h(
        'div',
        { style: s.card, 'data-testid': 'envs.import.ssh' },
        h('div', { style: s.sectionTitle }, t('envs.import.viaSsh')),
        h('div', { style: s.muted }, t('envs.import.sshHint', { file: ssh?.storeFile ?? '~/.dsh/dsh-ssh.json' })),
        !ssh && !sshError
          ? h('button', { type: 'button', style: s.button, onClick: loadPreview, disabled: sshBusy }, sshBusy ? '…' : t('envs.import.sshPreview'))
          : null,
        sshError ? h(StateMsg, { title: t('envs.import.sshUnavailable'), desc: sshError, tone: 'warn' }) : null,
        ssh && ssh.available === false
          ? h(StateMsg, { title: t('envs.import.sshUnavailable'), desc: ssh.reason?.message ?? '', tone: 'warn' })
          : null,
        ssh && ssh.available && (ssh.rows ?? []).length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              ssh.rows.slice(0, 8).map((row) =>
                h('div', { key: row.alias, style: { ...s.muted, fontSize: '11px' } }, `${row.ascend ? '★ ' : '· '}${row.alias}${row.skip ? `（${row.skip}）` : ''}`),
              ),
              (ssh.draft ?? []).length > 0
                ? h(
                    'div',
                    { style: s.row },
                    h('button', { type: 'button', style: s.button, onClick: confirmSsh, disabled: sshBusy }, sshBusy ? '…' : t('envs.import.sshImport', { n: ssh.draft.length })),
                    h('span', { style: s.muted }, t('envs.import.capacity', { n: ssh.capacity })),
                  )
                : h('div', { style: s.muted }, t('envs.import.sshNoDraft')),
            )
          : null,
      )
      const jsonBlock = h(
        'div',
        { style: s.card, 'data-testid': 'envs.import.json' },
        h('div', { style: s.sectionTitle }, t('envs.import.viaJson')),
        h('div', { style: s.muted }, t('envs.import.jsonHint')),
        h('textarea', {
          style: s.textarea,
          rows: 4,
          value: text,
          onChange: (e) => setText(e?.target?.value ?? ''),
          placeholder: t('envs.import.jsonPlaceholder'),
          'data-testid': 'envs.import.textarea',
        }),
        jsonErrors
          ? h(
              'div',
              { style: { ...s.muted, display: 'flex', flexDirection: 'column', gap: '2px' } },
              jsonErrors.map((err, i) => h('div', { key: `je-${i}`, style: s.code }, err.index >= 0 ? t('envs.import.errorEntry', { i: err.index + 1, msg: err.message }) : err.message)),
            )
          : null,
        h('button', { type: 'button', style: s.button, onClick: confirmJson, disabled: jsonBusy || !text.trim() }, jsonBusy ? '…' : t('envs.import.jsonImport')),
      )

      return h(Empty, {
        title: t('envs.import.title'),
        desc: t('envs.import.desc', { path: configFile }),
        action: h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          sshBlock,
          jsonBlock,
          h('div', { style: s.muted }, t('envs.import.manualDesc', { path: configFile })),
          h(
            'div',
            { style: s.row },
            h('button', { type: 'button', style: s.button, onClick: onRefreshAll, disabled: busy }, t('envs.refreshAll')),
          ),
        ),
      })
    }

    function EnvsSection({ state, busy, onRefreshAll, onImported, onOpenConfig, onReloadConfig, t }) {
      const configError = state?.envs_config_error ?? null
      if (configError) {
        // §14.6-⑮：配置读取失败 → 面板级错误卡替换环境区
        return h(
          Section,
          { title: t('envs.title'), extra: h('span', { style: s.muted }, t('envs.configManaged')) },
          h(StateMsg, {
            title: t('envs.configError.title'),
            desc: `${t('envs.configError.desc', { path: state?.config?.configFile ?? 'envs.json' })} ${configError.message ?? configError.code ?? ''}`.trim(),
            tone: 'error',
          }),
        )
      }
      const envs = state?.envs ?? []
      const config = state?.config ?? null
      // t34：「环境 N」按 envs 配置列表顺序编号（排序展示不影响编号）
      const envOrder = new Map(envs.map((e, i) => [e.id, i + 1]))
      const rows = envs
        .map((env) => {
          const cards = env.snapshot?.npu?.cards ?? null
          const occ = Array.isArray(cards) && cards.length > 0 ? deriveEnvOccupancy(cards) : null
          return { env, occ }
        })
      // §14.1-⑦ 排序：空闲 → 部分占用 → 高负载 → 占用未知 → 已停用；同档按名称
      const order = { idle: 0, partial: 1, busy: 2, unknown: 3, disabled: 4 }
      rows.sort((a, b) => {
        const ta = a.env.enabled === false ? 'disabled' : a.occ ? a.occ.tier : 'unknown'
        const tb = b.env.enabled === false ? 'disabled' : b.occ ? b.occ.tier : 'unknown'
        return (order[ta] ?? 3) - (order[tb] ?? 3) || String(a.env.name || a.env.hostAlias || a.env.id).localeCompare(String(b.env.name || b.env.hostAlias || b.env.id))
      })
      return h(
        Section,
        {
          title: t('envs.title'),
          extra: h('button', { type: 'button', style: s.button, onClick: onRefreshAll, disabled: busy, title: t('envs.refreshAll') }, busy ? '…' : t('envs.refreshAll')),
        },
        h(ConfigBar, { config, t, onOpenConfig, onReload: onReloadConfig, busy }),
        // t29 v1.5：环境段去噪——空态导入引导不再带「加载演示数据」入口（演示入口移至性能调优段底部）
        envs.length === 0
          ? h(ImportGuide, { config, busy, onRefreshAll, onImported, t })
          : rows.map(({ env, occ }) => h(EnvBlock, { key: env.id, env, occ, busy, index: envOrder.get(env.id) ?? 1, t })),
        (state?.warnings ?? []).length > 0
          ? h('div', { style: s.muted }, state.warnings.slice(0, 4).map((w, i) => h('div', { key: `w-${i}`, style: s.code }, `${w.code}: ${w.message}`)))
          : null,
      )
    }

    // t44 A：全局结构化弹窗编辑器（用户 m03645）——配置文件已按格式整理好，一行行弹出来让用户改，
    // 不要求直接编辑文件。逐字段校验在前端完成；保存 = POST /config v2 整体替换（Host 原子写 envs.json 0600）。
    function validateEnvForm(fields, mode) {
      const errors = {}
      const name = String(fields?.name ?? '').trim()
      if (!name) errors.name = 'envs.config.err.nameEmpty'
      else if (name.length > 64) errors.name = 'envs.config.err.nameLong'
      if (mode === 'ssh') {
        const host = String(fields?.hostAlias ?? '').trim()
        if (!host) errors.hostAlias = 'envs.config.err.hostRequired'
        else if (host.length > 128 || !/^[A-Za-z0-9_.:@-]+$/.test(host)) errors.hostAlias = 'envs.config.err.hostInvalid'
        else if (host.includes('@') && !/^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+$/.test(host)) errors.hostAlias = 'envs.config.err.hostUserHost'
      }
      const path = String(fields?.npuSmiPath ?? '').trim()
      if (!path || path.length > 512 || !/^[A-Za-z0-9_./~-]+$/.test(path)) errors.npuSmiPath = 'envs.config.err.pathInvalid'
      const timeout = Number(fields?.timeoutMs)
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) errors.timeoutMs = 'envs.config.err.timeoutRange'
      return { ok: Object.keys(errors).length === 0, errors }
    }

    // 弹窗内单环境一行：名称 / 模式 / SSH 目标 / npu-smi 路径 / 超时 / 启用 / 删除
    function EnvConfigRow({ row, index, errors, busy, onField, onRemove, t }) {
      const err = (k) => (errors && errors[k] ? h('div', { style: { color: c.error, fontSize: '11px' } }, t(errors[k])) : null)
      const field = (key, labelKey, testid, extra = {}) => h(
        'label',
        { style: { ...s.field, minWidth: 0 } },
        h('span', { style: s.muted }, t(labelKey)),
        h('input', { type: 'text', style: s.inputText, value: row[key] ?? '', onChange: (e) => onField(index, key, e.target.value), 'aria-label': t(labelKey), 'data-testid': `envs.config.row.${index}.${testid}`, ...extra }),
        err(key),
      )
      return h(
        'div',
        { 'data-testid': `envs.config.row.${index}`, style: { border: `1px solid ${c.borderSoft}`, borderRadius: '10px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px', background: c.layer2 } },
        h(
          'div',
          { style: { ...s.row, justifyContent: 'space-between' } },
          h('span', { style: { ...s.muted, ...s.num, fontSize: '11px' }, title: row.id }, `#${index + 1} · ${row.id}`),
          h('button', { type: 'button', 'data-testid': `envs.config.row.${index}.del`, onClick: () => onRemove(index), disabled: busy, style: { ...s.buttonGhost, fontSize: '11px', padding: '2px 8px', color: c.error } }, t('envs.config.remove')),
        ),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '6px' } },
          field('name', 'envs.f.name', 'name'),
          h(
            'label',
            { style: { ...s.field, minWidth: 0 } },
            h('span', { style: s.muted }, t('envs.f.mode')),
            h('select', { style: s.select, value: row.mode, onChange: (e) => onField(index, 'mode', e.target.value), 'aria-label': t('envs.f.mode'), 'data-testid': `envs.config.row.${index}.mode` },
              h('option', { value: 'local' }, t('envs.modeLocal')),
              h('option', { value: 'ssh' }, t('envs.modeSsh')),
            ),
          ),
          row.mode === 'ssh' ? field('hostAlias', 'envs.f.hostAlias', 'hostAlias') : null,
          field('npuSmiPath', 'envs.f.npuSmiPath', 'npuSmiPath'),
          field('timeoutMs', 'envs.f.timeoutMs', 'timeoutMs', { inputMode: 'numeric' }),
          h(
            'label',
            { style: { ...s.field, minWidth: 0, alignSelf: 'end' } },
            h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              h('input', { type: 'checkbox', checked: row.enabled !== false, onChange: (e) => onField(index, 'enabled', e.target.checked), 'aria-label': t('envs.f.enabled'), 'data-testid': `envs.config.row.${index}.enabled` }),
              h('span', null, t('envs.f.enabled'))),
            h('div', { style: { ...s.muted, fontSize: '11px' } }, t('envs.f.enabledHint')),
          ),
        ),
      )
    }

    // t44 A：环境配置弹窗。顶部采集频率（1–60 分钟），下方逐行列出全部环境字段；
    // 支持添加（≤16）/删除；保存 = POST /config v2 整体替换写 envs.json；取消还原。
    function EnvConfigModal({ config, busy, onSave, onClose, t }) {
      const baseEnvs = Array.isArray(config?.envs) ? config.envs : []
      const [pollMinutes, setPollMinutes] = useState(String(Math.max(1, Math.round((config?.pollIntervalMs ?? 300000) / 60000))))
      const [rows, setRows] = useState(() => baseEnvs.map((env, index) => ({
        id: env?.id ?? `env-new-${index + 1}`,
        name: env?.name ?? '',
        mode: env?.mode === 'ssh' ? 'ssh' : 'local',
        hostAlias: env?.hostAlias ?? '',
        npuSmiPath: env?.npuSmiPath ?? 'npu-smi',
        timeoutMs: String(env?.timeoutMs ?? 15000),
        enabled: env?.enabled !== false,
      })))
      const pollRaw = String(pollMinutes ?? '').trim()
      const pollOk = /^\d+$/.test(pollRaw) && Number(pollRaw) >= 1 && Number(pollRaw) <= 60
      const rowErrors = rows.map((row) => validateEnvForm(row, row.mode).errors)
      const allRowsOk = rowErrors.every((errors) => Object.keys(errors).length === 0)
      const addEnv = () => {
        if (rows.length >= 16) return
        setRows([...rows, { id: `env-new-${Math.random().toString(36).slice(2, 8)}`, name: '', mode: 'ssh', hostAlias: '', npuSmiPath: 'npu-smi', timeoutMs: '15000', enabled: true }])
      }
      const removeEnv = (index) => { setRows(rows.filter((_, i) => i !== index)) }
      const setField = (index, key, value) => { setRows(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row))) }
      const canSave = pollOk && allRowsOk && rows.length > 0 && rows.length <= 16 && !busy
      const save = () => {
        if (!canSave || typeof onSave !== 'function') return
        onSave({
          pollIntervalMs: Number(pollRaw) * 60000,
          envs: rows.map((row) => ({
            id: row.id,
            name: String(row.name ?? '').trim(),
            mode: row.mode,
            hostAlias: row.mode === 'ssh' ? String(row.hostAlias ?? '').trim() : null,
            npuSmiPath: String(row.npuSmiPath ?? '').trim() || 'npu-smi',
            timeoutMs: Number(row.timeoutMs),
            enabled: row.enabled === true,
          })),
        })
      }
      const path = config?.configFile ?? null
      return h(
        'div',
        { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('envs.config.title'), 'data-testid': 'envs.config.modal', style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 60 } },
        h(
          'div',
          { style: { ...s.card, background: c.layer1, width: '100%', maxWidth: '560px', maxHeight: '82vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' } },
          h(
            'div',
            { style: { ...s.row, justifyContent: 'space-between' } },
            h('span', { style: s.sectionTitle }, t('envs.config.title')),
            path ? h('span', { style: { ...s.tag, fontFamily: c.mono }, title: path }, truncMid(path)) : null,
          ),
          h(
            'label',
            { style: { ...s.field, fontSize: '12px', maxWidth: '220px' } },
            h('span', { style: s.muted }, t('envs.config.poll')),
            h('input', { type: 'text', inputMode: 'numeric', style: s.inputText, value: pollRaw, onChange: (e) => setPollMinutes(e.target.value), 'aria-label': t('envs.config.poll'), 'data-testid': 'envs.config.poll' }),
            !pollOk ? h('div', { style: { color: c.error, fontSize: '11px' } }, t('envs.config.err.poll')) : null,
          ),
          rows.map((row, index) => h(EnvConfigRow, { key: row.id, row, index, errors: rowErrors[index], busy, onField: setField, onRemove: removeEnv, t })),
          h(
            'div',
            { style: { ...s.row, justifyContent: 'space-between' } },
            h('button', { type: 'button', 'data-testid': 'envs.config.add', onClick: addEnv, disabled: busy || rows.length >= 16, style: { ...s.buttonGhost, fontSize: '12px' } }, `＋ ${t('envs.config.add')}`),
            h('span', { style: { ...s.muted, fontSize: '11px' } }, `${rows.length}/16 · ${t('envs.config.limit')}`),
          ),
          h(
            'div',
            { style: { ...s.row, justifyContent: 'flex-end', gap: '6px' } },
            h('button', { type: 'button', 'data-testid': 'envs.config.cancel', onClick: onClose, disabled: busy, style: s.buttonGhost }, t('envs.config.cancel')),
            h('button', { type: 'button', 'data-testid': 'envs.config.save', onClick: save, disabled: !canSave, style: s.buttonPrimary }, busy ? '…' : t('envs.config.save')),
          ),
        ),
      )
    }

    // t29 v1.5：卡头部「编辑」入口 + 编辑态表单；单环境「刷新」按钮与末尾 staleHint 行按用户要求移除
    // t36：主机标识单次显示（用户 m02470 靠 IP 区分环境）——去 user@ 前缀，「环境 N · IP」/「自定义名 · IP」；编辑态 SSH 字段仍为完整 user@host
    const stripUserPrefix = (target) => { const raw = String(target ?? ''); const at = raw.lastIndexOf('@'); return at >= 0 ? raw.slice(at + 1) : raw }
    function envHostTag(env) {
      const raw = env?.hostAlias ?? env?.host_alias ?? null
      return env?.mode === 'ssh' && raw ? stripUserPrefix(raw) : null
    }
    // 统一展示口径（T35-1）：主机标识只出现一次；自定义名优先并列裸 host；播种默认（name===hostAlias）用 fallbackName 或裸 host
    function envDisplayName(env, fallbackName) {
      const raw = env?.hostAlias ?? env?.host_alias ?? null
      const host = envHostTag(env)
      const custom = env?.name && (!raw || env.name !== raw) ? env.name : null
      let base
      if (custom) base = custom
      else if (host) base = fallbackName ?? null // 播种默认（name===hostAlias）：「环境 N」或裸 host
      else base = env?.name ?? null // 本机：显示名称
      if (base == null || base === '') base = env?.id ?? ''
      return host ? (base ? `${base} · ${host}` : host) : base
    }
    // t44：环境卡只读（编辑入口收进 ConfigBar「环境配置」弹窗）；SSH 连接抖动保留旧档 → stale 档 +「连接抖动 · 上次 HH:MM」
    function EnvBlock({ env, occ, busy, index = 0, t }) {
      const displayName = envDisplayName(env, t('envs.fallbackName', { n: index }))
      const snapshot = env.snapshot ?? null
      const disabled = env.enabled === false
      const availability = env.availability ?? 'pending'
      const hasView = (availability === 'available' || availability === 'stale') && snapshot?.npu?.cards?.length > 0
      const tier = disabled ? 'disabled' : occ ? occ.tier : 'unknown'
      const tierLabel = t(`envs.tier.${tier}`)
      const occupied = occ && tier !== 'disabled' ? occ.occupied : null
      const total = occ && tier !== 'disabled' ? occ.total : null
      const pollMs = 300000
      const stale = env.collected_at
        ? (Date.now() - new Date(env.collected_at).getTime() > 2 * pollMs) || (availability !== 'available' && hasView)
        : false
      const lastOk = env.last_success_at ? String(env.last_success_at).replace('T', ' ').slice(11, 16) : null
      const conn = disabled
        ? null
        : availability === 'stale'
          ? { label: t('envs.conn.flap', { time: lastOk ?? '--:--' }), tone: 'warn' }
          : availability === 'available'
            ? (stale ? { label: t('envs.conn.stale'), tone: 'warn' } : null)
            : availability === 'unreachable'
              ? { label: t('envs.conn.unreachable'), tone: 'error' }
              : availability === 'command_missing'
                ? { label: t('envs.conn.commandMissing'), tone: 'warn' }
                : availability === 'no_device'
                  ? { label: t('envs.conn.noDevice'), tone: 'warn' }
                  : availability === 'pending'
                    ? { label: t('envs.conn.pending'), tone: null }
                    : { label: String(availability), tone: 'warn' }
      return h(
        'div',
        {
          style: { ...s.card, display: 'flex', flexDirection: 'column', gap: '8px', opacity: disabled ? 0.6 : 1 },
          'data-testid': `envs.block.${env.id}`,
        },
        h(
          'div',
          { style: { ...s.row, justifyContent: 'space-between', flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
            h(OccupancyPill, {
              tier,
              occupied,
              total,
              label: tierLabel,
              ariaLabel: `${displayName}：${tierLabel}${occ ? `（${occ.occupied}/${occ.total} chip 占用）` : ''}。${t('envs.tooltip.occWhy')}`,
              testid: `envs.block.${env.id}.pill`,
            }),
            occ && occ.criticalCount > 0 ? h('span', { style: { ...s.muted, fontSize: '11px' }, title: t('envs.chipAbnormal', { k: occ.criticalCount }) }, t('envs.chipAbnormal', { k: occ.criticalCount })) : null,
            h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: displayName }, displayName),
            conn ? h(ConnBadge, { label: conn.label, tone: conn.tone, testid: `envs.block.${env.id}.conn` }) : null,
            h('span', { style: s.muted }, env.mode === 'ssh' ? t('envs.modeSsh') : t('envs.modeLocal')),
            env.collected_at ? h('span', { style: { ...s.muted, ...s.num } }, t('envs.updatedAt', { time: String(env.collected_at).replace('T', ' ').slice(0, 19) })) : null,
          ),
        ),
        disabled
          ? h('div', { style: s.muted }, t('envs.disabledHint'))
          : availability === 'pending'
            ? h('div', { style: s.muted }, t('envs.firstCollect'))
            : hasView
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  // t19：默认视图瘦身——占用进程行（有才显示）+ chip 条 + 一行内联摘要；完整指标收进展开详情
                  h(OccProcRow, { occ, t, testid: `envs.block.${env.id}.procs` }),
                  h(ChipStrip, { occ, t, testid: `envs.block.${env.id}.strip` }),
                  h(EnvInlineSummary, { cards: snapshot.npu.cards, t, testid: `envs.block.${env.id}.inline` }),
                  h(CardsBlock, { cards: snapshot.npu.cards, t, expandKey: 'envs.expandCards', collapseKey: 'envs.collapseCards', summary: h(EnvMetricSummary, { cards: snapshot.npu.cards, t }) }),
                  snapshot.software?.cann ? h('div', { style: s.muted }, `CANN ${snapshot.software.cann}`) : null,
                )
              : h(StateMsg, {
                  title: conn ? conn.label : String(availability),
                  desc: env.error ? `${env.error.code ?? ''} ${env.error.message ?? ''}`.trim() : (env.warnings ?? []).map((w) => `${w.code}: ${w.message}`).join(' · ') || (stale ? t('envs.staleHint') : null),
                  tone: availability === 'unreachable' ? 'error' : 'warn',
                }),
      )
    }
    function DeviceSection({ state, busy, onRefresh, onDemo, t }) {
      const snapshot = state?.snapshot
      const warnings = state?.warnings ?? []
      const noCards = !snapshot || snapshot.availability !== 'available' || !(snapshot.npu?.cards?.length)
      return h(
        Section,
        {
          title: t('section.device'),
          extra: h(
            'button',
            { type: 'button', style: s.button, onClick: onRefresh, disabled: busy, title: t('action.refresh') },
            busy ? '…' : t('action.refresh'),
          ),
        },
        h(SourceBar, { source: snapshot?.source ?? state?.source, demo: state?.demo, t }),
        !snapshot
          ? h(Empty, { title: t('state.notCollected'), desc: t('state.notCollectedDesc') })
          : renderSnapshot(snapshot, t),
        noCards
          ? h(
              'div',
              { style: s.row },
              h('button', { type: 'button', style: s.button, onClick: onDemo, disabled: busy }, t('action.loadDemo')),
              h('span', { style: s.muted }, t('state.demoDesc')),
            )
          : null,
        warnings.length > 0
          ? h(
              'div',
              { style: s.muted },
              warnings.slice(0, 6).map((w, i) => h('div', { key: `w-${i}`, style: s.code }, `${w.code}: ${w.message}`)),
            )
          : null,
      )
    }

    function renderSnapshot(snapshot, t) {
      if (!snapshot) return null
      if (snapshot.availability === 'no_device') return h(StateMsg, { title: t('state.noDevice'), desc: t('state.noDeviceDesc'), tone: 'warn' })
      if (snapshot.availability === 'command_missing') return h(StateMsg, { title: t('state.noTool'), desc: t('state.noToolDesc'), tone: 'warn' })
      if (snapshot.availability === 'unreachable') return h(StateMsg, { title: t('state.sshFail'), desc: t('state.sshFailDesc'), tone: 'error' })
      const software = snapshot.software ?? {}
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h(
          'div',
          { style: s.row },
          h(Pill, { tone: 'success' }, `${snapshot.npu.card_count} NPU / ${snapshot.npu.chip_count} chip`),
          software.npu_smi ? h(Pill, null, `npu-smi ${software.npu_smi}`) : null,
          software.cann ? h(Pill, null, `CANN ${software.cann}`) : null,
          snapshot.collection?.stale ? h(Pill, { tone: 'warn' }, t('state.stale')) : null,
        ),
        h(DeviceSummary, { cards: snapshot.npu.cards ?? [], t }),
        h(CardsBlock, { cards: snapshot.npu.cards ?? [], t }),
        h('div', { style: s.muted }, `${snapshot.host?.arch ?? '—'} · ${snapshot.collection?.command_ids?.length ?? 0} 条只读命令`),
      )
    }

    function aggChips(cards) {
      const chips = (cards ?? []).flatMap((card) => card.chips ?? [])
      const vals = (pick) => chips.map(pick).filter((v) => (typeof v === 'number' && Number.isFinite(v)))
      const temps = vals((ch) => ch.temp_c)
      const powers = vals((ch) => ch.power_w)
      const aicores = vals((ch) => ch.aicore_pct)
      const hbmUsed = vals((ch) => ch.hbm_used_mb)
      const hbmTotal = vals((ch) => ch.hbm_total_mb)
      const hbmRates = vals((ch) => ch.hbm_usage_rate_pct)
      const procs = new Map()
      for (const ch of chips) for (const proc of ch.processes ?? []) {
        const key = proc.name || String(proc.pid)
        procs.set(key, (procs.get(key) ?? 0) + 1)
      }
      const models = [...new Set((cards ?? []).map((card) => card.model).filter(Boolean))]
      const range = (arr) => (arr.length === 0 ? null : arr.length === 1 || Math.min(...arr) === Math.max(...arr) ? `${fmt(Math.min(...arr))}` : `${fmt(Math.min(...arr))}–${fmt(Math.max(...arr))}`)
      const sum = (arr) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0))
      return {
        models,
        tempRange: range(temps),
        powerSum: sum(powers),
        aicoreRange: range(aicores),
        aicoreMax: aicores.length ? Math.max(...aicores) : null,
        hbmUsedSum: sum(hbmUsed),
        hbmTotalSum: sum(hbmTotal),
        hbmRateRange: range(hbmRates),
        hbmRateMax: hbmRates.length ? Math.max(...hbmRates) : null,
        procEntries: [...procs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
        chipCount: chips.length,
      }
    }

    function DeviceSummary({ cards, t }) {
      const a = aggChips(cards)
      if (a.chipCount === 0) return null
      const giB = (mb) => fmt(Math.round((mb / 1024) * 10) / 10)
      const cell = (label, value, tone) => h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: '6px' } },
        h('span', { style: s.muted }, label),
        h('span', { style: { color: tone === 'hot' ? c.warn : tone === 'crit' ? c.error : undefined, fontWeight: tone ? 600 : undefined } }, value),
      )
      return h(
        'div',
        { style: { ...s.card, gap: '3px' } },
        cell(t('device.model'), `${a.models.length ? a.models.join(' / ') : '—'} · ${cards.length} 卡 / ${a.chipCount} chip`),
        a.tempRange !== null ? cell(t('device.temp'), `${a.tempRange} °C`, Number(String(a.tempRange).split('–').pop()) >= 80 ? 'crit' : Number(String(a.tempRange).split('–').pop()) >= 70 ? 'hot' : undefined) : null,
        a.powerSum !== null ? cell(t('device.power'), `≈ ${fmt(Math.round(a.powerSum))} W`) : null,
        a.aicoreRange !== null ? cell(t('device.aicore'), `${a.aicoreRange} %`, a.aicoreMax >= 90 ? 'hot' : undefined) : null,
        a.hbmUsedSum !== null && a.hbmTotalSum ? cell(t('device.hbm'), `${giB(a.hbmUsedSum)} / ${giB(a.hbmTotalSum)} GiB${a.hbmRateRange !== null ? `（${a.hbmRateRange}%）` : ''}`, a.hbmRateMax !== null && a.hbmRateMax >= 90 ? 'crit' : a.hbmRateMax !== null && a.hbmRateMax >= 75 ? 'hot' : undefined) : null,
        a.procEntries.length ? cell(t('device.procs'), a.procEntries.map(([name, count]) => `${name} ×${count}`).join(' · ')) : null,
      )
    }

    function CardsBlock({ cards, t, expandKey = 'device.showCards', collapseKey = 'device.hideCards', summary = null }) {
      const [open, setOpen] = useState(false)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('button', { type: 'button', style: s.button, onClick: () => setOpen(!open), 'aria-expanded': open ? 'true' : 'false' }, open ? t(collapseKey) : t(expandKey, { n: cards.length })),
        // t19：完整指标明细（多行摘要）随展开区显示
        ...(open ? [summary, ...cards.map((card) => h(CardBlock, { key: `card-${card.card_id}`, card, t }))].filter(Boolean) : []),
      )
    }

    function CardBlock({ card, t }) {
      const chips = card.chips ?? []
      const occCount = chips.filter((ch) => chipOccState(ch) === 'occupied').length
      return h(
        'div',
        { style: s.card },
        h(
          'div',
          { style: { ...s.row, justifyContent: 'space-between' } },
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', minWidth: 0 } },
            h(UDot, { tone: occCount > 0 ? 'occupied' : 'idle' }),
            // t29：卡头与占用条同用 1 基编号（card_id+1），npu-smi 原始 id 保留为次要信息
            h('div', { style: { fontWeight: 600 } }, `NPU ${(typeof card.card_id === 'number' ? card.card_id : 0) + 1}`, h('span', { style: s.muted }, `（id ${card.card_id}） ${card.model ?? ''}`)),
          ),
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h('span', { style: { ...s.tag, ...s.num } }, t('envs.tier.count', { occ: occCount, total: chips.length })),
            h('span', { style: { ...s.muted, ...s.num } }, card.power_w !== null && card.power_w !== undefined ? `${card.power_w} W` : t('state.missing')),
          ),
        ),
        h(
          'div',
          { style: s.chipGrid },
          chips.map((chip) => h(ChipRow, { key: `chip-${card.card_id}-${chip.chip_id}`, chip, t })),
        ),
      )
    }

    function ChipRow({ chip, t }) {
      const state = chipOccState(chip)
      const stateColor = state === 'occupied' ? c.warn : state === 'idle' ? c.success : c.textTertiary
      const stateStyle = state === 'occupied'
        ? { borderColor: c.warn, background: 'rgba(217,119,6,0.08)', color: c.warn, borderStyle: 'solid' }
        : state === 'idle'
          ? { borderColor: 'rgba(5,150,105,0.35)', background: 'transparent', color: 'rgba(5,150,105,0.85)', borderStyle: 'solid' }
          : { borderColor: c.textTertiary, background: 'transparent', color: c.textTertiary, borderStyle: 'dashed' }
      const hbmRate = typeof chip.hbm_usage_rate_pct === 'number'
        ? chip.hbm_usage_rate_pct
        : (typeof chip.hbm_used_mb === 'number' && typeof chip.hbm_total_mb === 'number' && chip.hbm_total_mb > 0 ? (chip.hbm_used_mb / chip.hbm_total_mb) * 100 : null)
      const cells = [
        [t('device.temp'), chip.temp_c, '°C'],
        [t('device.power'), chip.power_w, 'W'],
        ['AICore', chip.aicore_pct, '%'],
        ['NPU', chip.npu_util_pct, '%'],
        [t('device.hbm'), chip.hbm_used_mb, 'MB', hbmRate !== null ? `（${fmt(hbmRate)}%）` : null],
      ]
      const procs = Array.isArray(chip.processes) ? chip.processes : []
      const procText = procs.length
        ? procs.map((p) => `${p.pid} ${p.name}${p.memory_mb !== null && p.memory_mb !== undefined ? ` ${fmt(p.memory_mb)}MB` : ''}`).join(' · ')
        : state === 'occupied'
          ? t('envs.procsUnavailableByMetrics')
          : chip.processes_state === 'none_reported' ? t('envs.procsNone') : t('envs.procsUnavailable')
      return h(
        'div',
        { style: { ...s.chip, borderColor: state === 'occupied' ? c.warn : state === 'unknown' ? c.textTertiary : s.chip.borderColor }, 'data-testid': `envs.chiprow.${chip.chip_id}` },
        h(
          'div',
          { style: { ...s.row, justifyContent: 'space-between', marginBottom: '2px' } },
          h('span', { style: { color: c.textSecondary, ...s.num } }, `chip ${chip.chip_id} · Phy ${chip.phy_id}`),
          h('span', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
            h('span', { style: { ...s.pill, fontSize: '10px', padding: '0 6px', ...stateStyle }, title: t('envs.tooltip.occChip') }, t(`envs.chip.${state}`)),
            h(Pill, { tone: chip.health === 'ok' ? 'success' : chip.health === 'critical' ? 'error' : 'warn' }, chip.health),
          ),
        ),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px' } },
          cells.map(([label, value, unit, suffix]) =>
            h(
              'div',
              { key: label, style: { display: 'flex', justifyContent: 'space-between', gap: '4px' } },
              h('span', { style: s.muted }, label),
              h('span', { style: s.num }, value === null || value === undefined ? t('state.missing') : `${fmt(value)} ${unit}${suffix ?? ''}`),
            ),
          ),
        ),
        h('div', { style: { ...s.muted, marginTop: '2px', ...s.num, fontSize: '11px' } }, procText),
      )
    }
    function RunsSection({ state, baselineId, candidateId, setBaselineId, setCandidateId, onImport, onCompare, busy, t }) {
      const runs = state?.runs ?? []
      const [open, setOpen] = useState(false)
      const sorted = [...runs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      const options = [
        h('option', { key: 'empty', value: '' }, '—'),
        ...sorted.map((r) => h('option', { key: r.run_id, value: r.run_id }, `${r.label} · ${timeText(r.timestamp ?? r.created_at)}`)),
      ]
      return h(
        Section,
        {
          title: t('section.runs'),
          extra: h(
            'div',
            { style: s.row },
            h('button', { type: 'button', style: s.button, onClick: onImport }, t('action.import')),
          ),
        },
        runs.length === 0
          ? h(Empty, {
              title: t('state.emptyRuns'),
              desc: t('state.emptyRunsDesc'),
              action: h(
                'div',
                { style: s.row },
                h('button', { type: 'button', style: s.buttonPrimary, onClick: onImport }, t('action.import')),
              ),
            })
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } }, h('span', { style: s.muted }, t('compare.baseline')), h('select', { style: s.select, value: baselineId ?? '', onChange: (e) => setBaselineId(e.target.value || null) }, options)),
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } }, h('span', { style: s.muted }, t('compare.candidate')), h('select', { style: s.select, value: candidateId ?? '', onChange: (e) => setCandidateId(e.target.value || null) }, options)),
              ),
              h(
                'div',
                { style: s.row },
                h(
                  'button',
                  {
                    type: 'button',
                    style: s.buttonPrimary,
                    disabled: busy || !baselineId || !candidateId || baselineId === candidateId,
                    onClick: onCompare,
                  },
                  t('action.compare'),
                ),
                h('button', { type: 'button', style: s.buttonGhost, onClick: () => setOpen(!open) }, open ? '收起' : `共 ${runs.length} 条`),
              ),
              open
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                    sorted.map((r) =>
                      h(
                        'div',
                        { key: r.run_id, style: { ...s.row, justifyContent: 'space-between' } },
                        h('span', { style: { ...s.code, flex: 1 } }, `${r.label} · ${timeText(r.timestamp ?? r.created_at)}`),
                        h(Pill, { tone: r.source?.is_demo ? 'warn' : undefined }, r.source?.is_demo ? t('source.demo') : r.source?.evidence_kind === 'unverified_import' ? t('state.unverified') : t('source.import')),
                      ),
                    ),
                  )
                : null,
            ),
      )
    }

    function CompareView({ comparison, baseline, candidate, onExport, onCopy, t }) {
      if (!comparison) return null
      const counts = comparison.verdict_counts ?? { regressed: 0, improved: 0, stable: 0, missing: 0 }
      const conclusionTone = comparison.summary.conclusion === 'regressed' ? 'error' : comparison.summary.conclusion === 'improved' ? 'success' : 'muted'
      const comp = comparison.comparability
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h(
          'div',
          { style: { ...s.notice, color: conclusionTone === 'error' ? c.error : conclusionTone === 'success' ? c.success : c.text } },
          h('div', { style: { fontWeight: 600, fontSize: '13px' } }, t(`compare.conclusion.${comparison.summary.conclusion}`)),
          h('div', null, comparison.summary.message),
          h('div', { style: { ...s.muted, marginTop: '2px' } }, `${baseline?.label ?? ''} → ${candidate?.label ?? ''} · ${t('compare.threshold').replace('{value}', String(comparison.threshold_pct))}`),
        ),
        comp !== 'matched'
          ? h(StateMsg, { title: t(`compare.${comp}`), desc: (comparison.comparability_issues ?? []).slice(0, 6).map((i) => `${i.field}: ${i.message}`).join('；'), tone: 'warn' })
          : h('div', { style: s.muted }, t('compare.matched')),
        h('div', { style: s.muted }, t('compare.counts').replace('{regressed}', counts.regressed ?? 0).replace('{improved}', counts.improved ?? 0).replace('{stable}', counts.stable ?? 0).replace('{missing}', counts.missing ?? 0)),
        h(
          'div',
          { style: s.table },
          h(
            'div',
            { style: { ...s.tr, borderBottom: 'none' } },
            h('span', { style: s.th }, '指标'),
            h('span', { style: s.th }, t('compare.baseline')),
            h('span', { style: s.th }, t('compare.candidate')),
            h('span', { style: s.th }, 'Δ'),
          ),
          comparison.metrics.map((m) =>
            h(
              'div',
              { key: m.key, style: s.tr },
              h('span', null, t(`metric.${m.key}`)),
              h('span', { style: s.muted }, m.baseline === null ? '—' : `${fmt(m.baseline)} ${m.unit}`),
              h('span', { style: s.muted }, m.candidate === null ? '—' : `${fmt(m.candidate)} ${m.unit}`),
              h(
                'span',
                { style: { color: verdictColor(m.verdict), display: 'flex', flexDirection: 'column' } },
                h('span', null, m.delta_pct === null ? '—' : `${m.delta_pct > 0 ? '+' : ''}${m.delta_pct}%`),
                h('span', { style: { fontSize: '10px', opacity: 0.8 } }, t(`compare.verdict.${m.verdict}`)),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: s.row },
          h('button', { type: 'button', style: s.button, onClick: onExport }, t('action.export')),
          h('button', { type: 'button', style: s.buttonGhost, onClick: onCopy }, t('action.copy')),
        ),
      )
    }

    function InsightSection({ report, t }) {
      const insights = report?.insights ?? []
      return h(
        Section,
        { title: t('section.insights') },
        insights.length === 0
          ? h(Empty, { title: t('insight.empty'), desc: report ? `${t('insight.skipped')}: ${(report.skipped_rules ?? []).slice(0, 3).map((r) => r.rule_id).join(', ') || '—'}` : t('state.emptyInsight') })
          : insights.map((insight) =>
              h(
                'div',
                { key: insight.id, style: { ...s.insight, borderLeftColor: insight.severity === 'critical' ? c.error : insight.severity === 'warning' ? c.warn : insight.severity === 'notice' ? c.brand : c.textTertiary } },
                h('div', { style: { ...s.row, justifyContent: 'space-between' } }, h('span', { style: { fontWeight: 600 } }, insight.title), h(Pill, { tone: insight.severity === 'critical' ? 'error' : insight.severity === 'warning' ? 'warn' : undefined }, insight.severity)),
                h('div', { style: s.muted }, `${insight.rule_id} · ${insight.confidence === 'heuristic' ? t('insight.confidenceHeuristic') : t('insight.confidenceObserved')}`),
                (insight.evidence ?? []).slice(0, 4).map((e, i) => h('div', { key: `e-${i}`, style: s.code }, `${e.field}: ${e.value ?? '—'} ${e.unit ?? ''}`)),
                h('div', { style: { color: c.textSecondary, fontSize: '12px' } }, `${t('insight.suggestion')}：${insight.suggestion}`),
              ),
            ),
      )
    }

    function ImportSheet({ onClose, onDone, t, demo }) {
      const [file, setFile] = useState(null)
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [okMsg, setOkMsg] = useState(null)

      const pick = (event) => {
        const f = event.target.files?.[0] ?? null
        setError(null)
        setOkMsg(null)
        if (f && f.size > 1024 * 1024) {
          setError(t('import.tooLarge'))
          return
        }
        setFile(f)
      }
      const submit = async () => {
        const pasted = text.trim()
        if (!pasted && !file) {
          setError(t('import.needContent'))
          return
        }
        setBusy(true)
        setError(null)
        try {
          const content = pasted || (await file.text())
          const filename = pasted ? 'pasted.csv' : file.name
          const payload = await apiPost('/import', { filename, content })
          const base = payload.deduplicated ? t('import.deduplicated') : t('import.success').replace('{label}', payload.runs?.map((r) => r.label).join('、') ?? filename)
          setOkMsg(demo ? `${base} ${t('import.demoHidden')}` : base)
          onDone?.()
        } catch (e) {
          setError(`${e.code}: ${e.message}`)
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { role: 'dialog', 'aria-modal': 'true', style: { ...s.card, gap: '10px' } },
        h('div', { style: { ...s.row, justifyContent: 'space-between' } }, h('div', { style: { fontWeight: 600 } }, t('import.title')), h('button', { type: 'button', style: s.buttonGhost, onClick: onClose }, t('action.cancel'))),
        h('label', { style: s.field }, h('span', null, t('import.file')), h('input', { type: 'file', accept: '.json,.csv,application/json,text/csv', style: s.fileInput, onChange: pick })),
        h(
          'label',
          { style: s.field },
          h('span', null, t('import.paste')),
          h('textarea', { style: s.textarea, value: text, onChange: (e) => setText(e.target.value), placeholder: t('import.pasteHint') }),
        ),
        h('div', { style: s.muted }, t('import.pasteHint')),
        h('div', { style: s.muted }, t('import.privacy')),
        error ? h(StateMsg, { title: t('import.parseError'), desc: error, tone: 'error' }) : null,
        okMsg ? h(StateMsg, { title: okMsg, tone: 'success' }) : null,
        h(
          'div',
          { style: { ...s.row, justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: s.buttonPrimary, disabled: busy || (!file && !text.trim()), onClick: submit }, busy ? '…' : t('import.submit')),
        ),
      )
    }

    function Panel({ t }) {
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [baselineId, setBaselineId] = useState(null)
      const [candidateId, setCandidateId] = useState(null)
      const [comparison, setComparison] = useState(null)
      const [report, setReport] = useState(null)
      const [importing, setImporting] = useState(false)
      const [notice, setNotice] = useState(null)
      // 分段选择只保存在进程内 state：刷新后回到默认「环境信息」（IA v1.4）。
      const [segment, setSegment] = useState('envs')
      // t44 A：「环境配置」弹窗开关（全局结构化编辑器，替代卡内编辑）
      const [configOpen, setConfigOpen] = useState(false)
      const loadedRef = useRef(false)

      const applyState = (data) => {
        setState(data)
        const runs = [...(data.runs ?? [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        if (runs.length >= 2) {
          setBaselineId((prev) => prev ?? runs[1].run_id)
          setCandidateId((prev) => prev ?? runs[0].run_id)
        } else if (runs.length === 1) {
          setCandidateId((prev) => prev ?? runs[0].run_id)
        }
      }

      const load = useCallback(async () => {
        setError(null)
        try {
          const data = await apiGet('/state')
          applyState(data)
          if (!loadedRef.current) {
            loadedRef.current = true
            const envs = data.envs ?? []
            if (envs.length > 0 && !data.demo && !envs.some((env) => env.collected_at)) {
              try {
                await apiPost('/status', { refresh_all: true })
                applyState(await apiGet('/state'))
              } catch (e) {
                setError(`${e.code ?? 'REQUEST_FAILED'}: ${e.message}`)
              }
            }
            // v1.2：未配置环境（envs 为空）不再自动单快照采集——空态引导用户编辑配置文件或加载演示
          }
        } catch (e) {
          setError(`${e.code ?? 'REQUEST_FAILED'}: ${e.message}`)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const refresh = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const result = await apiPost('/status', { refresh: true })
          if (result.error) setNotice({ tone: 'warn', text: `${result.error.code}: ${result.error.message}` })
          await load()
        } catch (e) {
          setError(`${e.code ?? 'REQUEST_FAILED'}: ${e.message}`)
        } finally {
          setBusy(false)
        }
      }

      const refreshAll = async () => {
        setBusy(true)
        setNotice(null)
        try {
          await apiPost('/status', { refresh_all: true })
          await load()
        } catch (e) {
          setError(`${e.code ?? 'REQUEST_FAILED'}: ${e.message}`)
        } finally {
          setBusy(false)
        }
      }

      const demo = async (enabled) => {
        setBusy(true)
        try {
          await apiPost('/demo', { enabled })
          await load()
          if (enabled) setNotice({ tone: 'warn', text: t('state.demoDesc') })
        } catch (e) {
          setError(`${e.code ?? 'REQUEST_FAILED'}: ${e.message}`)
        } finally {
          setBusy(false)
        }
      }

      // 空态导入成功：服务端已写 envs.json 并在后台跑首轮采集；这里立即刷新让环境卡可见，
      // 再后台补一轮 refresh_all（不挂 busy——最多 16 环境 × 15s 超时），完成后自动更新状态。
      const importDone = async (count) => {
        setNotice({ tone: 'info', text: t('envs.import.done', { n: count }) })
        await load()
        apiPost('/status', { refresh_all: true }).catch(() => {}).then(() => { load() })
      }

      // t44 A：弹窗保存。逐字段校验在弹窗内完成；保存 = POST /config v2 整体替换
      //（Host 原子写 envs.json 0600），成功后关闭弹窗、刷新状态并后台跑一轮 refresh_all 让新配置生效；
      // 失败保留弹窗让用户改（Host 未写盘，旧配置不受影响）。
      const saveEnvConfig = async (payload) => {
        setBusy(true)
        setNotice(null)
        try {
          await apiPost('/config', payload)
          setConfigOpen(false)
          setNotice({ tone: 'info', text: t('envs.config.saved') })
          await load()
          apiPost('/status', { refresh_all: true }).catch(() => {}).then(() => { load() })
        } catch (e) {
          setNotice({ tone: 'warn', text: `${e.code ?? 'REQUEST_FAILED'}: ${e.message}` })
        } finally {
          setBusy(false)
        }
      }

      // t44 A：次级兜底——「重新加载配置」让 Host 只读 envs.json、更新 envs/pollIntervalMs 并触发全量采集；
      // 读取失败时 Host 保留旧配置，/state 的 envs_config_error 会渲染面板级错误卡。
      const reloadConfig = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const payload = await apiPost('/config/reload', {})
          setNotice({ tone: 'info', text: t('envs.reload.done', { n: payload?.env_count ?? 0 }) })
        } catch (e) {
          setNotice({ tone: 'warn', text: `${e.code ?? 'REQUEST_FAILED'}: ${e.message}` })
        } finally {
          await load()
          setBusy(false)
        }
      }


      const compare = async () => {
        if (!baselineId || !candidateId) return
        setBusy(true)
        setError(null)
        try {
          const payload = await apiPost('/compare', { baseline_run_id: baselineId, candidate_run_id: candidateId })
          setComparison(payload.comparison)
          const insight = await apiPost('/insight', { baseline_run_id: baselineId, candidate_run_id: candidateId })
          setReport(insight)
        } catch (e) {
          setError(`${e.code ?? 'REQUEST_FAILED'}: ${e.message}`)
        } finally {
          setBusy(false)
        }
      }

      const exportSummary = async () => {
        if (!baselineId || !candidateId) return
        try {
          const payload = await apiPost('/export', { baseline_run_id: baselineId, candidate_run_id: candidateId, format: 'markdown' })
          const blob = new Blob([payload.content], { type: payload.mime ?? 'text/markdown' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = payload.filename ?? 'ascend-compare.md'
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          setNotice({ tone: 'info', text: `${t('action.export')}: ${a.download}` })
        } catch (e) {
          setError(`${e.code ?? 'REQUEST_FAILED'}: ${e.message}`)
        }
      }

      const copySummary = async () => {
        if (!comparison) return
        const lines = [
          `${t('compare.baseline')}: ${baselineId}`,
          `${t('compare.candidate')}: ${candidateId}`,
          `${t(`compare.conclusion.${comparison.summary.conclusion}`)} — ${comparison.summary.message}`,
          ...comparison.metrics.map((m) => `${m.key}: ${fmt(m.baseline)} → ${fmt(m.candidate)} (${m.delta_pct === null ? '—' : `${m.delta_pct}%`}) ${m.verdict}`),
        ]
        try {
          await navigator.clipboard.writeText(lines.join('\n'))
          setNotice({ tone: 'info', text: t('action.copy') })
        } catch {
          setNotice({ tone: 'warn', text: lines.join('\n') })
        }
      }

      const runs = state?.runs ?? []
      const baseline = runs.find((r) => r.run_id === baselineId) ?? null
      const candidate = runs.find((r) => r.run_id === candidateId) ?? null
      const multiEnv = !state?.demo

      const segOptions = EDITION === 'env'
        ? [{ id: 'envs', label: t('deploy.seg.envs'), shortLabel: t('deploy.seg.envsShort') }]
        : [
            { id: 'envs', label: t('deploy.seg.envs'), shortLabel: t('deploy.seg.envsShort') },
            { id: 'deploy', label: t('deploy.seg.deploy'), shortLabel: t('deploy.seg.deployShort') },
            { id: 'tune', label: t('deploy.seg.tune'), shortLabel: t('deploy.seg.tuneShort') },
          ]
      const bottomRow = h(
        'div',
        { style: s.row },
        state?.demo
          ? h('button', { type: 'button', style: s.buttonGhost, onClick: () => demo(false) }, t('action.exitDemo'))
          : h('button', { type: 'button', style: s.buttonGhost, onClick: () => demo(true), disabled: busy }, t('action.loadDemo')),
        h('button', { type: 'button', style: s.buttonGhost, onClick: load }, t('action.refresh')),
      )

      return h(
        'div',
        { style: s.root },
        h('div', { style: s.header }, h('div', { style: { ...s.title, display: 'flex', alignItems: 'center', gap: '6px' } }, h(AscendIcon, { size: 15 }), t('panel.title')), state?.demo ? h(Pill, { tone: 'warn' }, 'DEMO') : null),
        state?.demo ? h('div', { style: s.demoBanner }, t('state.demo')) : null,
        error ? h(StateMsg, { title: t('state.error'), desc: error, tone: 'error' }) : null,
        notice ? h(StateMsg, { title: notice.text, tone: notice.tone === 'warn' ? 'warn' : 'muted' }) : null,
        configOpen ? h(EnvConfigModal, { config: state?.config, busy, onSave: saveEnvConfig, onClose: () => setConfigOpen(false), t }) : null,
        h(SegmentedControl, { value: segment, onChange: setSegment, options: segOptions, t }),
        segment === 'deploy'
          ? h(DeploySegment, { state, t })
          : h(
              'div',
              { style: { display: 'contents' } },
              segment === 'envs'
                ? (!state
                    ? h(Section, { title: t('section.device') }, h('div', { style: s.skeleton }), h('div', { style: { ...s.skeleton, width: '60%' } }), h('div', { style: s.muted }, t('state.loadingDetail')))
                    : multiEnv
                      ? h(EnvsSection, { state, busy, onRefreshAll: refreshAll, onImported: importDone, onOpenConfig: () => setConfigOpen(true), onReloadConfig: reloadConfig, t })
                      : h(DeviceSection, { state, busy, onRefresh: refresh, onDemo: () => demo(true), t }))
                : [
                    h(TuneJobs, { key: 'jobs', t }),
                    importing
                      ? h(ImportSheet, { key: 'sheet', t, demo: Boolean(state?.demo), onClose: () => setImporting(false), onDone: () => { setImporting(false); load() } })
                      : null,
                    h(RunsSection, { key: 'runs', state, baselineId, candidateId, setBaselineId, setCandidateId, onImport: () => setImporting(true), onCompare: compare, busy, t }),
                    comparison ? h(CompareView, { key: 'cmp', comparison, baseline, candidate, onExport: exportSummary, onCopy: copySummary, t }) : null,
                    h(InsightSection, { key: 'ins', report, t }),
                  ],
              // t29 v1.5：环境段去噪——底部演示/刷新行与只读提示只在性能调优段出现（环境段保留「刷新全部」）
              segment === 'tune' ? bottomRow : null,
              segment === 'tune' ? h('div', { style: s.footer }, t('state.readonly')) : null,
            ),
      )
    }



    /* ------------------------------ deploy v2（t30：环境选择 + 基线差异 + 可编辑部署计划） ------------------------------ */

    function useNarrow() {
      const [narrow, setNarrow] = useState(() => {
        try { return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 419px)').matches : false } catch { return false }
      })
      useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return undefined
        const mq = window.matchMedia('(max-width: 419px)')
        const onChange = (event) => setNarrow(event.matches)
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange)
        else if (typeof mq.addListener === 'function') mq.addListener(onChange)
        return () => {
          if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onChange)
          else if (typeof mq.removeListener === 'function') mq.removeListener(onChange)
        }
      }, [])
      return narrow
    }

    function SegmentedControl({ value, onChange, options, t }) {
      const narrow = useNarrow()
      const move = (dir) => {
        const index = options.findIndex((o) => o.id === value)
        const next = options[(index + dir + options.length) % options.length]
        if (next) onChange(next.id)
      }
      return h(
        'div',
        {
          role: 'tablist',
          'aria-label': t('deploy.seg.aria'),
          'data-testid': 'deploy.seg.root',
          style: { display: 'flex', gap: '4px', background: c.layer2, border: `1px solid ${c.borderSoft}`, borderRadius: '8px', padding: '3px' },
          onKeyDown: (event) => {
            if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
            if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
          },
        },
        options.map((option) =>
          h('button', {
            key: option.id,
            type: 'button',
            role: 'tab',
            'aria-selected': value === option.id,
            'data-testid': `${option.id}.seg`,
            style: {
              flex: 1,
              padding: '4px 8px',
              fontSize: '12px',
              borderRadius: '6px',
              cursor: 'pointer',
              border: value === option.id ? `1px solid ${c.border}` : '1px solid transparent',
              background: value === option.id ? c.layer1 : 'transparent',
              color: value === option.id ? c.text : c.textSecondary,
              fontWeight: value === option.id ? 600 : 400,
            },
            onClick: () => onChange(option.id),
          }, narrow ? (option.shortLabel ?? option.label) : option.label),
        ),
      )
    }

    function truncMid(text, max = 48) {
      const value = String(text ?? '')
      if (value.length <= max) return value
      const head = Math.ceil((max - 1) / 2)
      const tail = max - 1 - head
      return `${value.slice(0, head)}…${value.slice(-tail)}`
    }

    // ---------------- 计划规格（纯函数，与服务端校验同口径；服务端仍是唯一真源） ----------------

    const DEPLOY_COMPONENTS = ['vllm', 'vllm-ascend', 'lmcache', 'lmcache-ascend', 'mooncake']
    const DEFAULT_DEPLOY_COMPONENT = 'vllm-ascend'

    function buildSpecPayload(fields) {
      const trim = (v) => String(v ?? '').trim()
      return {
        env_id: trim(fields.envId),
        component: trim(fields.component) || DEFAULT_DEPLOY_COMPONENT,
        candidate: { ref: trim(fields.candRef), commit: trim(fields.candCommit) },
        baseline: { ref: trim(fields.baseRef), commit: trim(fields.baseCommit) },
        model: { path: trim(fields.modelPath), served_name: trim(fields.modelName) },
        params: {
          port: Number(fields.port),
          tensor_parallel: Number(fields.tensorParallel),
          max_num_seqs: Number(fields.maxNumSeqs),
          max_num_batched_tokens: Number(fields.maxBatchedTokens),
          health_timeout_s: Number(fields.healthTimeout),
        },
      }
    }

    function validateDeploySpec(fields) {
      const errors = []
      if (!String(fields.envId ?? '').trim()) errors.push('deploy.v.env')
      const refOk = (v) => /^[A-Za-z0-9._/-]{1,200}$/.test(String(v ?? '').trim())
      const commitOk = (v) => !String(v ?? '').trim() || /^[0-9a-fA-F]{7,40}$/.test(String(v ?? '').trim())
      if (!refOk(fields.candRef)) errors.push('deploy.v.ref')
      if (!commitOk(fields.candCommit)) errors.push('deploy.v.commit')
      if (!refOk(fields.baseRef)) errors.push('deploy.v.ref')
      if (!commitOk(fields.baseCommit)) errors.push('deploy.v.commit')
      const modelPath = String(fields.modelPath ?? '').trim()
      if (!modelPath.startsWith('/') || !/^[A-Za-z0-9_./~-]+$/.test(modelPath)) errors.push('deploy.v.path')
      const int = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max }
      if (!int(fields.port, 1024, 65535)) errors.push('deploy.v.port')
      if (!int(fields.tensorParallel, 1, 8)) errors.push('deploy.v.tp')
      if (!int(fields.maxNumSeqs, 1, 1024)) errors.push('deploy.v.seqs')
      if (!int(fields.maxBatchedTokens, 128, 131072)) errors.push('deploy.v.batched')
      if (!int(fields.healthTimeout, 5, 3600)) errors.push('deploy.v.health')
      if (!DEPLOY_COMPONENTS.includes(String(fields.component ?? '').trim() || DEFAULT_DEPLOY_COMPONENT)) errors.push('deploy.v.component')
      if (errors.length) return { ok: false, errors }
      return { ok: true, spec: buildSpecPayload(fields) }
    }

    // ---------------- 向导字段（受控输入） ----------------

    const DEPLOY_WIZ_TEXT_FIELDS = [
      { key: 'candRef', label: 'deploy.wiz.ref', testid: 'deploy.wiz.candRef', placeholder: 'feat/kv-cache-opt' },
      { key: 'candCommit', label: 'deploy.wiz.commit', testid: 'deploy.wiz.candCommit', placeholder: 'a1b2c3d（可留空）' },
      { key: 'baseRef', label: 'deploy.wiz.ref', testid: 'deploy.wiz.baseRef', placeholder: 'main' },
      { key: 'baseCommit', label: 'deploy.wiz.commit', testid: 'deploy.wiz.baseCommit', placeholder: '（可留空取 HEAD）' },
    ]

    const DEPLOY_WIZ_PARAM_FIELDS = [
      { key: 'port', label: 'deploy.f.port', testid: 'deploy.wiz.port' },
      { key: 'tensorParallel', label: 'deploy.f.tensorParallel', testid: 'deploy.wiz.tensorParallel' },
      { key: 'maxNumSeqs', label: 'deploy.f.maxNumSeqs', testid: 'deploy.wiz.maxNumSeqs' },
      { key: 'maxBatchedTokens', label: 'deploy.f.maxBatchedTokens', testid: 'deploy.wiz.maxBatchedTokens' },
      { key: 'healthTimeout', label: 'deploy.f.healthTimeout', testid: 'deploy.wiz.healthTimeout' },
    ]

    function deployDefaultFields(envs) {
      return {
        envId: (envs?.[0]?.id ?? ''),
        component: DEFAULT_DEPLOY_COMPONENT,
        candRef: '',
        candCommit: '',
        baseRef: 'main',
        baseCommit: '',
        modelPath: '',
        modelName: '',
        port: '18433',
        tensorParallel: '1',
        maxNumSeqs: '256',
        maxBatchedTokens: '8192',
        healthTimeout: '300',
      }
    }

    // ---------------- 计划编辑器 ----------------

    function DeployStepRow({ index, step, canUp, canDown, onChange, onMove, onDelete, t }) {
      const fieldStyle = { ...s.inputText, fontSize: '12px' }
      return h(
        'div',
        {
          'data-testid': `deploy.step.${index}`,
          style: { border: `1px solid ${c.borderSoft}`, borderRadius: '8px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px', background: c.layer2 },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
          h('span', { style: { ...s.num, color: c.textSecondary, fontSize: '11px' } }, `${index + 1}.`),
          h('select', {
            'aria-label': t('deploy.step.scope'),
            'data-testid': `deploy.step.${index}.scope`,
            value: step.scope,
            onChange: (event) => onChange(index, 'scope', event.target.value),
            style: { ...s.select, fontSize: '12px', padding: '2px 4px', width: 'auto' },
          },
            h('option', { value: 'candidate' }, t('deploy.scope.candidate')),
            h('option', { value: 'baseline' }, t('deploy.scope.baseline')),
            h('option', { value: 'both' }, t('deploy.scope.both')),
          ),
          h('div', { style: { flex: 1 } }),
          h('button', { type: 'button', 'data-testid': `deploy.step.${index}.up`, disabled: !canUp, onClick: () => onMove(index, -1), style: { ...s.buttonGhost, fontSize: '11px', padding: '2px 8px' } }, `↑ ${t('deploy.step.up')}`),
          h('button', { type: 'button', 'data-testid': `deploy.step.${index}.down`, disabled: !canDown, onClick: () => onMove(index, 1), style: { ...s.buttonGhost, fontSize: '11px', padding: '2px 8px' } }, `↓ ${t('deploy.step.down')}`),
          h('button', { type: 'button', 'data-testid': `deploy.step.${index}.del`, onClick: () => onDelete(index), style: { ...s.buttonGhost, fontSize: '11px', padding: '2px 8px', color: c.error } }, t('deploy.step.del')),
        ),
        h('input', { type: 'text', 'aria-label': t('deploy.step.title'), 'data-testid': `deploy.step.${index}.title`, value: step.title ?? '', onChange: (event) => onChange(index, 'title', event.target.value), style: fieldStyle, placeholder: t('deploy.step.title') }),
        h('textarea', { 'aria-label': t('deploy.step.detail'), 'data-testid': `deploy.step.${index}.detail`, value: step.detail ?? '', onChange: (event) => onChange(index, 'detail', event.target.value), style: { ...s.textarea, fontSize: '12px', minHeight: '34px' }, rows: 2, placeholder: t('deploy.step.detail') }),
        h('input', { type: 'text', 'aria-label': t('deploy.step.command'), 'data-testid': `deploy.step.${index}.command`, value: step.command ?? '', onChange: (event) => onChange(index, 'command', event.target.value), style: { ...fieldStyle, fontFamily: c.mono }, placeholder: t('deploy.step.command') }),
      )
    }

    function DeployPlanEditor({ draft, editingId, busy, saveError, onChangeStep, onMoveStep, onDeleteStep, onAddStep, onSave, onClose, t }) {
      const refText = (ref) => `${ref.ref}${ref.commit ? `@${ref.commit.slice(0, 12)}` : '@HEAD'}`
      return h(
        'div',
        { 'data-testid': 'deploy.editor', style: { ...s.card, display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: s.sectionTitle }, t('deploy.editor.title')),
          h('span', { style: { ...s.tag, color: c.text, background: c.layer3 } }, draft.title ?? ''),
          h('span', { style: s.tag }, editingId ? t('deploy.editor.saved') : t('deploy.editor.draft')),
          h('span', { style: { ...s.tag, color: c.warn } }, t('deploy.readonly')),
        ),
        h('div', { style: { ...s.muted, fontSize: '12px' } },
          `${draft.env ? envDisplayName(draft.env, null) : ''} · ${draft.component ?? DEFAULT_DEPLOY_COMPONENT} · 候选 ${refText(draft.candidate ?? {})} vs 基线 ${refText(draft.baseline ?? {})} · ${draft.model?.path ?? ''} · :${draft.params?.port ?? ''} tp${draft.params?.tensor_parallel ?? ''}`),
        saveError ? h(StateMsg, { title: saveError.code ?? 'SAVE_FAILED', desc: saveError.message, tone: 'error' }) : null,
        h('div', { style: s.sectionTitle }, t('deploy.editor.steps', { n: (draft.steps ?? []).length })),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          (draft.steps ?? []).map((step, index) =>
            h(DeployStepRow, {
              key: step.id ?? index,
              index,
              step,
              canUp: index > 0,
              canDown: index < (draft.steps ?? []).length - 1,
              onChange: onChangeStep,
              onMove: onMoveStep,
              onDelete: onDeleteStep,
              t,
            }),
          ),
        ),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', { type: 'button', 'data-testid': 'deploy.step.add', onClick: onAddStep, style: { ...s.buttonGhost, fontSize: '12px' } }, `＋ ${t('deploy.step.add')}`),
          h('div', { style: { flex: 1 } }),
          h('button', { type: 'button', onClick: onClose, style: { ...s.buttonGhost, fontSize: '12px' } }, t('deploy.editor.close')),
          h('button', { type: 'button', 'data-testid': 'deploy.editor.save', disabled: busy, onClick: onSave, style: { ...s.buttonPrimary, fontSize: '12px' } }, busy ? t('deploy.editor.saving') : t('deploy.editor.save')),
        ),
      )
    }

    // ---------------- 服务部署分段（v2） ----------------

    function DeploySegment({ state, t }) {
      const envs = (state?.envs ?? []).filter((env) => env && env.enabled !== false)
      // t36：环境编号按 envs 配置列表顺序（与「环境信息」段一致；排序/过滤展示不影响编号）
      const envOrder = new Map((state?.envs ?? []).map((env, i) => [env?.id, i + 1]))
      const [fields, setFields] = useState(() => deployDefaultFields(envs))
      const [specErrors, setSpecErrors] = useState([])
      const [draft, setDraft] = useState(null)
      const [editingId, setEditingId] = useState(null)
      const [draftError, setDraftError] = useState(null)
      const [saveError, setSaveError] = useState(null)
      const [plansData, setPlansData] = useState(null)
      const [plansError, setPlansError] = useState(null)
      const [plansLoading, setPlansLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [regenArmed, setRegenArmed] = useState(false)
      const [delArmed, setDelArmed] = useState(null)
      const [notice, setNotice] = useState(null)

      const loadPlans = async () => {
        setPlansLoading(true)
        try {
          const res = await apiGet('/deploy/plans')
          setPlansData(res?.data ?? null)
          setPlansError(null)
        } catch (error) {
          setPlansData(null)
          setPlansError({ code: error?.code ?? 'NETWORK', message: String(error?.message ?? error) })
        } finally {
          setPlansLoading(false)
        }
      }

      useEffect(() => { loadPlans() }, [])

      const onField = (key) => (event) => {
        setFields({ ...fields, [key]: event.target.value })
        setRegenArmed(false)
      }

      const generate = async () => {
        const check = validateDeploySpec(fields)
        if (!check.ok) { setSpecErrors(check.errors); setDraftError(null); return }
        setSpecErrors([])
        setBusy(true)
        setDraftError(null)
        try {
          const res = await apiPost('/deploy/plans/generate', check.spec)
          setDraft(res?.data?.plan ?? null)
          setEditingId(null)
          setSaveError(null)
          setRegenArmed(false)
        } catch (error) {
          setDraftError({ code: error?.code ?? 'NETWORK', message: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      const onGenerate = () => {
        // 覆盖已有草稿需确认：第一次点击只亮提示，第二次才真正重新生成。
        if (draft && !regenArmed) { setRegenArmed(true); return }
        generate()
      }

      const onChangeStep = (index, key, value) => {
        setDraft({ ...draft, steps: (draft.steps ?? []).map((step, i) => (i === index ? { ...step, [key]: value } : step)) })
      }
      const onMoveStep = (index, dir) => {
        const steps = [...(draft.steps ?? [])]
        const target = index + dir
        if (target < 0 || target >= steps.length) return
        const [moved] = steps.splice(index, 1)
        steps.splice(target, 0, moved)
        setDraft({ ...draft, steps })
      }
      const onDeleteStep = (index) => {
        setDraft({ ...draft, steps: (draft.steps ?? []).filter((_, i) => i !== index) })
      }
      const onAddStep = () => {
        setDraft({ ...draft, steps: [...(draft.steps ?? []), { id: '', title: '新步骤', detail: '', command: '', scope: 'both' }] })
      }

      const onSave = async () => {
        if (!draft) return
        setBusy(true)
        setSaveError(null)
        const payload = {
          plan: {
            env_id: draft.env?.id,
            component: draft.component ?? DEFAULT_DEPLOY_COMPONENT,
            title: draft.title,
            candidate: draft.candidate,
            baseline: draft.baseline,
            model: draft.model,
            params: draft.params,
            steps: draft.steps,
          },
        }
        try {
          const res = editingId
            ? await apiPut(`/deploy/plans/${encodeURIComponent(editingId)}`, payload)
            : await apiPost('/deploy/plans', payload)
          if (res?.error) throw Object.assign(new Error(res.error.message ?? 'save failed'), { code: res.error.code })
          const saved = res?.data?.plan ?? null
          setDraft(saved)
          setEditingId(saved?.id ?? editingId ?? null)
          setNotice({ text: t('deploy.editor.savedNotice', { id: saved?.id ?? '' }), tone: 'ok' })
          loadPlans()
        } catch (error) {
          setSaveError({ code: error?.code ?? 'SAVE_FAILED', message: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      const openPlan = async (planId) => {
        setBusy(true)
        setDraftError(null)
        try {
          const res = await apiGet(`/deploy/plans/${encodeURIComponent(planId)}`)
          setDraft(res?.data?.plan ?? null)
          setEditingId(res?.data?.plan?.id ?? planId)
          setSpecErrors([])
        } catch (error) {
          setDraftError({ code: error?.code ?? 'NETWORK', message: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      const deletePlan = async (planId) => {
        if (delArmed !== planId) { setDelArmed(planId); return } // 删除需确认：两次点击
        setBusy(true)
        try {
          await apiDelete(`/deploy/plans/${encodeURIComponent(planId)}`)
          setNotice({ text: t('deploy.plans.deleted'), tone: 'ok' })
          if (editingId === planId) { setDraft(null); setEditingId(null) }
          setDelArmed(null)
          loadPlans()
        } catch (error) {
          setPlansError({ code: error?.code ?? 'DELETE_FAILED', message: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      const envTier = (env) => env?.occupancy?.state ?? 'unknown'
      const inputStyle = { ...s.inputText, fontSize: '12px' }
      const wizField = (key, labelKey, testid, placeholder) =>
        h('label', { style: { ...s.field, fontSize: '12px' } },
          h('span', { style: { color: c.textSecondary } }, t(labelKey)),
          h('input', { type: 'text', 'data-testid': testid, value: fields[key] ?? '', onChange: onField(key), style: inputStyle, placeholder: placeholder ?? '' }),
        )

      return h(
        'div',
        { 'data-testid': 'deploy.segment', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        notice ? h(StateMsg, { title: notice.text, tone: notice.tone === 'ok' ? 'muted' : 'warn' }) : null,
        h('div', { style: { ...s.muted, fontSize: '12px' } }, t('deploy.readonly')),
        // ①-④ 向导
        h(Section, { title: t('deploy.wiz.title') },
          h('div', { style: { ...s.muted, fontSize: '11px', marginBottom: '6px' } }, t('deploy.envsHint')),
          envs.length === 0
            ? h(StateMsg, { title: t('deploy.envNone'), tone: 'warn' })
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' } },
                envs.map((env) => {
                  const tier = envTier(env)
                  const tierText = t(`envs.tier.${tier}`)
                  const hot = tier === 'partial' || tier === 'busy'
                  return h(
                    'label',
                    {
                      key: env.id,
                      'data-testid': `deploy.wiz.env.${env.id}`,
                      style: { display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '4px 8px', border: `1px solid ${fields.envId === env.id ? c.brand : c.borderSoft}`, borderRadius: '8px', cursor: 'pointer', background: fields.envId === env.id ? c.layer2 : 'transparent' },
                    },
                    h('input', { type: 'radio', name: 'deploy-wiz-env', checked: fields.envId === env.id, onChange: onField('envId'), value: env.id, style: { marginTop: '2px' } }),
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                      h('span', { style: { fontSize: '12px', color: c.text } }, envDisplayName(env, envOrder.has(env.id) ? t('envs.fallbackName', { n: envOrder.get(env.id) }) : null)),
                      h('span', { style: { ...s.muted, fontSize: '11px' } }, `${t('envs.f.mode')}：${env.mode === 'ssh' ? t('envs.modeSsh') : t('envs.modeLocal')} · ${tierText}`),
                      hot ? h('span', { style: { fontSize: '11px', color: c.warn } }, t('deploy.envBusy', { tier: tierText })) : null,
                    ),
                  )
                }),
              ),
          h('div', { style: { ...s.sectionTitle, fontSize: '12px' } }, t('deploy.wiz.baseline')),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '6px', marginBottom: '8px' } },
            // t44 B：代码组件下拉（基线/候选同一组件；切换组件不重置已填 ref）
            h('label', { style: { ...s.field, fontSize: '12px' } },
              h('span', { style: { color: c.textSecondary } }, t('deploy.wiz.component')),
              h('select', { 'data-testid': 'deploy.wiz.component', value: fields.component ?? DEFAULT_DEPLOY_COMPONENT, onChange: onField('component'), 'aria-label': t('deploy.wiz.component'), style: { ...s.select, fontSize: '12px' } },
                DEPLOY_COMPONENTS.map((comp) => h('option', { key: comp, value: comp }, comp)),
              ),
            ),
            ...DEPLOY_WIZ_TEXT_FIELDS.filter((field) => field.key.startsWith('base')).map((field) => wizField(field.key, field.label, field.testid, field.placeholder)),
          ),
          h('div', { style: { ...s.sectionTitle, fontSize: '12px' } }, t('deploy.wiz.candidate')),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '6px', marginBottom: '8px' } },
            ...DEPLOY_WIZ_TEXT_FIELDS.filter((field) => field.key.startsWith('cand')).map((field) => wizField(field.key, field.label, field.testid, field.placeholder)),
          ),
          h('div', { style: s.sectionTitle, fontSize: '12px' }, t('deploy.wiz.model')),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '6px', marginBottom: '8px' } },
            wizField('modelPath', 'deploy.wiz.modelPath', 'deploy.wiz.modelPath', '/data/models/Qwen3-8B'),
            wizField('modelName', 'deploy.wiz.modelName', 'deploy.wiz.modelName', ''),
            ...DEPLOY_WIZ_PARAM_FIELDS.map((field) => wizField(field.key, field.label, field.testid)),
          ),
          specErrors.length > 0 ? h('div', { style: s.notice }, specErrors.map((key) => h('div', { key }, `· ${t(key)}`))) : null,
          draftError ? h(StateMsg, { title: draftError.code ?? 'GENERATE_FAILED', desc: draftError.message, tone: 'error' }) : null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            regenArmed ? h('span', { style: { fontSize: '11px', color: c.warn } }, t('deploy.wiz.regenHint')) : null,
            h('button', { type: 'button', 'data-testid': 'deploy.wiz.generate', disabled: busy || envs.length === 0, onClick: onGenerate, style: { ...s.buttonPrimary, fontSize: '12px' } }, busy ? t('deploy.wiz.generating') : t('deploy.wiz.generate')),
          ),
        ),
        // 编辑器（草稿或已打开的保存计划）
        draft
          ? h(DeployPlanEditor, {
              draft,
              editingId,
              busy,
              saveError,
              onChangeStep,
              onMoveStep,
              onDeleteStep,
              onAddStep,
              onSave,
              onClose: () => { setDraft(null); setEditingId(null); setSaveError(null); setRegenArmed(false) },
              t,
            })
          : null,
        // 已保存计划
        h(Section, { title: t('deploy.plans.title'), extra: h('button', { type: 'button', onClick: () => loadPlans(), style: { ...s.buttonGhost, fontSize: '11px', padding: '3px 10px' } }, t('deploy.state.refresh')) },
          plansLoading ? h('div', { 'data-testid': 'deploy.plans.loading', style: s.skeleton }, '…') : null,
          plansError ? h(StateMsg, { title: plansError.code ?? 'LOAD_FAILED', desc: plansError.message, tone: 'error' }) : null,
          !plansLoading && !plansError && (plansData?.plans ?? []).length === 0
            ? h('div', { style: s.muted }, t('deploy.plans.empty'))
            : null,
          (plansData?.plans ?? []).map((plan) =>
            h(
              'div',
              {
                key: plan.id,
                'data-testid': `deploy.plan.${plan.id}`,
                style: { ...s.card, flexDirection: 'row', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '8px 10px' },
              },
              h('div', { style: { flex: 1, minWidth: '160px', display: 'flex', flexDirection: 'column', gap: '2px' } },
                h('span', { style: { fontSize: '12px', color: c.text, fontWeight: 600 } }, plan.title ?? plan.id),
                h('span', { style: { ...s.muted, fontSize: '11px' } },
                  `${plan.env ? envDisplayName(plan.env, null) : ''} · ${t('deploy.plans.steps', { n: plan.step_count ?? (plan.steps ?? []).length })} · ${t('deploy.plans.updated', { time: timeText(plan.updated_at) })}`),
              ),
              h('button', { type: 'button', 'data-testid': `deploy.plan.${plan.id}.open`, onClick: () => openPlan(plan.id), style: { ...s.buttonGhost, fontSize: '11px', padding: '3px 10px' } }, t('deploy.plans.open')),
              h('button', { type: 'button', 'data-testid': `deploy.plan.${plan.id}.del`, onClick: () => deletePlan(plan.id), style: { ...s.buttonGhost, fontSize: '11px', padding: '3px 10px', color: delArmed === plan.id ? c.error : c.textSecondary } }, delArmed === plan.id ? t('deploy.plans.delHint') : t('deploy.plans.del')),
            ),
          ),
        ),
        h('div', { style: s.footer }, t('deploy.footer')),
      )
    }


    function TuneJobs({ t }) {
      const [specText, setSpecText] = useState(() => JSON.stringify(DEFAULT_TUNE_SPEC, null, 2))
      const [plan, setPlan] = useState(null)
      const [dry, setDry] = useState(null)
      const [jobId, setJobId] = useState(null)
      const [job, setJob] = useState(null)
      const [report, setReport] = useState(null)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)

      const parseSpec = () => JSON.parse(specText)

      const run = async (fn) => {
        setError(null)
        setBusy(true)
        try {
          await fn()
        } catch (e) {
          setError(`${e.code ?? 'REQUEST_FAILED'}: ${e.message}`)
        } finally {
          setBusy(false)
        }
      }

      const preview = () =>
        run(async () => {
          const spec = parseSpec()
          const planned = await apiPost('/tuning/plan', { spec })
          if (planned.error) throw Object.assign(new Error(planned.error.message), { code: planned.error.code })
          const receipt = await apiPost('/tuning/run', {
            action: 'dry_run',
            plan_id: planned.data.plan.plan_id,
            plan_hash: planned.data.plan.plan_hash,
          })
          if (receipt.error) throw Object.assign(new Error(receipt.error.message), { code: receipt.error.code })
          setPlan(planned.data.plan)
          setDry(receipt.data)
          setJobId(null)
          setJob(null)
          setReport(null)
          setNotice(t('tune.realDisabled'))
        })

      const start = () =>
        run(async () => {
          if (!plan) {
            setError(t('tune.noJob'))
            return
          }
          const res = await apiPost('/tuning/run', {
            action: 'Start',
            plan_id: plan.plan_id,
            plan_hash: plan.plan_hash,
            idempotency_key: `ui-${Date.now()}`,
          })
          if (res.error && !res.data?.job_id) {
            throw Object.assign(new Error(res.error.message), { code: res.error.code })
          }
          const id = res.data?.job_id
          if (!id) {
            setError(t('tune.blocked'))
            return
          }
          setJobId(id)
          setReport(null)
          setNotice(t('tune.waiting'))
          const page = await apiGet(`/tuning/status?job_id=${encodeURIComponent(id)}&include_trials=true`)
          setJob(page.job ?? null)
        })

      const pollOnce = useCallback(async () => {
        if (!jobId) return null
        const page = await apiGet(`/tuning/status?job_id=${encodeURIComponent(jobId)}&include_trials=true`)
        setJob(page.job ?? null)
        return page.job ?? null
      }, [jobId])

      const control = (action) =>
        run(async () => {
          if (!jobId) return
          const res = await apiPost('/tuning/run', { action, job_id: jobId })
          if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code })
          await pollOnce()
        })

      const loadReport = () =>
        run(async () => {
          if (!jobId) return
          const page = await apiGet(`/tuning/report?job_id=${encodeURIComponent(jobId)}`)
          setReport(page.report ?? null)
        })

      useEffect(() => {
        if (!jobId) return undefined
        let alive = true
        let timer = null
        const terminal = new Set(['completed', 'failed', 'cancelled', 'recovery_required'])
        const tick = async () => {
          try {
            const state = await pollOnce()
            if (!alive) return
            if (state && terminal.has(state.state)) {
              const page = await apiGet(`/tuning/report?job_id=${encodeURIComponent(jobId)}`)
              if (alive) setReport(page.report ?? null)
              return
            }
          } catch {
            /* 轮询失败时保留上一次状态，不制造“已完成”的假象 */
          }
          if (alive) timer = setTimeout(tick, 1500)
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [jobId, pollOnce])

      const budget = plan?.budget_estimate ?? null
      const trials = job?.trials ?? []
      const terminal = job && ['completed', 'failed', 'cancelled', 'recovery_required'].includes(job.state)
      const recommended = report?.recommended ?? null
      const best = report?.confirmed_best ?? report?.provisional_best ?? null

      return h(
        'div',
        { style: { ...s.root, gap: '8px' }, 'data-testid': 'tune.jobs' },
        h('div', { style: s.sectionTitle }, t('tune.jobsTitle')),
        h(StateMsg, { title: t('tune.realDisabled'), tone: 'muted' }),
        error ? h(StateMsg, { title: t('state.error'), desc: error, tone: 'error' }) : null,
        notice ? h(StateMsg, { title: notice, tone: 'muted' }) : null,
        h(
          Section,
          { title: t('tune.specTitle') },
          h('div', { style: s.muted }, t('tune.specHint')),
          h('textarea', {
            'aria-label': t('tune.specTitle'),
            value: specText,
            spellCheck: false,
            onChange: (event) => setSpecText(event.target.value),
            style: { ...s.card, minHeight: '220px', width: '100%', boxSizing: 'border-box', fontFamily: 'var(--dsw-alias-mono-font-family, ui-monospace, monospace)', fontSize: '11px', color: s.card.color, resize: 'vertical' },
          }),
          h(
            'div',
            { style: s.row },
            h('button', { type: 'button', style: s.buttonPrimary, disabled: busy, onClick: preview }, t('tune.preview')),
            h('button', { type: 'button', style: s.button, disabled: busy || !plan, onClick: start }, t('tune.start')),
          ),
        ),
        plan
          ? h(
              Section,
              { title: t('tune.previewTitle'), extra: h(Pill, { tone: 'muted' }, t('tune.executor') + ' ' + plan.executor) },
              h(
                'div',
                { style: s.row },
                h(Pill, { tone: 'muted' }, t('tune.candidates', { value: plan.candidates.length })),
                h(Pill, { tone: plan.pruned?.length ? 'warn' : 'muted' }, t('tune.pruned', { value: plan.pruned?.length ?? 0 })),
                budget ? h(Pill, { tone: budget.fit === 'yes' ? 'success' : 'warn' }, t('tune.fit', { value: budget.fit })) : null,
              ),
              budget ? h('div', { style: s.muted }, t('tune.timeoutUpper', { value: budget.timeout_upper_bound_s })) : null,
              plan.blockers?.length
                ? h(
                    'div',
                    { style: s.notice },
                    h('div', { style: { fontWeight: 600 } }, t('tune.blockers')),
                    ...plan.blockers.map((b) => h('div', { key: b.code, style: s.code }, `${b.code}: ${b.message}`)),
                    h('div', { style: s.muted }, t('tune.blocked')),
                  )
                : null,
              h('div', { style: s.muted }, `${t('tune.planHash')}: ${String(plan.plan_hash ?? '').slice(0, 16)}…`),
              ...(plan.commands_preview ?? []).slice(0, 2).map((cmd, index) =>
                h('div', { key: `cmd-${index}`, style: s.code }, Array.isArray(cmd) ? cmd.join(' ') : String(cmd)),
              ),
              dry ? h('div', { style: s.muted }, `dry-run: ${dry.action} · ${dry.job_state}`) : null,
            )
          : null,
        h(
          Section,
          { title: jobId ? t('tune.jobState', { value: job?.state ?? '…' }) : t('tune.report') },
          !jobId
            ? h('div', { style: s.muted }, t('tune.noJob'))
            : h(
                'div',
                { style: { ...s.card, gap: '8px' } },
                job
                  ? h(
                      'div',
                      { style: s.row },
                      h(Pill, { tone: 'muted' }, `${t('tune.executor')}: ${job.executor}`),
                      h(Pill, { tone: terminal && job.state === 'completed' ? 'success' : terminal ? 'danger' : 'muted' }, job.state),
                      job.is_demo ? h(Pill, { tone: 'warn' }, 'DEMO') : null,
                    )
                  : null,
                job?.progress
                  ? h('div', { style: s.muted }, t('tune.progress', {
                      done: job.progress.completed_trials,
                      total: job.progress.total_trials,
                      ok: job.counts?.succeeded ?? 0,
                      bad: (job.counts?.failed ?? 0) + (job.counts?.timeout ?? 0) + (job.counts?.invalid_metrics ?? 0),
                    }))
                  : null,
                job?.failure_reason
                  ? h(StateMsg, { title: t('tune.failed'), desc: `${job.failure_reason.code}: ${job.failure_reason.message}`, tone: 'error' })
                  : null,
                h(
                  'div',
                  { style: s.row },
                  h('button', { type: 'button', style: s.button, disabled: busy || terminal || !job, onClick: () => control('Pause') }, t('tune.pause')),
                  h('button', { type: 'button', style: s.button, disabled: busy || terminal || !job, onClick: () => control('Resume') }, t('tune.resume')),
                  h('button', { type: 'button', style: s.button, disabled: busy || terminal || !job, onClick: () => control('Stop') }, t('tune.stop')),
                  h('button', { type: 'button', style: s.buttonGhost, disabled: busy, onClick: loadReport }, t('tune.report')),
                ),
                trials.length
                  ? h(
                      'div',
                      { style: s.table },
                      h(
                        'div',
                        { style: { ...s.tr, gridTemplateColumns: '1.1fr 1.3fr 1fr 0.9fr 0.9fr' } },
                        h('span', { style: s.th }, t('tune.trial')),
                        h('span', { style: s.th }, t('tune.params')),
                        h('span', { style: s.th }, t('tune.state')),
                        h('span', { style: s.th }, t('tune.output')),
                        h('span', { style: s.th }, t('tune.ttft')),
                      ),
                      ...trials.slice(-14).map((trial) =>
                        h(
                          'div',
                          { key: trial.trial_id, style: { ...s.tr, gridTemplateColumns: '1.1fr 1.3fr 1fr 0.9fr 0.9fr' } },
                          h('span', { style: s.code }, trial.trial_id.replace(/^trial_/, '')),
                          h('span', { style: s.code }, `seq=${trial.params?.max_num_seqs ?? '—'} btok=${trial.params?.max_num_batched_tokens ?? '—'}`),
                          h('span', { style: s.code }, trial.state),
                          h('span', { style: s.code }, fmt(trial.aggregate?.metrics?.output_throughput_tps?.value ?? null)),
                          h('span', { style: s.code }, fmt(trial.aggregate?.metrics?.ttft_p99_ms?.value ?? null)),
                        ),
                      ),
                    )
                  : job
                    ? h('div', { style: s.muted }, t('tune.waiting'))
                    : null,
              ),
        ),
        report
          ? h(
              Section,
              { title: t('tune.report') },
              recommended
                ? h(
                    'div',
                    { style: s.card },
                    h('div', { style: { fontWeight: 600 } }, t('tune.recommended')),
                    h('div', { style: s.code }, `seq=${recommended.params?.max_num_seqs} · batched_tokens=${recommended.params?.max_num_batched_tokens}`),
                    h('div', { style: s.muted }, recommended.status === 'confirmed' ? t('tune.confirmed') : t('tune.provisional')),
                  )
                : h('div', { style: s.muted }, t('tune.reportMissing')),
              best?.metrics
                ? h('div', { style: s.muted }, `output ${fmt(best.metrics.output_throughput_tps?.value)} tps · TTFT p99 ${fmt(best.metrics.ttft_p99_ms?.value)} ms · TPOT p99 ${fmt(best.metrics.tpot_p99_ms?.value)} ms · success ${fmt(best.metrics.success_rate_pct?.value)}%`)
                : null,
              report.pareto?.length ? h('div', { style: s.muted }, t('tune.pareto', { value: report.pareto.length })) : null,
              report.cleanup ? h('div', { style: s.muted }, t('tune.cleanup', { value: report.cleanup.state ?? '—' })) : null,
              (report.limitations ?? []).length
                ? h('div', { style: s.footer }, t('tune.limitations') + '：' + report.limitations.join('；'))
                : null,
            )
          : null,
        h('div', { style: s.footer }, t('state.readonly')),
      )
    }

    function TabTitle({ t }) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } }, h(AscendIcon, { size: 13 }), t('panel.title'))
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      // 仅供测试使用：无头渲染占用视图组件与判定函数（不参与 DSH 运行时）
      __test: { chipOccState, deriveEnvOccupancy, envDisplayName, envHostTag, stripUserPrefix, cardNumbering, EnvsSection, EnvBlock, ConfigBar, OccupancyPill, ChipStrip, OccProcRow, EnvMetricSummary, EnvInlineSummary, CardBlock, ChipRow, ImportGuide, AscendIcon, TabTitle, Panel, TuneJobs, SegmentedControl, DeploySegment, DeployStepRow, DeployPlanEditor, validateDeploySpec, buildSpecPayload, deployDefaultFields, DEPLOY_COMPONENTS, DEFAULT_DEPLOY_COMPONENT, EnvConfigModal, EnvConfigRow, validateEnvForm, zh, en },
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ascend-perf: dictionaries')
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (native) => {
          const t = native.locale.bind(NS)
          ctx.effect(
            () =>
              native.sidebarRightTabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                multiple: false,
                keepMounted: false,
                title: () => t('panel.title'),
                guide: [
                  {
                  icon: AscendIcon,
                    id: TAB_ID,
                    order: 70,
                    title: () => t('panel.title'),
                    description: () => t('panel.guideDescription'),
                  },
                ],
              }),
            'ascend-perf: tab type',
          )
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, order: 70 }, Panel),
          )
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS }, TabTitle),
          )
          ctx.effect(() => {
            if (typeof window === 'undefined' || !window.sessionStorage) return undefined
            let tries = 0
            let timer = null
            const attempt = () => {
              try {
                // 用户上次已经打开过时不再抢焦点；但如果 tab 仍处于活动态，
                // 页面刷新后右侧栏可能是折叠的，必须展开，否则面板“看得见但不可见”。
                const active = typeof native.sidebarRight.active === 'function'
                  ? native.sidebarRight.active()
                  : undefined
                if (active?.kind === TAB_KIND) {
                  if (typeof native.sidebarRight.isExpanded === 'function' && !native.sidebarRight.isExpanded()) {
                    native.sidebarRight.toggleExpanded()
                  }
                  return
                }
                native.sidebarRight.openTab(TAB_KIND)
                if (typeof native.sidebarRight.isExpanded === 'function' && !native.sidebarRight.isExpanded()) {
                  native.sidebarRight.toggleExpanded()
                }
              } catch {
                // 无已打开会话时 openTab 会抛错：延长重试窗口（约 2 分钟），
                // 覆盖“页面加载后才打开第一个会话”的场景。
                if (++tries < 150) timer = window.setTimeout(attempt, 800)
              }
            }
            timer = window.setTimeout(attempt, 400)
            return () => { if (timer !== null) window.clearTimeout(timer) }
          }, 'ascend-perf: auto open')
        })
      },
    }
  },
})
