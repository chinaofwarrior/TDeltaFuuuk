package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/chinaofwarrior/TDeltaFuuuk/internal/core"
	"github.com/chinaofwarrior/TDeltaFuuuk/internal/model"
	"github.com/chinaofwarrior/TDeltaFuuuk/webui"
)

var version = "dev"

const maxBody = 2 << 20

type HubConfig struct {
	UIListen        string `json:"ui_listen"`
	AgentListen     string `json:"agent_listen"`
	DiscoveryListen string `json:"discovery_listen"`
	Token           string `json:"token"`
	OpenBrowser     bool   `json:"open_browser"`
	BroadcastMS     int    `json:"broadcast_ms"`
	AgentTimeoutMS  int    `json:"agent_timeout_ms"`
}

type AgentTemplate struct {
	AgentID       string `json:"agent_id"`
	Name          string `json:"name"`
	Role          string `json:"role"`
	Hub           string `json:"hub"`
	Token         string `json:"token"`
	DiscoveryPort int    `json:"discovery_port"`
	UDPListen     string `json:"udp_listen"`
	HTTPListen    string `json:"http_listen"`
	ForwardHz     int    `json:"forward_hz"`
}

type broker struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
}

func newBroker() *broker             { return &broker{clients: make(map[chan []byte]struct{})} }
func (b *broker) add(ch chan []byte) { b.mu.Lock(); b.clients[ch] = struct{}{}; b.mu.Unlock() }
func (b *broker) del(ch chan []byte) { b.mu.Lock(); delete(b.clients, ch); b.mu.Unlock() }
func (b *broker) publish(msg []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.clients {
		select {
		case ch <- msg:
		default:
		}
	}
}

func main() {
	var configPath string
	flag.StringVar(&configPath, "config", "", "hub config path")
	flag.Parse()

	exeDir := executableDir()
	if configPath == "" {
		configPath = filepath.Join(exeDir, "tdelta-hub.json")
	}
	cfg, created, err := loadOrCreateHubConfig(configPath)
	if err != nil {
		log.Fatalf("配置失败: %v", err)
	}
	if err := writeAgentTemplate(filepath.Join(exeDir, "TDeltaAgent.config.json"), cfg); err != nil {
		log.Printf("写入队友配置模板失败: %v", err)
	}
	if created {
		log.Printf("首次启动已生成配置: %s", configPath)
		log.Printf("队伍共享 Token: %s", cfg.Token)
	}
	log.Printf("TDeltaFuuuk %s", version)

	state := core.New(time.Duration(cfg.AgentTimeoutMS) * time.Millisecond)
	br := newBroker()
	dirty := make(chan struct{}, 1)
	markDirty := func() {
		select {
		case dirty <- struct{}{}:
		default:
		}
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	uiMux := http.NewServeMux()
	uiMux.Handle("/", http.FileServer(http.FS(webui.FS())))
	uiMux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "stream unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		ch := make(chan []byte, 2)
		br.add(ch)
		defer br.del(ch)
		initial, _ := json.Marshal(state.Snapshot())
		fmt.Fprintf(w, "data: %s\n\n", initial)
		flusher.Flush()
		keepAlive := time.NewTicker(15 * time.Second)
		defer keepAlive.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case msg := <-ch:
				fmt.Fprintf(w, "data: %s\n\n", msg)
				flusher.Flush()
			case <-keepAlive.C:
				fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
			}
		}
	})
	uiMux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, state.Snapshot())
	})
	uiMux.HandleFunc("/api/ingest", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !isLoopbackRemote(r.RemoteAddr) {
			http.Error(w, "local only", http.StatusForbidden)
			return
		}
		var f model.Frame
		if err := decodeJSONLimited(r.Body, &f); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		state.UpdateLocal(f)
		markDirty()
		w.WriteHeader(http.StatusNoContent)
	})

	agentMux := http.NewServeMux()
	agentMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	agentMux.HandleFunc("/agent/frame", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !bearerOK(r, cfg.Token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var env model.AgentEnvelope
		if err := decodeJSONLimited(r.Body, &env); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(env.AgentID) == "" {
			http.Error(w, "agent_id required", http.StatusBadRequest)
			return
		}
		state.UpdateAgent(env)
		markDirty()
		w.WriteHeader(http.StatusNoContent)
	})

	uiServer := &http.Server{Addr: cfg.UIListen, Handler: securityHeaders(uiMux), ReadHeaderTimeout: 3 * time.Second, IdleTimeout: 60 * time.Second}
	agentServer := &http.Server{Addr: cfg.AgentListen, Handler: securityHeaders(agentMux), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}

	errCh := make(chan error, 4)
	go func() {
		log.Printf("本机控制台: http://%s", browserAddress(cfg.UIListen))
		errCh <- serveHTTP(uiServer)
	}()
	go func() {
		log.Printf("队友 Agent 接入口: http://%s", cfg.AgentListen)
		errCh <- serveHTTP(agentServer)
	}()
	go func() { errCh <- runDiscovery(ctx, cfg.DiscoveryListen, portOf(cfg.AgentListen)) }()
	go runBroadcaster(ctx, br, state, dirty, time.Duration(cfg.BroadcastMS)*time.Millisecond)

	if cfg.OpenBrowser {
		go func() { time.Sleep(250 * time.Millisecond); _ = openBrowser("http://" + browserAddress(cfg.UIListen)) }()
	}

	select {
	case <-ctx.Done():
		log.Printf("正在关闭…")
	case err := <-errCh:
		if err != nil {
			log.Printf("服务异常: %v", err)
		}
		cancel()
	}
	shutdownCtx, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	_ = uiServer.Shutdown(shutdownCtx)
	_ = agentServer.Shutdown(shutdownCtx)
}

func runBroadcaster(ctx context.Context, br *broker, state *core.State, dirty <-chan struct{}, interval time.Duration) {
	if interval < 20*time.Millisecond {
		interval = 20 * time.Millisecond
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	pending := true
	for {
		select {
		case <-ctx.Done():
			return
		case <-dirty:
			pending = true
		case <-t.C:
			if !pending {
				continue
			}
			pending = false
			msg, err := json.Marshal(state.Snapshot())
			if err == nil {
				br.publish(msg)
			}
		}
	}
}

func runDiscovery(ctx context.Context, listen string, agentPort int) error {
	addr, err := net.ResolveUDPAddr("udp4", listen)
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetReadBuffer(64 * 1024)
	log.Printf("局域网自动发现: udp://%s", listen)
	buf := make([]byte, 512)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		n, remote, err := conn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				select {
				case <-ctx.Done():
					return nil
				default:
					continue
				}
			}
			return err
		}
		if strings.TrimSpace(string(buf[:n])) != "TDF_DISCOVER_V1" {
			continue
		}
		resp, _ := json.Marshal(map[string]any{"service": "TDeltaFuuuk", "version": 1, "agent_port": agentPort})
		_, _ = conn.WriteToUDP(resp, remote)
	}
}

func loadOrCreateHubConfig(path string) (HubConfig, bool, error) {
	cfg := HubConfig{UIListen: "127.0.0.1:17888", AgentListen: "0.0.0.0:17889", DiscoveryListen: "0.0.0.0:17892", OpenBrowser: true, BroadcastMS: 50, AgentTimeoutMS: 5000}
	b, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(b, &cfg); err != nil {
			return cfg, false, fmt.Errorf("解析 %s: %w", path, err)
		}
		if strings.TrimSpace(cfg.Token) == "" {
			cfg.Token = newToken()
		}
		normalizeHubConfig(&cfg)
		return cfg, false, writeJSONFile(path, cfg)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return cfg, false, err
	}
	cfg.Token = newToken()
	normalizeHubConfig(&cfg)
	return cfg, true, writeJSONFile(path, cfg)
}

func normalizeHubConfig(c *HubConfig) {
	if c.UIListen == "" {
		c.UIListen = "127.0.0.1:17888"
	}
	if c.AgentListen == "" {
		c.AgentListen = "0.0.0.0:17889"
	}
	if c.DiscoveryListen == "" {
		c.DiscoveryListen = "0.0.0.0:17892"
	}
	if c.BroadcastMS <= 0 {
		c.BroadcastMS = 50
	}
	if c.AgentTimeoutMS <= 0 {
		c.AgentTimeoutMS = 5000
	}
}

func writeAgentTemplate(path string, cfg HubConfig) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	t := AgentTemplate{AgentID: "", Name: "", Role: "member", Hub: "", Token: cfg.Token, DiscoveryPort: portOf(cfg.DiscoveryListen), UDPListen: "127.0.0.1:17890", HTTPListen: "127.0.0.1:17891", ForwardHz: 20}
	return writeJSONFile(path, t)
}

func writeJSONFile(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func newToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func executableDir() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(p)
}
func browserAddress(listen string) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return listen
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}
func portOf(addr string) int {
	_, p, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(p)
	return n
}
func serveHTTP(s *http.Server) error {
	err := s.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
func decodeJSONLimited(r io.Reader, v any) error {
	d := json.NewDecoder(io.LimitReader(r, maxBody))
	return d.Decode(v)
}
func bearerOK(r *http.Request, token string) bool {
	got := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if len(got) != len(token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}
func isLoopbackRemote(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func openBrowser(url string) error {
	if runtime.GOOS == "windows" {
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("open", url).Start()
	}
	return exec.Command("xdg-open", url).Start()
}
