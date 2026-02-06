package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/elazarl/goproxy"
)

type certStorage struct {
	certs sync.Map
}

func (cs *certStorage) Fetch(hostname string, gen func() (*tls.Certificate, error)) (*tls.Certificate, error) {
	if cached, ok := cs.certs.Load(hostname); ok {
		return cached.(*tls.Certificate), nil
	}

	cert, err := gen()
	if err != nil {
		return nil, err
	}
	if cached, loaded := cs.certs.LoadOrStore(hostname, cert); loaded {
		return cached.(*tls.Certificate), nil
	}
	return cert, nil
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

func appendXForwardedFor(headers http.Header, remoteAddr string) {
	if remoteAddr == "" {
		return
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	host = strings.TrimSpace(host)
	if host == "" {
		return
	}

	headers.Set("X-Forwarded-For", host)
}

func buildTransformURL(base *url.URL, target *url.URL) string {
	next := *base
	next.Path = target.Path
	next.RawPath = target.RawPath
	if next.Path == "" {
		next.Path = "/"
	}
	next.RawQuery = target.RawQuery
	next.Fragment = ""
	return next.String()
}

func setForwardedHeaders(headers http.Header, req *http.Request, targetHost string) {
	if targetHost == "" {
		targetHost = req.URL.Host
	}
	if targetHost == "" {
		targetHost = req.Host
	}
	targetProto := strings.ToLower(req.URL.Scheme)
	if targetProto != "http" && targetProto != "https" {
		targetProto = "http"
	}
	if targetHost != "" {
		headers.Set("X-Forwarded-Host", targetHost)
	}
	headers.Set("X-Forwarded-Proto", targetProto)
	if port := req.URL.Port(); port != "" {
		headers.Set("X-Forwarded-Port", port)
	} else {
		headers.Del("X-Forwarded-Port")
	}
	appendXForwardedFor(headers, req.RemoteAddr)
	headers.Del("Forwarded")
}

func main() {
	listenAddr := flag.String("listen", ":18080", "MITM proxy listen address")
	transformURL := flag.String("transform-url", "http://127.0.0.1:18081", "Base URL of local transform service")
	caCertPath := flag.String("ca-cert", "/data/mitm/ca.crt", "Path to CA certificate PEM")
	caKeyPath := flag.String("ca-key", "/data/mitm/ca.key", "Path to CA private key PEM")
	flag.Parse()

	logger := log.New(os.Stdout, "", 0)
	logf := func(format string, args ...any) {
		logger.Printf("%s %s", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
	}

	transformBaseURL, err := url.Parse(*transformURL)
	if err != nil {
		panic(fmt.Errorf("parse transform url: %w", err))
	}

	client := &http.Client{
		Timeout: 90 * time.Second,
		Transport: &http.Transport{
			Proxy: nil,
		},
	}

	ca, err := parseCA(*caCertPath, *caKeyPath)
	if err != nil {
		logf("FATAL failed_to_load_ca err=%q", err.Error())
		os.Exit(1)
	}
	goproxy.GoproxyCa = ca

	proxy := goproxy.NewProxyHttpServer()
	proxy.Verbose = false
	proxy.CertStore = &certStorage{}
	proxy.OnRequest().HandleConnect(goproxy.AlwaysMitm)
	proxy.OnRequest().DoFunc(func(req *http.Request, _ *goproxy.ProxyCtx) (*http.Request, *http.Response) {
		start := time.Now()
		target := req.URL.String()
		logf("MITM_REQUEST method=%s target=%q", req.Method, target)

		transformReq, err := http.NewRequestWithContext(
			req.Context(),
			req.Method,
			buildTransformURL(transformBaseURL, req.URL),
			req.Body,
		)
		if err != nil {
			logf("MITM_ERROR method=%s target=%q err=%q", req.Method, target, err.Error())
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, http.StatusBadGateway, "transform request build failed")
		}

		transformReq.Header = req.Header.Clone()
		setForwardedHeaders(transformReq.Header, req, req.URL.Host)
		transformReq.ContentLength = req.ContentLength

		resp, err := client.Do(transformReq)
		if err != nil {
			logf("MITM_ERROR method=%s target=%q err=%q", req.Method, target, err.Error())
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, http.StatusBadGateway, "transform request failed")
		}

		resp.Request = req
		logf("MITM_RESPONSE method=%s target=%q status=%d duration_ms=%d", req.Method, target, resp.StatusCode, time.Since(start).Milliseconds())
		return req, resp
	})

	logf("MITM_LISTEN addr=%s transform=%q", *listenAddr, *transformURL)
	if err := http.ListenAndServe(*listenAddr, proxy); err != nil {
		logf("FATAL listen_failed err=%q", err.Error())
		os.Exit(1)
	}
}
