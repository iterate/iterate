// workspace-prototype mounts a manifest without copying its file contents.
package main

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

var readBase = flag.String("read-url", "", "direct immutable read URL")

var client = &http.Client{Timeout: 30 * time.Second}

type entry struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Mode      string `json:"mode"`
	Version   string `json:"version"`
	RepoPath  string `json:"repoPath,omitempty"`
	ReadToken string `json:"readToken,omitempty"`
}
type metrics struct{ fileReads, readBytes atomic.Uint64 }
type file struct {
	fs.Inode
	e           entry
	mode        uint32
	cache, base string
	metrics     *metrics
	mu          sync.Mutex
	data        []byte
}
type root struct {
	fs.Inode
	entries     []entry
	cache, base string
	metrics     *metrics
}

func valid(e entry) (uint32, error) {
	p := filepath.ToSlash(filepath.Clean(e.Path))
	if e.Path == "" || p == "." || p == ".." || strings.HasPrefix(p, "../") || strings.HasPrefix(p, "/") || p != e.Path || e.Size < 0 {
		return 0, fmt.Errorf("invalid entry %q", e.Path)
	}
	var m uint32
	if _, err := fmt.Sscanf(e.Mode, "%o", &m); err != nil || (m != 0100644 && m != 0100755 && m != 0120000) {
		return 0, fmt.Errorf("invalid mode for %q", e.Path)
	}
	if !strings.HasPrefix(e.Version, "git:") && !strings.HasPrefix(e.Version, "sha256:") {
		return 0, fmt.Errorf("invalid version for %q", e.Path)
	}
	return m, nil
}

func (r *root) OnAdd(ctx context.Context) {
	for _, e := range r.entries {
		m, _ := valid(e)
		parts := strings.Split(e.Path, "/")
		p := &r.Inode
		for _, name := range parts[:len(parts)-1] {
			if c := p.GetChild(name); c != nil {
				p = c
			} else {
				c = p.NewPersistentInode(ctx, &fs.Inode{}, fs.StableAttr{Mode: syscall.S_IFDIR | 0755})
				p.AddChild(name, c, true)
				p = c
			}
		}
		n := &file{e: e, mode: m, cache: r.cache, base: r.base, metrics: r.metrics}
		p.AddChild(parts[len(parts)-1], p.NewPersistentInode(ctx, n, fs.StableAttr{Mode: m}), true)
	}
}

func (f *file) Getattr(_ context.Context, _ fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Size = uint64(f.e.Size)
	out.Mode = f.mode
	return 0
}
func (f *file) Open(_ context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&(syscall.O_WRONLY|syscall.O_RDWR|syscall.O_APPEND|syscall.O_TRUNC|syscall.O_CREAT) != 0 {
		return nil, 0, syscall.EROFS
	}
	return nil, 0, 0
}
func (f *file) Read(_ context.Context, _ fs.FileHandle, dst []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	b, err := f.contents()
	if err != nil {
		log.Printf("workspace FUSE read %q: %v", f.e.Path, err)
		return nil, syscall.EIO
	}
	if off < 0 {
		log.Printf("workspace FUSE read %q: negative offset", f.e.Path)
		return nil, syscall.EIO
	}
	if off >= int64(len(b)) {
		return fuse.ReadResultData(nil), 0
	}
	end := off + int64(len(dst))
	if end > int64(len(b)) {
		end = int64(len(b))
	}
	return fuse.ReadResultData(b[off:end]), 0
}
func (f *file) Readlink(_ context.Context) ([]byte, syscall.Errno) {
	b, err := f.contents()
	if err != nil {
		log.Printf("workspace FUSE readlink %q: %v", f.e.Path, err)
		return nil, syscall.EIO
	}
	return b, 0
}

func (f *file) contents() ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.data != nil {
		return f.data, nil
	}
	h := sha256.Sum256([]byte(f.e.Version))
	name := hex.EncodeToString(h[:])
	path := filepath.Join(f.cache, name)
	if b, err := os.ReadFile(path); err == nil {
		if err = f.check(b); err == nil {
			f.data = b
			return b, nil
		}
		log.Printf("workspace FUSE cache corrupt for %q; refetching: %v", f.e.Path, err)
	} else if !errors.Is(err, os.ErrNotExist) {
		log.Printf("workspace FUSE cache read for %q; refetching: %v", f.e.Path, err)
	}
	readURL := ""
	if f.e.ReadToken != "" {
		u, err := url.Parse(*readBase)
		if err != nil {
			return nil, err
		}
		q := u.Query()
		q.Set("repoPath", f.e.RepoPath)
		q.Set("oid", strings.TrimPrefix(f.e.Version, "git:"))
		u.RawQuery = q.Encode()
		readURL = u.String()
	} else {
		u, _ := url.Parse(f.base + "/file")
		q := u.Query()
		q.Set("path", f.e.Path)
		q.Set("version", f.e.Version)
		u.RawQuery = q.Encode()
		readURL = u.String()
	}
	req, err := http.NewRequest(http.MethodGet, readURL, nil)
	if err != nil {
		return nil, err
	}
	if f.e.ReadToken != "" {
		req.Header.Set("Authorization", "Bearer "+f.e.ReadToken)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: %s", f.e.Path, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, f.e.Size+1))
	if err != nil {
		return nil, err
	}
	if err = f.check(b); err != nil {
		return nil, err
	}
	f.metrics.fileReads.Add(1)
	f.metrics.readBytes.Add(uint64(len(b)))
	if err = os.MkdirAll(f.cache, 0700); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(f.cache, ".tmp-")
	if err != nil {
		return nil, err
	}
	_, err = tmp.Write(b)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return nil, err
	}
	f.data = b
	return b, nil
}
func (f *file) check(b []byte) error {
	if int64(len(b)) != f.e.Size {
		return fmt.Errorf("size mismatch for %s", f.e.Path)
	}
	var got string
	if strings.HasPrefix(f.e.Version, "git:") {
		h := sha1.New()
		fmt.Fprintf(h, "blob %d\x00", len(b))
		_, _ = h.Write(b)
		got = "git:" + hex.EncodeToString(h.Sum(nil))
	} else {
		h := sha256.Sum256(b)
		got = "sha256:" + hex.EncodeToString(h[:])
	}
	if got != f.e.Version {
		return fmt.Errorf("hash mismatch for %s", f.e.Path)
	}
	return nil
}

func main() {
	manifest, mount, cache, base, metricsPath := flag.String("manifest", "", "manifest JSON"), flag.String("mount", "", "mount point"), flag.String("cache", "", "content cache"), flag.String("url", "http://workspace.internal", "workspace server URL"), flag.String("metrics", "", "metrics output JSON")
	flag.Parse()
	if *manifest == "" || *mount == "" || *cache == "" {
		log.Fatal("--manifest, --mount and --cache are required")
	}
	b, err := os.ReadFile(*manifest)
	if err != nil {
		log.Fatal(err)
	}
	var entries []entry
	if err := json.Unmarshal(b, &entries); err != nil {
		log.Fatal(err)
	}
	seen, descendants := map[string]bool{}, map[string]bool{}
	for _, e := range entries {
		if _, err := valid(e); err != nil {
			log.Fatalf("bad manifest: %v", err)
		}
		if seen[e.Path] || descendants[e.Path] {
			log.Fatalf("bad manifest: file/ancestor collision at %q", e.Path)
		}
		seen[e.Path] = true
		for parent := filepath.ToSlash(filepath.Dir(e.Path)); parent != "."; parent = filepath.ToSlash(filepath.Dir(parent)) {
			if seen[parent] {
				log.Fatalf("bad manifest: file/ancestor collision at %q", parent)
			}
			descendants[parent] = true
		}
	}
	stats := &metrics{}
	s, err := fs.Mount(*mount, &root{entries: entries, cache: *cache, base: strings.TrimRight(*base, "/"), metrics: stats}, &fs.Options{})
	if err != nil {
		log.Fatal(err)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; _ = s.Unmount() }()
	s.Wait()
	if *metricsPath != "" {
		b, err := json.Marshal(map[string]uint64{"fileReads": stats.fileReads.Load(), "readBytes": stats.readBytes.Load()})
		if err == nil {
			err = os.WriteFile(*metricsPath, b, 0600)
		}
		if err != nil {
			log.Fatal(err)
		}
	}
}
