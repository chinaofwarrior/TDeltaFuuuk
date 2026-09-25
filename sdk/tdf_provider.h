// TDF Provider C ABI v1 —— 参考实现（《开发方案》第三节）。
// 本 Node 版本用「子进程 + NDJSON」实现 Provider（见 src/providers/protocol.js），
// 提供同等能力且进程级崩溃隔离。此头文件保留，供未来 C/C++/Rust 原生 Provider 使用。
//
// 纯 C ABI，不暴露 C++ class，便于 Rust/C++/Go/C#/Zig 接入。

#ifndef TDF_PROVIDER_H
#define TDF_PROVIDER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TDF_PROVIDER_ABI_VERSION 1

typedef struct TdfVec3 {
    float x;
    float y;
    float z;
} TdfVec3;

// 观察主体类别（与 Observation.subject.kind 对齐）
enum TdfEntityKind {
    TDF_KIND_SELF = 0,
    TDF_KIND_TEAMMATE = 1,
    TDF_KIND_OBSERVED_ENEMY = 2,
    TDF_KIND_PREDICTED_ENEMY = 3,
};

// 一次观测（对应 Observation）
typedef struct TdfObservation {
    uint64_t entity_id;
    uint64_t timestamp_us;
    uint8_t entity_kind;
    uint8_t state;        // 0=正常 1=倒地 2=阵亡
    uint8_t confidence;   // 0..255 映射到 0..1
    TdfVec3 position;
    float yaw;
    float velocity;
    const char* source;   // OFFICIAL_API / MANUAL / VOICE / ...（静态字符串）
} TdfObservation;

// Host 回调：Provider 通过它把观测批量上抛（避免 JSON 序列化开销）
typedef struct TdfHostApi {
    void (*submit_observations)(const TdfObservation* obs, uint32_t count);
} TdfHostApi;

// 不透明句柄
typedef void* TdfProviderHandle;

// Provider 必须导出的函数
uint32_t tdf_provider_abi_version(void);
int      tdf_provider_create(const TdfHostApi* host, const char* config_json, TdfProviderHandle* out_handle);
int      tdf_provider_start(TdfProviderHandle handle);
int      tdf_provider_poll(TdfProviderHandle handle, TdfObservation* out_batch, uint32_t max_count, uint32_t* out_count);
void     tdf_provider_stop(TdfProviderHandle handle);
void     tdf_provider_destroy(TdfProviderHandle handle);

#ifdef __cplusplus
}
#endif

#endif // TDF_PROVIDER_H
