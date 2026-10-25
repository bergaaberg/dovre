package main

// `dovre pty-host --cols C --rows R --cwd DIR -- <program> [args]`: one terminal for Dovre
// (src/packs/core/terminal/), a pseudo console (ConPTY) around a shell or an agent CLI. It talks to the
// server over stdio in frames, so the server never starts the program itself (starting
// claude.exe stalls whoever starts it ~1 s here, and the server must not stall). When the
// server goes away (its end of stdin closes), the program and everything it started go too:
// the host puts them in a job object that dies with it. Nothing is written to disk.
//
// A frame is one kind byte, a little-endian uint32 length, and the payload.
//   server → host: 'i' input bytes, 'r' resize (cols, rows: uint16 LE each), 'k' kill
//   host → server: 'o' output bytes, 'x' exit ({"code":N}), 'e' a reason it couldn't start

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"sync"
)

// Frame writes one frame.
func Frame(w io.Writer, kind byte, payload []byte) error {
	head := make([]byte, 5)
	head[0] = kind
	binary.LittleEndian.PutUint32(head[1:], uint32(len(payload)))
	if _, err := w.Write(append(head, payload...)); err != nil {
		return err
	}
	return nil
}

// ReadFrame reads one frame; a frame over 1 MiB is refused (the server never sends one).
func ReadFrame(r io.Reader) (byte, []byte, error) {
	head := make([]byte, 5)
	if _, err := io.ReadFull(r, head); err != nil {
		return 0, nil, err
	}
	n := binary.LittleEndian.Uint32(head[1:])
	if n > 1<<20 {
		return 0, nil, errors.New("frame too big")
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return head[0], payload, nil
}

// Size reads a resize frame's payload.
func Size(p []byte) (cols, rows int, ok bool) {
	if len(p) != 4 {
		return 0, 0, false
	}
	cols, rows = int(binary.LittleEndian.Uint16(p)), int(binary.LittleEndian.Uint16(p[2:]))
	return cols, rows, cols > 0 && rows > 0 && cols <= 1000 && rows <= 500
}

// Console is a running program in a pseudo console.
type Console interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Resize(cols, rows int) error
	// Wait returns the exit code when the program ends.
	Wait() int
	Kill()
}

func ptyHost(args []string) error {
	fs := flag.NewFlagSet("pty-host", flag.ContinueOnError)
	cols := fs.Int("cols", 120, "columns")
	rows := fs.Int("rows", 32, "rows")
	cwd := fs.String("cwd", "", "folder")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) == 0 {
		return errors.New("usage: dovre pty-host --cols C --rows R --cwd DIR -- <program> [args]")
	}
	out := bufio.NewWriterSize(os.Stdout, 64*1024)
	var mu sync.Mutex
	send := func(kind byte, p []byte) {
		mu.Lock()
		defer mu.Unlock()
		_ = Frame(out, kind, p)
		_ = out.Flush()
	}
	con, err := StartConsole(rest, *cwd, *cols, *rows)
	if err != nil {
		send('e', []byte(err.Error()))
		send('x', []byte(`{"code":-1}`))
		return nil
	}
	// The server's side: input, resizes, kill. When it closes, the terminal ends.
	go func() {
		r := bufio.NewReader(os.Stdin)
		for {
			kind, p, err := ReadFrame(r)
			if err != nil {
				con.Kill()
				return
			}
			switch kind {
			case 'i':
				_, _ = con.Write(p)
			case 'r':
				if c, rw, ok := Size(p); ok {
					_ = con.Resize(c, rw)
				}
			case 'k':
				con.Kill()
			}
		}
	}()
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := con.Read(buf)
			if n > 0 {
				send('o', buf[:n])
			}
			if err != nil {
				close(done)
				return
			}
		}
	}()
	code := con.Wait()
	<-done
	b, _ := json.Marshal(map[string]int{"code": code})
	send('x', b)
	return nil
}
