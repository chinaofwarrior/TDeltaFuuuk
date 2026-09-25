package main
import (
 "fmt"
 "net/http"
 "os"
 "os/exec"
 "path/filepath"
 "sync"
 "time"
)
var role="hub"
func main(){
 exe,err:=os.Executable();if err!=nil{fmt.Println(err);os.Exit(1)}
 root:=filepath.Dir(exe);node:=filepath.Join(root,"runtime","node.exe")
 if _,err:=os.Stat(node);err!=nil{fmt.Println("请完整解压便携包：缺少 runtime/node.exe");os.Exit(2)}
 entry:="hub.js";if role=="agent"{entry="agent.js"}
 primary:=exec.Command(node,filepath.Join(root,"src",entry))
 primary.Dir=root;primary.Stdin=os.Stdin;primary.Stdout=os.Stdout;primary.Stderr=os.Stderr
 if err:=primary.Start();err!=nil{fmt.Println("启动失败:",err);os.Exit(3)}
 var mu sync.Mutex
 var agent *exec.Cmd
 done:=make(chan struct{})
 go func(){
  address:="http://127.0.0.1:17888"
  if role=="agent"{address="http://127.0.0.1:17891"}
  client:=&http.Client{Timeout:500*time.Millisecond}
  for i:=0;i<60;i++{
   select{case <-done:return;default:}
   response,e:=client.Get(address)
   if e==nil{
    response.Body.Close()
    if response.StatusCode==200{
     if os.Getenv("TDF_NO_BROWSER")!="1"{
      _=exec.Command("rundll32","url.dll,FileProtocolHandler",address).Start()
     }
     if role=="hub"&&os.Getenv("TDF_NO_AUTO_AGENT")!="1"{
      config:=filepath.Join(root,"TDeltaAgent.config.json")
      if _,e:=os.Stat(config);e==nil{
       child:=exec.Command(node,filepath.Join(root,"src","agent.js"))
       child.Dir=root;child.Stdout=os.Stdout;child.Stderr=os.Stderr
       mu.Lock()
       select{case <-done:mu.Unlock();return;default:}
       if child.Start()==nil{agent=child}
       mu.Unlock()
      }
     }
     return
    }
   }
   time.Sleep(250*time.Millisecond)
  }
 }()
 err=primary.Wait()
 close(done)
 mu.Lock()
 if agent!=nil&&agent.Process!=nil{
  _=agent.Process.Kill()
  _,_=agent.Process.Wait()
 }
 mu.Unlock()
 if err!=nil{fmt.Println("主进程退出:",err);os.Exit(1)}
}
