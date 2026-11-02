package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRunScript(t *testing.T) {
	empty, core := t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(core, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(core, "src", "run.ts"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := RunScript(empty, "", core); got != filepath.Join(core, "src", "run.ts") {
		t.Errorf("RunScript = %q", got)
	}
	if got := RunScript(empty, ""); got != "" {
		t.Errorf("no core: RunScript = %q", got)
	}
}
