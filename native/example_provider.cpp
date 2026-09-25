// Synthetic voluntary test DLL; no game interaction.
#include <windows.h>
#include "../sdk/tdf_provider.h"
struct State{uint32_t tick;};
extern "C" {
__declspec(dllexport) uint32_t tdf_provider_abi_version(void){return TDF_PROVIDER_ABI_VERSION;}
__declspec(dllexport) int tdf_provider_create(const TdfHostApi*,const char*,TdfProviderHandle* h){*h=new State{0};return 0;}
__declspec(dllexport) int tdf_provider_start(TdfProviderHandle){return 0;}
__declspec(dllexport) int tdf_provider_poll(TdfProviderHandle h,TdfObservation* out,uint32_t cap,uint32_t* n){
 *n=0;if(cap<1)return 0;auto* st=(State*)h;TdfObservation x={};
 x.entity_id=1;x.entity_kind=TDF_KIND_SELF;x.confidence=255;
 x.position={float(st->tick++%100),10.f,0.f};x.source="MANUAL";out[0]=x;*n=1;return 0;
}
__declspec(dllexport) void tdf_provider_stop(TdfProviderHandle){}
__declspec(dllexport) void tdf_provider_destroy(TdfProviderHandle h){delete (State*)h;}
}
