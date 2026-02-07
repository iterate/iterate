package main

import (
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"

	"github.com/projectdiscovery/martian/v3"
	"github.com/projectdiscovery/proxify"
	"github.com/projectdiscovery/proxify/pkg/certs"
	"github.com/projectdiscovery/proxify/pkg/logger/elastic"
	"github.com/projectdiscovery/proxify/pkg/logger/kafka"
)

func main() {
	port := os.Getenv("MITM_PORT")
	if port == "" {
		port = "18080"
	}
	handlerURL := os.Getenv("HANDLER_URL")
	if handlerURL == "" {
		handlerURL = "http://127.0.0.1:18081/proxy"
	}
	configDir := os.Getenv("PROXIFY_CONFIG_DIR")
	if configDir == "" {
		configDir = "/data/proxify"
	}

	target, err := url.Parse(handlerURL)
	if err != nil {
		log.Fatal(err)
	}
	if err := certs.LoadCerts(configDir); err != nil {
		log.Fatal(err)
	}

	proxy, err := proxify.NewProxy(&proxify.Options{
		ListenAddrHTTP: fmt.Sprintf("0.0.0.0:%s", port),
		CertCacheSize:  256,
		Elastic:        &elastic.Options{},
		Kafka:          &kafka.Options{},
		OnRequestCallback: func(req *http.Request, _ *martian.Context) error {
			if req.Method == http.MethodConnect {
				return nil
			}
			original := req.URL.String()
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.URL.Path = target.Path
			req.URL.RawPath = target.RawPath
			req.URL.RawQuery = target.RawQuery
			req.RequestURI = ""
			req.Host = target.Host
			req.Header.Set("X-Proxy-Target-Url", original)
			return nil
		},
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Fatal(proxy.Run())
}
