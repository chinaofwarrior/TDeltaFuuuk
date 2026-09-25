# TDeltaFuuuk

Windows 实时小队战术 Hub + 绿色 Agent（面向《三角洲行动》的小队协同工具）。

本项目是 `chinaofwarrior/TDeltaFuuuk` 的工程实现，严格对齐两份设计文档：
- **《原理和数据来源.md》**：数据来源边界、实时 vs 历史数据、provenance 纪律
- **《开发方案.md》**：Provider 插件体系、Observation 模型、Track/融合、战术引擎、三个工程批次

## 技术选型说明

设计文档使用 Go 术语（`.go` 文件、`internal/`、`cmd/hub`）。但本机环境只有 Node.js，故改用 **Node.js 22（零外部依赖，仅内置模块）** 实现，功能一一对应：

| 设计文档 | 本实现 |
| --- | --- |
| `cmd/hub` + `cmd/agent` | `src/hub.js` + `src/agent.js` |
| `internal/observations` | `src/core/observation.js` |
| `internal/clock` | `src/core/clock.js` |
| `internal/providers`（C ABI DLL loader） | `src/providers/`（子进程 NDJSON 协议，进程级崩溃隔离） |
| `internal/fusion` + `internal/tracks` | `src/fusion/engine.js` |
| `internal/tactics` | `src/tactics/engine.js` |
| `internal/transport` | `src/transport/net.js` |
| `internal/adapters/dfapi` | `src/adapters/dfapi.js` |
| Web 网页 | `webui/index.html`（Canvas 地图 + SSE 实时推送） |

C ABI 参考头文件保留在 `sdk/tdf_provider.h`，供未来 C/C++/Rust 原生 Provider 使用。

## 目录结构

```
TDeltaFuuuk/
├── package.json
├── src/
│   ├── hub.js                 # Hub 主程序
│   ├── agent.js               # Agent 主程序
│   ├── util.js                # ID/配置/凭证/日志
│   ├── core/                  # observation、clock、ringbuffer
│   ├── providers/             # Provider 协议 + 管理器 + 手动 Provider
│   ├── fusion/engine.js       # 融合 + 航迹引擎
│   ├── tactics/engine.js      # 战术引擎
│   ├── transport/net.js       # UDP 发现 + ingest + Hub 客户端
│   └── adapters/dfapi.js      # DF 账号 Adapter
├── examples/example-provider.js  # 示例 Provider（手动运行）
├── webui/index.html           # 战术看板（自包含）
├── sdk/tdf_provider.h         # C ABI 参考头
└── scripts/                   # check.js / build.ps1
```

## 快速开始

```powershell
# 校验所有模块（无编译）
node scripts/check.js

# 启动 Hub（自动生成 tdelta-hub.json 与共享 Token）
node src/hub.js
# 控制台: http://127.0.0.1:17888

# 启动 Agent（自动发现 Hub，或配置 hubUrl）
node src/agent.js

# 直接运行示例 Provider（演示 20Hz 位置流，不会被 Agent 自动加载）
node examples/example-provider.js
```

首次启动 Hub 会在控制台打印共享 Token，队友的 `TDeltaAgent.config.json` 需填入该 Token 以通过上报鉴权。

## 端口约定

| 端口 | 用途 |
| --- | --- |
| 17888 | Hub 控制台 HTTP（仅 loopback） |
| 17889 | 队友上报（0.0.0.0，需共享 Token） |
| 17892 | 局域网自动发现（UDP 广播） |
| 17890 | Agent 本机 UDP ingest |
| 17891 | Agent 本机 HTTP ingest |
| 17900 | ManualProvider HTTP 端点 |

## 数据接入

任何你有权使用的本机数据源，都可以写入统一 JSON（自动转成 Observation）：

```http
POST http://127.0.0.1:17891/ingest          # Agent 本机
POST http://127.0.0.1:17888/api/ingest      # Hub 直接输入（需 Token）
UDP  -> 127.0.0.1:17890                     # Agent 本机数据报
```

示例 Observation：

```json
{
  "type": "ENTITY_STATE",
  "subject": { "kind": "SELF", "id": "T1" },
  "position": { "x": 100, "y": 100, "z": 0, "floor": 1 },
  "heading": 90,
  "hp": 86, "max_hp": 100,
  "source": "TEAM_SELF_REPORT",
  "confidence": 1.0
}
```

位置与装备支持稀疏更新：低频装备帧不带 `x/y` 时不会清空位置，反之亦然。

## Provider 协议

Provider 是独立子进程，通过 stdout 输出 NDJSON（每行一个 JSON）：

```
{"type":"hello","provider":"ExampleProvider","abi":1,"capabilities":["SELF_POSITION"],"max_rate_hz":20}
{"type":"heartbeat"}
{"type":"observation","observation":{...}}
{"type":"batch","observations":[{...},{...}]}
```

管理器（`src/providers/manager.js`）负责：ABI 校验、能力契约、心跳健康检查、崩溃自动重启。写一个新的数据源 Provider 只需新建一个 `*.provider.js` 放进 `providersDir`，无需改动 Hub。

## DF Account Adapter

`src/adapters/dfapi.js` 实现社区 API 的扫码登录与资料/战绩/地图/资产/经济/物品接口（`personalinfo`、`record`、`mapStats`、`money`、`collection` 等）。需在 `tdelta-hub.json` 配置 `dfBaseUrl` 指向可用的社区后端实例，扫码成功获得 `frameworkToken` 后保存到本地加密凭证文件（默认 AES-256-GCM + 机器盐；生产可替换为 Windows DPAPI/Credential Manager）。

## 安全边界

本项目的 Adapter 只接受明确送入的 telemetry，**不实现**游戏进程注入、内存扫描、DMA、反作弊绕过，也不提取正常玩家不可见的隐藏敌人信息。核心竞争力是实时多源融合、队友协同与战术决策，而非依赖不可维护的游戏内部地址。详见两份设计文档。
