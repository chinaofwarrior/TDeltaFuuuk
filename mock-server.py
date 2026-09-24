import asyncio
import json
import math
import time

import websockets

# 本地实时测试源：
#   pip install websockets
#   python mock-server.py
# 网页连接 ws://127.0.0.1:8765

async def handler(ws):
    start = time.time()
    while True:
        t = time.time() - start
        frame = {
            "ts": int(time.time() * 1000),
            "self": {
                "id": "me", "name": "我", "x": 100, "y": 100, "z": 0, "yaw": (t * 5) % 360,
                "hp": 86, "maxHp": 100,
                "equipment": {
                    "primary": "M4A1", "ammoType": "5.56 AP", "helmet": "三级头",
                    "armor": "战术甲", "armorDurability": 72, "armorMax": 100
                },
                "supplies": {"ammo": 118, "medkits": 2, "armorRepair": 1, "grenades": 1, "smoke": 2}
            },
            "teammates": [
                {
                    "id": "T2", "name": "二号", "x": 120 + math.sin(t / 2) * 7, "y": 108, "z": 0,
                    "action": "前压", "hp": 74, "maxHp": 100,
                    "equipment": {"primary": "K416", "ammoType": "5.56", "armor": "重甲", "armorDurability": 58, "armorMax": 100},
                    "supplies": {"ammo": 64, "medkits": 1, "armorRepair": 1, "grenades": 2, "smoke": 1}
                },
                {
                    "id": "T3", "name": "三号", "x": 84, "y": 128, "z": 0, "action": "架枪",
                    "hp": 100, "maxHp": 100,
                    "equipment": {"primary": "SR-25", "ammoType": "7.62", "armor": "轻甲", "armorDurability": 93, "armorMax": 100},
                    "supplies": {"ammo": 42, "medkits": 2, "armorRepair": 0, "grenades": 0, "smoke": 2}
                }
            ],
            "contacts": [
                {
                    "id": "E1", "name": "目标 A",
                    "x": 152 - (t % 16) * 2.8, "y": 109 + math.sin(t) * 3, "z": 0,
                    "confidence": 0.92, "source": "visual", "equipment_source": "team-report",
                    "equipment": {"primary": "SCAR-H", "armor": "重甲", "armorDurability": 80, "armorMax": 100, "helmet": "高级头"},
                    "supplies": {"ammo": 90}
                }
            ]
        }
        await ws.send(json.dumps(frame, ensure_ascii=False))
        await asyncio.sleep(0.05)

async def main():
    async with websockets.serve(handler, "127.0.0.1", 8765):
        print("TDeltaFuuuk mock telemetry: ws://127.0.0.1:8765")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
