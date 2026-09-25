// Standalone native ABI host for voluntarily installed, hash-pinned telemetry DLLs.
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <thread>
#include <chrono>
#include "../sdk/tdf_provider.h"
static void submit(const TdfObservation* rows,uint32_t count){
 for(uint32_t i=0;i<count&&i<128;i++){
  const auto& p=rows[i];if(p.entity_kind!=TDF_KIND_SELF)continue;
  const char* origin=p.source&&strcmp(p.source,"MANUAL")==0?"MANUAL":"UNKNOWN";
  printf("{\"type\":\"observation\",\"observation\":{\"type\":\"ENTITY_STATE\",\"subject\":{\"kind\":\"SELF\",\"id\":\"native-self\"},\"position\":{\"x\":%.3f,\"y\":%.3f,\"z\":%.3f},\"heading\":%.2f,\"confidence\":%.3f,\"source\":\"%s\"}}\n",p.position.x,p.position.y,p.position.z,p.yaw,double(p.confidence)/255,origin);
 }fflush(stdout);
}
int wmain(int argc,wchar_t** argv){
 if(argc!=3||wcscmp(argv[1],L"--dll")!=0)return 2;
 HMODULE dll=LoadLibraryExW(argv[2],nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
 if(!dll)return 3;
 auto version=(uint32_t(*)())GetProcAddress(dll,"tdf_provider_abi_version");
 auto create=(int(*)(const TdfHostApi*,const char*,TdfProviderHandle*))GetProcAddress(dll,"tdf_provider_create");
 auto start=(int(*)(TdfProviderHandle))GetProcAddress(dll,"tdf_provider_start");
 auto poll=(int(*)(TdfProviderHandle,TdfObservation*,uint32_t,uint32_t*))GetProcAddress(dll,"tdf_provider_poll");
 auto stop=(void(*)(TdfProviderHandle))GetProcAddress(dll,"tdf_provider_stop");
 auto destroy=(void(*)(TdfProviderHandle))GetProcAddress(dll,"tdf_provider_destroy");
 auto poll_json=(int(*)(TdfProviderHandle,char*,uint32_t,uint32_t*))GetProcAddress(dll,"tdf_provider_poll_json");
 if(!version||!create||!start||!poll||!stop||!destroy||version()!=TDF_PROVIDER_ABI_VERSION){FreeLibrary(dll);return 4;}
 TdfHostApi api={submit};TdfProviderHandle h=nullptr;
 if(create(&api,"{}",&h)!=0||!h){FreeLibrary(dll);return 5;}
 if(start(h)!=0){destroy(h);FreeLibrary(dll);return 6;}
 if(poll_json)puts("{\"type\":\"hello\",\"provider\":\"native-approved\",\"abi\":1,\"capabilities\":[\"SELF_POSITION\",\"SELF_EQUIPMENT\",\"SELF_SUPPLIES\"],\"max_rate_hz\":20}");
 else puts("{\"type\":\"hello\",\"provider\":\"native-approved\",\"abi\":1,\"capabilities\":[\"SELF_POSITION\"],\"max_rate_hz\":20}");
 fflush(stdout);
 TdfObservation batch[128];uint32_t ticks=0;
 for(;;){uint32_t n=0;if(poll(h,batch,128,&n)!=0)break;
   if(n)submit(batch,n);
   if(++ticks%20==0 && poll_json){
     char payload[4096]={0};uint32_t used=0;
     if(poll_json(h,payload,sizeof(payload),&used)==0 && used>1 && used<sizeof(payload) &&
        payload[0]=='{' && payload[used-1]=='}' && !memchr(payload,'\n',used) && !memchr(payload,'\r',used)){
       fputs("{\"type\":\"observation\",\"observation\":",stdout);
       fwrite(payload,1,used,stdout);fputs("}\n",stdout);fflush(stdout);
     }
   }
   if(ticks%40==0){puts("{\"type\":\"heartbeat\"}");fflush(stdout);}
   std::this_thread::sleep_for(std::chrono::milliseconds(50));
 }
 stop(h);destroy(h);FreeLibrary(dll);return 0;
}
