# TDeltaFuuuk

Windows 实时小队战术 Hub + 绿色 Agent。

## 现在的运行形态

### 主机：`TDeltaFuuuk.exe`

双击后自动：

1. 生成 `tdelta-hub.json`（首次启动）。
2. 生成带共享 Token 的 `TDeltaAgent.config.json`。
3. 启动本机控制台 `http://127.0.0.1:17888`。
4. 启动队友 Agent 接入口 `0.0.0.0:17889`。
5. 启动局域网自动发现 UDP `17892`。
6. 自动打开浏览器。

主机网页只绑定 loopback；局域网不能直接读取你的战术网页。队友上报接口需要共享 Token。

### 队友：`TDeltaAgent.exe`

把主机生成的 `TDeltaAgent.config.json` 与 `TDeltaAgent.exe` 放在同一目录发给队友。队友双击即可：

- 自动使用 Windows 主机名作为 `agent_id` / 名称（配置为空时）。
- 自动通过 UDP 广播发现同一局域网中的 Hub。
- 从本机 UDP `127.0.0.1:17890` 或 HTTP `127.0.0.1:17891/ingest` 接收 JSON telemetry。
- 默认 20Hz 采样最新状态并上报 Hub。
- 自动重连；Hub 消失时会重新发现。

不需要 Python，不需要 Node，不需要安装服务。

## 数据接入

当前程序故意把“数据怎么产生”与“队伍融合/网页显示”拆开。任何你有权使用的本机数据源，都可以向 Agent 写入统一 JSON。

### HTTP

```text
POST http://127.0.0.1:17891/ingest
Content-Type: application/json
```

### UDP

把同栻的 JSON 数据报发送到：

```text
127.0.0.1:17890
```

### 主机直接输入

如果主机本机的数据源不想再运行 Agent，可以直接：

```text
POST http://127.0.0.1:17888/api/ingest
```

## Frame 协议示例

```json
{
  "ts": 1790229000123,
  "self": {
    "id": "me",
    "name": "我",
    "x": 100,
    "y": 100,
    "z": 0,
    "yaw": 90,
    "hp": 86,
    "maxHp": 100,
    "equipment": {
      "primary": "M4A1",
      "ammoType": "5.56 AP",
      "helmet": "三级头",
      "armor": "战术甲",
      "armorDurability": 72,
      "armorMax": 100
    },
    "supplies": {
      "ammo": 118,
      "medkits": 2,
      "armorRepair": 1,
      "grenades": 1,
      "smoke": 2
    }
  },
  "contacts": [
    {
      "id": "E1",
      "name": "目标A",
      "x": 145,
      "y": 110,
      "confidence": 0.85,
      "source": "visual",
      "equipment_source": "team-report",
      "equipment": {"primary": "SCAR-H", "armor": "重甲"}
    }
  ]
}
```

位置和装备都支持稀疏更新：低频装备帧不带 `x/y` 时，Hub/Agent 不会把之前的位置清零；位置帧不重复携带装备时，已知装备/补给也会保留。

## 构建

TONG / Windows PowerShell：

```powershell
.\scripts\build.ps1
```

输出：

```text
dist\TDeltaFuuuk.exe
dist\TDeltaAgent.exe
```

推送 `main` 后，GitHub Actions 的 **Build Windows EXE** 也会运行测试、构建 Windows x64，并上传 `TDeltaFuuuk-windows-amd64` artifact。

## 安全边界

本仓库的 Adapter 接受明确送入的 telemetry。它不实现游戏进程注入、内存扫描、DMA、反作弊绕过，也不实现从游戏中提取正常玩家不可获得的隐藏敌人位置、装备或库存。
