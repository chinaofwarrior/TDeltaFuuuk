# TDeltaFuuuk

实时小队战术辅助 Web 客户端。

## 当前范围

- WebSocket 实时数据接入
- 自己 / 队友状态
- 已知目标 Track
- 距离、方位、接近速度与威胁评分
- 队友脱节与倒地提醒
- 浏览器中文语音播报
- 本地模拟数据模式
- 纯静态网页，可直接使用 GitHub Pages

> 本项目的数据层采用通用 telemetry adapter。请仅接入你有权使用的数据源；本仓库不实现游戏进程注入、内存读取、DMA、反作弊绕过或隐藏敌人坐标提取。

## 数据格式

```json
{
  "ts": 1790229000123,
  "self": {"id":"me","x":100,"y":100,"z":0,"yaw":0},
  "teammates": [
    {"id":"T2","name":"队友2","x":120,"y":108,"z":0,"downed":false,"action":"moving"}
  ],
  "contacts": [
    {"id":"E1","x":145,"y":110,"z":0,"confidence":0.85,"source":"visual"}
  ]
}
```

## 本地运行

直接双击 `index.html`，或者：

```powershell
python -m http.server 8080
```

然后访问 `http://127.0.0.1:8080`。

## GitHub Pages

仓库内已包含 Pages Actions 工作流。启用 GitHub Pages 并选择 GitHub Actions 后，推送到 `main` 会自动发布。
