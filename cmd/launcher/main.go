package main
import ("fmt";"net/http";"os";"os/exec";"path/filepath";"time")
var role="hub"
func main(){
 self,err:=os.Executable();if err!=nil{fmt.Println(err);os.Exit(1)}
 root:=filepath.Dir(self);node:=filepath.Join(root,"runtime","node.exe")
 if _,err:=os.Stat(node);err!=nil{fmt.Println("缺少 runtime/node.exe，请完整解压发行包");os.Exit(2)}
 entry:="hub.js";if role=="agent"{entry="agent.js"}
 cmd:=exec.Command(node,filepath.Join(root,"src",entry))
 cmd.Dir=root;cmd.Stdin=os.Stdin;cmd.Stdout=os.Stdout;cmd.Stderr=os.Stderr
 if err:=cmd.Start();err!=nil{fmt.Println(err);os.Exit(3)}
 if role=="hub" {
  go func(){url:="http://127.0.0.1:17888";for i:=0;i<60;i++{
    res,err:=http.Get(url);if err==nil{res.Body.Close();if res.StatusCode==200{
      exec.Command("rundll32","url.dll,FileProtocolHandler",url).Start()
      local:=filepath.Join(root,"TDeltaAgent.config.json")
      if _,err:=os.Stat(local);err==nil{
        child:=exec.Command(node,filepath.Join(root,"src","agent.js"));child.Dir=root;child.Stdout=os.Stdout;child.Stderr=os.Stderr
        child.Start()
      };return
    }};time.Sleep(200*time.Millisecond)
  }}()
 }else{
  go func(){url:="http://127.0.0.1:17891";for i:=0;i<60;i++{
    res,err:=http.Get(url);if err==nil{res.Body.Close();if res.StatusCode==200{
      exec.Command("rundll32","url.dll,FileProtocolHandler",url).Start();return
    }};time.Sleep(200*time.Millisecond)
  }}()
 }
 if err:=cmd.Wait();err!=nil{fmt.Println("进程异常：",err);os.Exit(1)}
}
