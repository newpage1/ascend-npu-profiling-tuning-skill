# dsh-ascend-perf · 昇腾环境监控与服务部署

DeepSeek Harness（DSH）的昇腾 NPU 多环境占用看板 + 受控 vLLM 容器服务页。

## 功能

### 环境信息（只读）
- 环境来自 `envs.json`，配置几个就显示几个。
- 本机或 SSH 只读执行 `npu-smi`，每环境一条 SSH 连接。
- 空闲 / 部分占用 / 高负载；占用进程聚合；逐卡逐 chip 温度、功耗、AICore、HBM、进程显存。
- 5 分钟静默采集（1–60 分钟可配）、手动刷新、连接抖动保留上次快照。

### 服务部署（默认只预览）
- 选择环境、端口、镜像、模型根目录/相对路径、代码目录、空闲 NPU chip。
- 预览生成完整 `docker run` 命令、容器名与确认令牌，不执行任何操作。
- 真实启动受双门控制：`envs.json` 的 `deploy.allowRealExecution=true` + 预览返回的确认令牌（10 分钟有效）。
- 只操作本插件创建的 `dsh-apf-svc-*` 容器；停止只停止/删除自己的容器，不碰其他用户容器。
- 启动前检查 chip 空闲、端口、镜像、模型目录、SSH 可达；健康检查超时自动清理自己的容器。
- 可选「按分支构建后启动」：容器内 `git clone/checkout` + `pip install -e`；默认关闭，构建失败不会启动服务。

## 安装

```sh
dsh plugin --profile web add "github:newpage1/ascend-npu-profiling-tuning-skill#path:/dsh-ascend-perf"
```

装完刷新 Web 页面，右侧栏出现「昇腾环境监控与服务部署」tab。

卸载：

```sh
dsh plugin --profile web remove dsh-ascend-perf
```

## 配置

唯一真源：`~/.config/ascend-perf/envs.json`（0600）。`deploy` 段示例：

```json
{
  "version": 2,
  "pollIntervalMs": 300000,
  "deploy": {
    "allowRealExecution": false,
    "privilegedHosts": ["b01"]
  },
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

- `mode`: `local` / `ssh`；`hostAlias` 支持 `~/.ssh/config` 别名或 `user@host`。
- 插件不保存密码/私钥；使用系统默认密钥与 `~/.ssh/config`。
- `deploy.privilegedHosts` 只对驱动 ≥ 26.0.rc1 且明确信任的环境启用 `--privileged` 隔离配方；其他环境用普通 `--device` 安全配方。
- 真实启动默认关闭。打开 `allowRealExecution` 后也仍需预览 + 确认令牌，且只允许空闲 chip。

## 安全边界

- 采集只执行固定白名单：`npu-smi info`、`npu-smi info -t usages -i <id>`。
- 容器只挂选中 NPU 设备、只读挂驱动/模型/代码；端口只绑 `127.0.0.1`。
- 不执行 `docker stop` 其他容器，不删除非 `dsh-apf-svc-*` 容器。
- 真实启动会产生远端进程与写操作；请只在有维护窗口的环境使用。

## 环境要求

- DSH Web 0.2.x，Node.js 22+；
- 采集端有 `npu-smi`；
- 服务部署需要远端有 Docker 与昇腾镜像；镜像/模型需提前准备（或勾选构建模式）。

## 已知边界

- 构建模式会在容器内 clone/install，首次可能 10–60 分钟且依赖容器内网络；vllm/mooncake 全量重编译不保证成功。
- 只支持 SSH 模式环境做容器服务；本机模式仅支持环境信息。
- 进程信息依赖驱动输出；无进程时按 HBM/AICore 阈值判断并标注未知。

## License

MIT
