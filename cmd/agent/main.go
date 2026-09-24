package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/chinaofwarrior/TDeltaFuuuk/internal/core"
	"github.com/chinaofwarrior/TDeltaFuuuk/internal/model"
)

var version = "dev"

const maxBody = 2 << 20

type Config struct {
	AgentID       string `json:"agent_id"`
	Name          string `json:"name"`
	Role          string `json:"role"`
	Hub           string `json:"hub"`
	Token         string `json:"token"`
	DiscoveryPort int    `json:"discovery_port"`
	UDPListen     string `json:"udp_listen"`
	HTTPListen    string `json:"http_listen"`
	ForwardHz     int    `json:"forward_hz"`
	StaleMS       int    `json:"stale_ms"`
}

type latestFrame struct {
	mu      sync.RWMutex
	f       model.Frame
	has     bool
	updated time.Time
	seq     atomic.Uint64
}

func (l *latestFrame) set(f model.Frame) {
	if f.TS == 0 {
		f.TS = model.NowMS()
	}
	l.mu.Lock()
	if l.has {
		f = core.MergeFrame(l.f, f)
	}
	l.f = f
	l.has = true
	l.updated = time.Now()
	l.mu.Unlock()
	l.seq.Add(1)
}
func (l *latestFrame) get() (model.Frame, bool, time.Time, uint64) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.f, l.has, l.updated, l.seq.Load()
}

func main() {
	var configPath string
	var stdinMode bool
	flag.StringVar(&configPath, "config", "", "agent config path")
	flag.BoolVar(&stdinMode, "stdin", false, "accept newline-delimited JSON frames from stdin")
	flag.Parse()
	if configPath == "" {
		configPath = filepath.Join(executableDir(), "TDeltaAgent.config.json")
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		log.Fatalf("配置失败: %v", err)
	}
	log.Printf("TDeltaAgent %s · %s (%s)", version, cfg.Name, cfg.AgentID)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	latest := &latestFrame{}
	errCh := make(chan error, 4)
	go func() { errCh <- runUDP(ctx, cfg.UDPListen, latest) }()
	go func() { errCh <- runHTTP(ctx, cfg.HTTPListen, latest) }()
	if stdinMode {
		go func() { errCh <- runStdin(ctx, latest) }()
	}
	go func() { errCh <- runForwarder(ctx, cfg, latest) }()

	select {
	case <-ctx.Done():
		log.Printf("正在关闭…")
	case err := <-errCh:
		if err != nil {
			log.Printf("服务异常: %v", err)
		}
		cancel()
	}
}

func loadConfig(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("读取 %s 失败；请把 Hub 生成的 TDeltaAgent.config.json 和 EXE 放在一起: %w", path, err)
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	host, _ := os.Hostname()
	if c.AgentID == "" {
		c.AgentID = host
	}
	if c.Name == "" {
		c.Name = host
	}
	if c.Role == "" {
		c.Role = "member"
	}
	if c.DiscoveryPort == 0 {
		c.DiscoveryPort = 17892
	}
	if c.UDPListen == "" {
		c.UDPListen = "127.0.0.1:17890"
	}
	if c.HTTPListen == "" {
		c.HTTPListen = "127.0.0.1:17891"
	}
	if c.ForwardHz <= 0 {
		c.ForwardHz = 20
	}
	if c.ForwardHz > 50 {
		c.ForwardHz = 50
	}
	if c.StaleMS <= 0 {
		c.StaleMS = 3000
	}
	if strings.TrimSpace(c.Token) == "" {
		return c, errors.New("token 为空，请使用 Hub 生成的配置文件")
	}
	return c, nil
}

func runUDP(ctx context.Context, listen string, latest *latestFrame) error {
	addr, err := net.ResolveUDPAddr("udp4", listen)
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	log.Printf("本机 UDP 输入: udp://%s", listen)
	buf := make([]byte, maxBody)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		n, _, err := conn.ReadFromUDP(buf)
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
		var f model.Frame
		if err := json.Unmarshal(buf[:n], &f); err != nil {
			log.Printf("UDP JSON 无效: %v", err)
			continue
		}
		latest.set(f)
	}
}

func runHTTP(ctx context.Context, listen string, latest *latestFrame) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("/ingest", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !isLoopbackRemote(r.RemoteAddr) {
			http.Error(w, "local only", http.StatusForbidden)
			return
		}
		var f model.Frame
		if err := decodeLimited(r.Body, &f); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		latest.set(f)
		w.WriteHeader(http.StatusNoContent)
	})
	srv := &http.Server{Addr: listen, Handler: mux, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	errCh := make(chan error, 1)
	go func() {
		log.Printf("本机 HTTP 输入: http://%s/ingest", listen)
		e := srv.ListenAndServe()
		if errors.Is(e, http.ErrServerClosed) {
			e = nil
		}
		errCh <- e
	}()
	select {
	case <-ctx.Done():
		c, stop := context.WithTimeout(context.Background(), 2*time.Second)
		defer stop()
		_ = srv.Shutdown(c)
		return nil
	case err := <-errCh:
		return err
	}
}

func runStdin(ctx context.Context, latest *latestFrame) error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), maxBody)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		var f model.Frame
		if err := json.Unmarshal(scanner.Bytes(), &f); err != nil {
			log.Printf("stdin JSON 无效: %v", err)
			continue
		}
		latest.set(f)
	}
	return scanner.Err()
}

func runForwarder(ctx context.Context, cfg Config, latest *latestFrame) error {
	interval := time.Second / time.Duration(cfg.ForwardHz)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	transport := &http.Transport{MaxIdleConns: 4, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second, DisableCompression: true}
	client := &http.Client{Transport: transport, Timeout: 2500 * time.Millisecond}
	defer transport.CloseIdleConnections()
	hub := strings.TrimRight(cfg.Hub, "/")
	auto := hub == ""
	var lastSeq uint64
	failures := 0
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if hub == "" {
				h, err := discoverHub(ctx, cfg.DiscoveryPort)
				if err != nil {
					if failures%20 == 0 {
						log.Printf("等待发现 Hub: %v", err)
					}
					failures++
					continue
				}
				hub = h
				log.Printf("已发现 Hub: %s", hub)
				failures = 0
			}
			f, has, updated, seq := latest.get()
			if !has || time.Since(updated) > time.Duration(cfg.StaleMS)*time.Millisecond || seq == lastSeq {
				continue
			}
			env := model.AgentEnvelope{AgentID: cfg.AgentID, Name: cfg.Name, Role: cfg.Role, Frame: f}
			b, _ := json.Marshal(env)
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, hub+"/agent/frame", bytes.NewReader(b))
			if err != nil {
				return err
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+cfg.Token)
			resp, err := client.Do(req)
			if err == nil {
				io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
				resp.Body.Close()
			}
			if err != nil || resp.StatusCode >= 300 {
				failures++
				if failures == 1 || failures%20 == 0 {
					if err != nil {
						log.Printf("Hub 上报失败: %v", err)
					} else {
						log.Printf("Hub 上报失败: HTTP %d", resp.StatusCode)
					}
				}
				if auto && failures >= 3 {
					hub = ""
				}
				continue
			}
			failures = 0
			lastSeq = seq
		}
	}
}

func discoverHub(ctx context.Context, port int) (string, error) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetWriteBuffer(4096)
	_ = conn.SetReadBuffer(4096)
	_ = conn.SetDeadline(time.Now().Add(1200 * time.Millisecond))
	dst := &net.UDPAddr{IP: net.IPv4bcast, Port: port}
	if _, err := conn.WriteToUDP([]byte("TDF_DISCOVER_V1"), dst); err != nil {
		return "", err
	}
	buf := make([]byte, 1024)
	for {
		n, remote, err := conn.ReadFromUDP(buf)
		if err != nil {
			return "", err
		}
		var resp struct {
			Service   string `json:"service"`
			AgentPort int    `json:"agent_port"`
		}
		if json.Unmarshal(buf[:n], &resp) != nil || resp.Service != "TDeltaFuuuk" || resp.AgentPort == 0 {
			continue
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}
		return "http://" + net.JoinHostPort(remote.IP.String(), strconv.Itoa(resp.AgentPort)), nil
	}
}

func decodeLimited(r io.Reader, v any) error {
	d := json.NewDecoder(io.LimitReader(r, maxBody))
	return d.Decode(v)
}
func isLoopbackRemote(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
func executableDir() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(p)
}
