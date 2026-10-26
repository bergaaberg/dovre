package main

// The Node runtime the bridge runs on (dovre-site#9): one pinned release, downloaded from
// nodejs.org on first use and checked against the sha256 written here, so the customer installs
// nothing else and a tampered download never runs. Only the node binary is kept, in
// <config>/runtime/node-<version>/. DOVRE_NODE names another node to use instead (a checkout).

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const nodeVersion = "v24.22.1"

// nodeSums: SHASUMS256.txt of nodeVersion, for the archives the bridge ships on.
var nodeSums = map[string]string{
	"node-v24.22.1-darwin-arm64.tar.gz": "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
	"node-v24.22.1-darwin-x64.tar.gz":   "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
	"node-v24.22.1-linux-arm64.tar.gz":  "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
	"node-v24.22.1-linux-x64.tar.gz":    "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
	"node-v24.22.1-win-arm64.zip":       "a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171",
	"node-v24.22.1-win-x64.zip":         "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5",
}

// NodeArchive: the release archive for an OS and architecture, and the node binary's path inside it.
func NodeArchive(goos, goarch string) (archive, member string, err error) {
	osName := map[string]string{"darwin": "darwin", "linux": "linux", "windows": "win"}[goos]
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[goarch]
	if osName == "" || arch == "" {
		return "", "", fmt.Errorf("the bridge doesn't run on %s/%s", goos, goarch)
	}
	stem := fmt.Sprintf("node-%s-%s-%s", nodeVersion, osName, arch)
	if goos == "windows" {
		return stem + ".zip", stem + "/node.exe", nil
	}
	return stem + ".tar.gz", stem + "/bin/node", nil
}

// ensureNode: the pinned node, downloaded into runtimeDir the first time.
func ensureNode(runtimeDir string, out io.Writer) (string, error) {
	if n := os.Getenv("DOVRE_NODE"); n != "" {
		return n, nil
	}
	archive, member, err := NodeArchive(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	return installNode(runtimeDir, "https://nodejs.org/dist/"+nodeVersion+"/", archive, member, nodeSums[archive], out)
}

// installNode downloads base+archive, checks it against sum, and keeps only `member`.
func installNode(runtimeDir, base, archive, member, sum string, out io.Writer) (string, error) {
	name := "node"
	if filepath.Ext(member) == ".exe" {
		name = "node.exe"
	}
	dest := filepath.Join(runtimeDir, "node-"+nodeVersion, name)
	if exists(dest) {
		return dest, nil
	}
	if sum == "" {
		return "", fmt.Errorf("no checksum for %s", archive)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	fmt.Fprintf(out, "Downloading Node %s (once)…\n", nodeVersion)
	tmp, err := os.CreateTemp(runtimeDir, ".download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	c := http.Client{Timeout: 10 * time.Minute}
	res, err := c.Get(base + archive)
	if err != nil {
		return "", fmt.Errorf("downloading Node: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("downloading Node: %s", res.Status)
	}
	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, h), res.Body)
	if err != nil {
		return "", fmt.Errorf("downloading Node: %w", err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != sum {
		return "", fmt.Errorf("the Node download didn't match its checksum (got %s): not used", got)
	}
	part := dest + ".part"
	if err := extractMember(tmp, size, archive, member, part); err != nil {
		os.Remove(part)
		return "", err
	}
	if err := os.Rename(part, dest); err != nil {
		return "", err
	}
	return dest, nil
}

// extractMember writes one file of a .tar.gz or .zip to `to`, executable.
func extractMember(f *os.File, size int64, archive, member, to string) error {
	w, err := os.OpenFile(to, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer w.Close()
	if filepath.Ext(archive) == ".zip" {
		zr, err := zip.NewReader(f, size)
		if err != nil {
			return err
		}
		for _, zf := range zr.File {
			if zf.Name != member {
				continue
			}
			r, err := zf.Open()
			if err != nil {
				return err
			}
			defer r.Close()
			_, err = io.Copy(w, r)
			return err
		}
		return fmt.Errorf("%s has no %s", archive, member)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		hd, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("%s has no %s", archive, member)
		}
		if err != nil {
			return err
		}
		if hd.Name == member && hd.Typeflag == tar.TypeReg {
			_, err = io.Copy(w, tr)
			return err
		}
	}
}
