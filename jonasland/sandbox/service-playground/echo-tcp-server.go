// A simple TCP echo server for testing the service proxy.
// Listens on the port given as the first argument (or env PORT).
// Echoes back whatever it receives, prefixed with "ECHO: ".
package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" && len(os.Args) > 1 {
		port = os.Args[1]
	}
	if port == "" {
		port = "0"
	}

	listener, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to listen: %v\n", err)
		os.Exit(1)
	}

	// Print the actual port to stdout so the parent process can read it
	addr := listener.Addr().(*net.TCPAddr)
	fmt.Printf("LISTENING:%d\n", addr.Port)
	os.Stdout.Sync()

	for {
		conn, err := listener.Accept()
		if err != nil {
			fmt.Fprintf(os.Stderr, "accept error: %v\n", err)
			continue
		}
		go handleConn(conn)
	}
}

func handleConn(conn net.Conn) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := scanner.Text()
		response := fmt.Sprintf("ECHO: %s\n", line)
		conn.Write([]byte(response))
	}
}
