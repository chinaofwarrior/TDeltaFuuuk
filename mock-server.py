import asyncio
import json
import math
import time

import websockets

# 本地实时测试源：
#   pip install websockets
#   python mock-server.py
# 然后网页连接 ws://127.0.0.1:8765

async def handler(ws):
    start = time.time()
    while True:
        t = time.time() - start
        frame = {
            "ts": int(time.time() * 1000),
            "self": {
                "id": "me", "name": "我",
                "x": 100, "y": 100, "z": 0,
                "yaw": (t * 5) % 360,
            },
            "teammates": [
                {
                    "id": "T2", "name": "二号",
                    "x": 120 + math.sin(t / 2) * 7,
                    "y": 108, "z": 0,
                    "action": "前压",
                },
                {
                    "id": "T3", "name": "三号",
                    "x": 84, "y": 128,
                    "z": 0, "action": "架枪",
                },
            ],
            "contacts": [
                {
                    "id": "E1", "name": "目标 A",
                    "x": 152 - (t % 16) * 2.8,
                    "y": 109 + math.sin(t) * 3,
                    "z": 0,
                    "confidence": 0.92,
                    "source": "visual",
                }
            ],
        }
        await ws.send(json.dumps(frame, ensure_ascii=False))
        await asyncio.sleep(0.05)  # 20 Hz

async def main():
    async with websockets.serve(handler, "127.0.0.1", 8765):
        print("TDeltaFuuuk mock telemetry: ws://127.0.0.1:8765")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
