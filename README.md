# TDeltaFuuuk · 实时小队信息协同

下载 GitHub Actions 的 **Windows portable verified build** 产物 `TDeltaFuuuk-portable-windows-amd64`，**完整解压**，主机双击 `TDeltaFuuuk.exe`。它会启动 Hub、本机 Agent，自动打开网页。

首次启动创建 `invites/二号.join.json`、`三号.join.json`、`四号.join.json`。将便携包和其中一个**专属邀请文件**发给对应队友，邀请文件放在 Agent EXE 同目录；队友双击 `TDeltaAgent.exe`，自动寻找局域网主机，打开状态页。不要公开邀请文件。Windows 防火墙只允许可信专用网络访问 TCP 17889、UDP 17892。异地使用 Tailscale/WireGuard 私网，并在队友配置中设置 `hubUrl` 为 `http://私网IP:17889`。本版 HTTP 仅适用于受信任网络，不能直接开放公网。

## 数据源与边界

Agent 是经过授权的本机数据网关，不会凭空知道游戏内部实时坐标或装备。已有权使用的程序可 POST JSON 到队友本机 `http://127.0.0.1:17891/ingest`，或通过 UDP 发至 `127.0.0.1:17890`。网页可主动输入扇区报点；未知距离只显示为不确定情报，不会生成虚假精确红点。本仓库没有游戏进程注入、内存扫描、DMA 或提取不可见敌人信息的功能。

`src/core/observation.js` 定义统一协议。位姿 50ms 一批，可覆盖旧状态；装备、补给及重要报告经过单独的确认重传队列。每名队友拥有独立认证与独立 PlayerState。

## 原生 DLL Provider

`sdk/tdf_provider.h` + `native/provider_host.cpp` 实现独立 DLL 宿主；`native/example_provider.cpp` 是仅模拟自有状态的示例。将受信任 DLL 放入 `src/providers/` 并创建相邻 `sample.provider.json`：

```json
{"dll":"approved.dll","sha256":"准确的 DLL SHA256 小写值","capabilities":["SELF_POSITION"]}
```

Agent 校验文件哈希才加载独立宿主。只允许接入经过授权的数据；示例不读取游戏进程。

## 测试和 Windows 构建

`node --test` 与 `node scripts/check.js`。Windows 生产包执行 `powershell -File scripts/build.ps1`（需要 Node22、Go1.23、MSVC）；GitHub `.github/workflows/windows.yml` 自动构建 Hub EXE、Agent EXE、Native Host、示例 DLL、Node 便携运行时，并上传完整目录和 SHA256。历史账号信息使用社区 API（`COMMUNITY_API`），还需实际社区服务实例联调；并无已证实的官方局内实时 API。


原生 ABI v1 增加可选 `tdf_provider_poll_json`：20Hz 二进制位姿接口保持兼容，低频自有装备与补给由 JSON Observation 承载。使用此扩展的 DLL manifest capabilities 应包含 `SELF_POSITION`、`SELF_EQUIPMENT`、`SELF_SUPPLIES`。浏览器支持时可以按键触发语音报点；浏览器可能将声音发送给其在线语音识别服务，需要玩家主动授权。以上均不包含未授权游戏内数据提取。


## 离线恢复与邀请更新
低频关键事件在客户端本机 `.tdelta-state/<玩家ID>.json` 原子落盘后才返回成功；断线或进程重启后按原始 observation_id 重试，55 秒后过期事件明确统计丢弃，避免旧敌情冒充实时敌情。高频位姿只保留最新数据。主机网页提供每个队友的独立邀请更新按钮，更新后旧令牌立即失效；只给对应队友发送新 `.join.json`。邀请、密钥和事件存储均列入 `.gitignore`。跨机器时钟同步是估计值，不能当作已测量的端到端延迟。
