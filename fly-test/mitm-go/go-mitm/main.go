package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/elazarl/goproxy"
)

type certStorage struct {
	mu    sync.RWMutex
	certs map[string]*tls.Certificate
}

func newCertStorage() *certStorage {
	return &certStorage{certs: map[string]*tls.Certificate{}}
}

func (cs *certStorage) Fetch(hostname string, gen func() (*tls.Certificate, error)) (*tls.Certificate, error) {
	cs.mu.RLock()
	cached, ok := cs.certs[hostname]
	cs.mu.RUnlock()
	if ok {
		return cached, nil
	}

	cert, err := gen()
	if err != nil {
		return nil, err
	}

	cs.mu.Lock()
	cs.certs[hostname] = cert
	cs.mu.Unlock()
	return cert, nil
}

type proxyApp struct {
	transformURL string
	client       *http.Client
	logger       *log.Logger
	logFile      *os.File
}

func newProxyApp(transformURL, logPath string) (*proxyApp, error) {
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open log file: %w", err)
	}

	client := &http.Client{
		Timeout: 90 * time.Second,
		Transport: &http.Transport{
			Proxy:               nil,
			ForceAttemptHTTP2:   false,
			MaxIdleConnsPerHost: 64,
			MaxIdleConns:        256,
			IdleConnTimeout:     90 * time.Second,
		},
	}

	logger := log.New(io.MultiWriter(os.Stdout, logFile), "", 0)
	return &proxyApp{
		transformURL: transformURL,
		client:       client,
		logger:       logger,
		logFile:      logFile,
	}, nil
}

func (app *proxyApp) close() error {
	if app.logFile == nil {
		return nil
	}
	return app.logFile.Close()
}

func (app *proxyApp) logf(format string, args ...any) {
	app.logger.Printf("%s %s", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
}

func cloneHeaders(input http.Header) http.Header {
	out := make(http.Header, len(input))
	for key, values := range input {
		copied := make([]string, len(values))
		copy(copied, values)
		out[key] = copied
	}
	return out
}

func removeHopHeaders(headers http.Header) http.Header {
	out := make(http.Header)
	for key, values := range headers {
		lower := strings.ToLower(key)
		switch lower {
		case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
			continue
		case "proxy-connection", "proxy-authentication", "host", "content-length":
			continue
		default:
			copied := make([]string, len(values))
			copy(copied, values)
			out[key] = copied
		}
	}
	return out
}

func parseCA(certPath, keyPath string) (tls.Certificate, error) {
	certBytes, err := os.ReadFile(certPath)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("read CA cert: %w", err)
	}
	keyBytes, err := os.ReadFile(keyPath)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("read CA key: %w", err)
	}
	cert, err := tls.X509KeyPair(certBytes, keyBytes)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse CA keypair: %w", err)
	}
	if len(cert.Certificate) == 0 {
		return tls.Certificate{}, errors.New("CA cert chain is empty")
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse CA leaf: %w", err)
	}
	cert.Leaf = leaf
	return cert, nil
}

func (app *proxyApp) callTransform(req *http.Request) (*http.Response, error) {
	headers := removeHopHeaders(cloneHeaders(req.Header))
	headers.Set("X-Iterate-Target-Url", req.URL.String())
	if req.Host != "" {
		headers.Set("X-Iterate-Request-Host", req.Host)
	}
	if req.RemoteAddr != "" {
		headers.Set("X-Iterate-Remote-Addr", req.RemoteAddr)
	}

	transformReq, err := http.NewRequestWithContext(req.Context(), req.Method, app.transformURL, req.Body)
	if err != nil {
		return nil, fmt.Errorf("build transform request: %w", err)
	}
	transformReq.Header = headers
	transformReq.ContentLength = req.ContentLength

	start := time.Now()
	resp, err := app.client.Do(transformReq)
	if err != nil {
		return nil, fmt.Errorf("transform request failed: %w", err)
	}

	app.logf(
		"TRANSFORM_STREAM method=%s target=%q status=%d duration_ms=%d",
		req.Method,
		req.URL.String(),
		resp.StatusCode,
		time.Since(start).Milliseconds(),
	)
	return resp, nil
}

func (app *proxyApp) handleRequest(req *http.Request) (*http.Request, *http.Response) {
	start := time.Now()
	app.logf("MITM_REQUEST method=%s url=%q", req.Method, req.URL.String())

	resp, err := app.callTransform(req)
	if err != nil {
		app.logf("MITM_TRANSFORM_ERROR method=%s url=%q err=%q", req.Method, req.URL.String(), err.Error())
		return req, goproxy.NewResponse(req, goproxy.ContentTypeText, http.StatusBadGateway, "transform failed")
	}

	resp.Request = req
	resp.Header.Set("X-Iterate-MITM", "1")
	app.logf(
		"MITM_RESPONSE method=%s url=%q status=%d duration_ms=%d",
		req.Method,
		req.URL.String(),
		resp.StatusCode,
		time.Since(start).Milliseconds(),
	)
	return req, resp
}

func main() {
	listenAddr := flag.String("listen", ":18080", "MITM proxy listen address")
	transformURL := flag.String("transform-url", "http://127.0.0.1:19090/transform", "URL of local transform service")
	caCertPath := flag.String("ca-cert", "/data/mitm/ca.crt", "Path to CA certificate PEM")
	caKeyPath := flag.String("ca-key", "/data/mitm/ca.key", "Path to CA private key PEM")
	logPath := flag.String("log", "/tmp/egress-proxy.log", "Path to append log lines")
	flag.Parse()

	app, err := newProxyApp(*transformURL, *logPath)
	if err != nil {
		panic(err)
	}
	defer app.close()

	ca, err := parseCA(*caCertPath, *caKeyPath)
	if err != nil {
		app.logf("FATAL failed_to_load_ca err=%q", err.Error())
		os.Exit(1)
	}
	goproxy.GoproxyCa = ca

	proxy := goproxy.NewProxyHttpServer()
	proxy.Verbose = false
	proxy.CertStore = newCertStorage()
	proxy.NonproxyHandler = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok\n"))
			return
		}
		http.Error(w, "proxy endpoint", http.StatusBadRequest)
	})
	proxy.OnRequest().HandleConnect(goproxy.AlwaysMitm)
	proxy.OnRequest().DoFunc(func(req *http.Request, _ *goproxy.ProxyCtx) (*http.Request, *http.Response) {
		return app.handleRequest(req)
	})

	app.logf("MITM_BOOT pid=%d listen=%s transform_url=%q", os.Getpid(), *listenAddr, *transformURL)
	server := &http.Server{
		Addr:              *listenAddr,
		Handler:           proxy,
		ReadHeaderTimeout: 20 * time.Second,
	}
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		app.logf("FATAL server_error err=%q", err.Error())
		os.Exit(1)
	}
}
