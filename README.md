# TDeltaFuuuk

实时小队战术辅助 Web 客户端。

## 当前能力

- WebSocket 20–50Hz 实时数据接入
- 自己 / 队友位置、方向、生命、动作
- 已知目标 Track、距离、方位、接近速度、威胁评分
- 自己 / 队友装备与剩余补给
- 数据源明确提供时显示已知目标装备 / 补给，并标记来源与置信度
- 高频位置 + 低频装备状态合并：未携带装备字段的新帧不会清空旧装备
- 队友脱节、倒地、低弹药、医疗耗尽、低护甲提醒
- 中文浏览器 TTS 报点
- 本地 Demo 与 20Hz mock server
- 纯静态网页，可用 GitHub Pages

> 数据层采用通用 telemetry adapter。请仅接入你有权使用的数据源。本仓库不实现游戏进程注入、内存读取、DMA、反作弊绕过或从游戏中提取未公开的敌人坐标/装备/库存。

## 数据协议

位置可以高频发送，装备与补给可以低频发送。客户端会按实体 ID 合并已知状态。

\`\`\`json
{
  "ts": 1790229000123,
  "self": {
    "id": "me", "x": 100, "y": 100, "z": 0, "yaw": 90,
    "hp": 86, "maxHp": 100,
    "equipment": {
      "primary": "M4A1",
      "secondary": "",
      "ammoType": "5.56 AP",
      "helmet": "三级头",
      "armor": "战术甲",
      "armorDurability": 72,
      "armorMax": 100
    },
    "supplies": {
      "ammo": 118,
      "magazines": 4,
      "medkits": 2,
      "bandages": 1,
      "armorRepair": 1,
      "grenades": 1,
      "smoke": 2
    }
  },
  "teammates": [
    {
      "id": "T2", "name": "二号", "x": 120, "y": 108, "z": 0,
      "action": "前压",
      "equipment": {"primary": "K416", "armor": "重甲", "armorDurability": 58, "armorMax": 100},
      "supplies": {"ammo": 64, "medkits": 1, "armorRepair": 1, "smoke": 1}
    }
  ],
  "contacts": [
    {
      "id": "E1", "x": 145, "y": 110, "z": 0,
      "confidence": 0.85,
      "source": "visual",
      "equipment_source": "team-report",
      "equipment": {"primary": "SCAR-H", "armor": "重甲"},
      "supplies": {"ammo": 90}
    }
  ]
}
\`\`\`

### 装备字段

\`primary\`, \`secondary\`, \`helmet\`, \`armor\`, \`armorDurability\`, \`armorMax\`, \`backpack\`, \`optic\`, \`ammoType\`, \`gearValue\`

### 补给字段

\`ammo\`, \`magazines\`, \`medkits\`, \`bandages\`, \`armorRepair\`, \`grenades\`, \`smoke\`, \`food\`, \`water\`, \`value\`

## 本地运行

\`\`\`powershell
python -m http.server 8080
\`\`\`

测试实时源：

\`\`\`powershell
pip install websockets
python mock-server.py
\`\`\`

网页连接 \`ws://127.0.0.1:8765\`。

## GitHub Pages

仓库包含 Pages Actions 工作流。仓库 Pages 首次需要在 GitHub Settings → Pages 中允许 GitHub Actions 发布。
