# Telemetry Protocol v1

## Agent 输入

Agent 接收 `Frame` JSON：

- UDP：`127.0.0.1:17890`
- HTTP：`POST http://127.0.0.1:17891/ingest`
- 可选：`TDeltaAgent.exe -stdin`，每行一个 JSON Frame。

单个消息上限 2 MiB。未知 JSON 字段会被忽略，以便上游 Adapter 平滑升级。

## Agent → Hub

Agent 发送：

```json
{
  "agent_id": "PC-ALICE",
  "name": "二号",
  "role": "member",
  "frame": { }
}
```

目标：

```text
POST http://<hub>:17889/agent/frame
Authorization: Bearer <shared-token>
```

Hub 默认 5 秒没有新 Agent Frame 即把该 Agent 从在线快照淘汰。

## Hub → Browser

Hub 使用 Server-Sent Events：

```text
GET http://127.0.0.1:17888/events
```

默认 50ms 合并/广播一次最新队伍快照。SSE 自带自动重连，不需要浏览器插件。

## 局域网发现

Agent 在 Hub 未写死时向 UDP `17892` 广播：

```text
TDF_DISCOVER_V1
```

Hub 返回：

```json
{"service":"TDeltaFuuuk","version":1,"agent_port":17889}
```

发现仅解决地址问题；真正上报仍必须通过共享 Token 认证。
