// Synthetic voluntary test DLL; no game interaction.
#include <windows.h>
#include <cstring>
#define TDF_BUILD_PROVIDER
#include "../sdk/tdf_provider.h"
struct State{uint32_t tick;};
extern "C" {
uint32_t tdf_provider_abi_version(void){return TDF_PROVIDER_ABI_VERSION;}
int tdf_provider_create(const TdfHostApi*,const char*,TdfProviderHandle* h){*h=new State{0};return 0;}
int tdf_provider_start(TdfProviderHandle){return 0;}
int tdf_provider_poll(TdfProviderHandle h,TdfObservation* out,uint32_t cap,uint32_t* n){
 *n=0;if(cap<1)return 0;auto* st=(State*)h;TdfObservation x={};
 x.entity_id=1;x.entity_kind=TDF_KIND_SELF;x.confidence=255;
 x.position={float(st->tick++%100),10.f,0.f};x.source="MANUAL";out[0]=x;*n=1;return 0;
}
int tdf_provider_poll_json(TdfProviderHandle h,char* out,uint32_t cap,uint32_t* count){
 const auto* state=(State*)h;
 static const char* weapon="{\"type\":\"LOADOUT_STATE\",\"subject\":{\"kind\":\"SELF\"},\"equipment\":{\"primary\":\"K416\",\"armor\":\"模拟护甲\"},\"source\":\"MANUAL\"}";
 static const char* supplies="{\"type\":\"SUPPLY_STATE\",\"subject\":{\"kind\":\"SELF\"},\"supplies\":{\"ammo\":64,\"medkits\":2},\"source\":\"MANUAL\"}";
 const char* value=(state->tick/20)%2?weapon:supplies;
 const size_t n=strlen(value);
 if(n>=cap){*count=0;return 1;}
 memcpy(out,value,n);*count=(uint32_t)n;return 0;
}
void tdf_provider_stop(TdfProviderHandle){}
void tdf_provider_destroy(TdfProviderHandle h){delete (State*)h;}
}
