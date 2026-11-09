# dsh-ascend-perf · 昇腾环境监控

DeepSeek Harness（DSH）的**只读**昇腾 NPU 多环境占用看板。第一个发布版只包含「环境信息」视图：服务部署与性能调优仍在本地打磨，不在此版本界面中。

## 功能

- **多环境**：环境来自 `envs.json`，配置几个就显示几个；不再把主机地址写死在页面里。
- **只读采集**：本机或 SSH 执行 `npu-smi`，每环境一条 SSH 连接（一次取 `info`，再按卡号取 `usages`）。
- **占用视图**：每个环境显示空闲 / 部分占用 / 高负载；占用进程按名称聚合；逐卡显示 910B 的 1–8 或 910C 的 1–16 编号，展开可看每卡 chip 的温度、功耗、AICore、HBM、进程显存。
- **静默采集**：默认每 5 分钟采集一次，可在「环境配置」弹窗里改 1–60 分钟；另有「刷新全部」与单环境刷新。
- **连接抖动**：SSH 255 先重试一次；连续失败保留上次成功快照并标记「连接抖动 · 上次 HH:MM」，无历史才显示连接失败。
- **零远端写入**：不启停服务/容器，不跑 benchmark，不修改 NPU 状态，不写远端文件。

## 安装

```sh
dsh plugin --profile web add "github:newpage1/ascend-npu-profiling-tuning-skill#path:/dsh-ascend-perf"
```

装完刷新 Web 页面，右侧栏会出现「昇腾环境监控」tab（首次会尝试自动打开）。

卸载：

```sh
dsh plugin --profile web remove dsh-ascend-perf
```

## 配置

唯一真源是 `~/.config/ascend-perf/envs.json`（0600）。首次启动时插件会：

1. 优先迁移旧 `~/.local/share/dsh-ascend-perf/settings.json`；
2. 否则从 `~/.config/ascend-perf/npu-ssh.md` / `npu.env` 播种已有登录目标；
3. 都没有则生成一个空环境列表，页面提供「环境配置」弹窗逐字段添加。

字段：

```json
{
  "version": 2,
  "pollIntervalMs": 300000,
  "envs": [
    {
      "id": "env-1",
      "name": "集群A",
      "mode": "ssh",
      "hostAlias": "root@10.0.0.5",
      "npuSmiPath": "npu-smi",
      "timeoutMs": 15000,
      "enabled": true
    }
  ]
}
```

- `mode`: `local` 或 `ssh`；`hostAlias` 支持 `~/.ssh/config` 的 Host 别名或 `user@host`。
- 插件不保存密码/私钥，使用系统默认密钥与 `~/.ssh/config`；不写 `known_hosts`。
- 远端账号需能执行 `npu-smi`，且已接受过 host key。
- UI 只显示 `环境 N · IP`（或自定义名 · IP），编辑态才显示完整 `user@host`。

## 只读命令

SSH 远端只执行固定白名单：

```sh
npu-smi info
npu-smi info -t usages -i <card-id>
```

卡号由 `npu-smi info` 输出中的数字列提取，命令参数经 `quotePosix` 转义；`BatchMode=yes`、`StrictHostKeyChecking=yes`、`ConnectTimeout=8`、`ServerAliveInterval=5`、`ServerAliveCountMax=2`。

## 环境要求

- DSH Web 0.2.x，Node.js 20+；
- 采集端有 `npu-smi`（CANN 工具链）；
- 昇腾 910B（8 卡/16 chip）或 910C（16 卡）优先；其他型号按实际卡数展示。

## 已知边界

- 本版本不提供部署与调优界面；
- 进程信息依赖 `npu-smi info -t usages` 的输出；驱动不返回进程时，以 HBM/AICore 阈值判断占用，并标注未知；
- 页面不读取 `envs.json` 以外的凭据文件，也不会把 SSH 私钥写入插件目录。

## License

MIT
