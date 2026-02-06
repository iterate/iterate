package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/elazarl/goproxy"
)

type transformRequest struct {
	Method     string              `json:"method"`
	URL        string              `json:"url"`
	Headers    map[string][]string `json:"headers"`
	BodyBase64 string              `json:"bodyBase64,omitempty"`
	RemoteAddr string              `json:"remoteAddr,omitempty"`
}

type transformResponse struct {
	Status     int                 `json:"status"`
	Headers    map[string][]string `json:"headers"`
	BodyBase64 string              `json:"bodyBase64,omitempty"`
}

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
	transformURL        string
	client              *http.Client
	logger              *log.Logger
	logFile             *os.File
	requestPreviewBytes int
}

func newProxyApp(transformURL, logPath string, requestPreviewBytes int) (*proxyApp, error) {
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open log file: %w", err)
	}
	logger := log.New(io.MultiWriter(os.Stdout, logFile), "", 0)
	return &proxyApp{
		transformURL: transformURL,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
		logger:              logger,
		logFile:             logFile,
		requestPreviewBytes: requestPreviewBytes,
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

func sanitizePreview(input []byte, limit int) string {
	if limit <= 0 || len(input) == 0 {
		return ""
	}
	if len(input) > limit {
		input = input[:limit]
	}
	return base64.StdEncoding.EncodeToString(input)
}

func removeHopHeaders(headers map[string][]string) map[string][]string {
	out := map[string][]string{}
	for key, values := range headers {
		lower := strings.ToLower(key)
		switch lower {
		case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
			continue
		case "proxy-connection", "proxy-authentication", "host":
			continue
		default:
			copied := make([]string, len(values))
			copy(copied, values)
			out[key] = copied
		}
	}
	return out
}

func (app *proxyApp) callTransform(payload transformRequest) (transformResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return transformResponse{}, fmt.Errorf("marshal transform payload: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, app.transformURL, bytes.NewReader(body))
	if err != nil {
		return transformResponse{}, fmt.Errorf("build transform request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Length", strconv.Itoa(len(body)))

	start := time.Now()
	resp, err := app.client.Do(req)
	if err != nil {
		return transformResponse{}, fmt.Errorf("transform request failed: %w", err)
	}
	defer resp.Body.Close()
	duration := time.Since(start)

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return transformResponse{}, fmt.Errorf("read transform response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return transformResponse{}, fmt.Errorf("transform status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var parsed transformResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return transformResponse{}, fmt.Errorf("parse transform response: %w", err)
	}
	app.logf("TRANSFORM_ROUNDTRIP status=%d duration_ms=%d bytes=%d", parsed.Status, duration.Milliseconds(), len(respBody))
	return parsed, nil
}

func (app *proxyApp) handleRequest(req *http.Request) (*http.Request, *http.Response) {
	start := time.Now()
	rawBody := []byte{}
	if req.Body != nil {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			app.logf("MITM_REQUEST_ERROR url=%q err=%q", req.URL.String(), err.Error())
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, http.StatusBadRequest, "failed to read request body")
		}
		rawBody = body
	}

	reqHeaders := map[string][]string{}
	for key, values := range req.Header {
		copied := make([]string, len(values))
		copy(copied, values)
		reqHeaders[key] = copied
	}
	if req.Host != "" {
		reqHeaders["Host"] = []string{req.Host}
	}
	reqHeaders = removeHopHeaders(reqHeaders)

	preview := sanitizePreview(rawBody, app.requestPreviewBytes)
	app.logf(
		"MITM_REQUEST method=%s url=%q body_bytes=%d body_preview_b64=%q",
		req.Method,
		req.URL.String(),
		len(rawBody),
		preview,
	)

	payload := transformRequest{
		Method:     req.Method,
		URL:        req.URL.String(),
		Headers:    reqHeaders,
		RemoteAddr: req.RemoteAddr,
	}
	if len(rawBody) > 0 {
		payload.BodyBase64 = base64.StdEncoding.EncodeToString(rawBody)
	}

	tr, err := app.callTransform(payload)
	if err != nil {
		app.logf("MITM_TRANSFORM_ERROR method=%s url=%q err=%q", req.Method, req.URL.String(), err.Error())
		return req, goproxy.NewResponse(req, goproxy.ContentTypeText, http.StatusBadGateway, "transform failed")
	}

	decodedBody, err := base64.StdEncoding.DecodeString(tr.BodyBase64)
	if err != nil {
		app.logf("MITM_DECODE_ERROR method=%s url=%q err=%q", req.Method, req.URL.String(), err.Error())
		return req, goproxy.NewResponse(req, goproxy.ContentTypeText, http.StatusBadGateway, "invalid transform payload")
	}

	resp := &http.Response{
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		StatusCode:    tr.Status,
		Status:        fmt.Sprintf("%d %s", tr.Status, http.StatusText(tr.Status)),
		Header:        make(http.Header),
		Body:          io.NopCloser(bytes.NewReader(decodedBody)),
		ContentLength: int64(len(decodedBody)),
		Request:       req,
	}
	for key, values := range tr.Headers {
		lower := strings.ToLower(key)
		if lower == "content-length" || lower == "transfer-encoding" {
			continue
		}
		for _, value := range values {
			resp.Header.Add(key, value)
		}
	}
	resp.Header.Set("Content-Length", strconv.Itoa(len(decodedBody)))
	resp.Header.Set("X-Iterate-MITM", "1")

	app.logf(
		"MITM_RESPONSE method=%s url=%q status=%d body_bytes=%d duration_ms=%d",
		req.Method,
		req.URL.String(),
		tr.Status,
		len(decodedBody),
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
	requestPreviewBytes := flag.Int("request-preview-bytes", 512, "max bytes from request body logged as base64")
	flag.Parse()

	app, err := newProxyApp(*transformURL, *logPath, *requestPreviewBytes)
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
