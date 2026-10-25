package main

import (
	"fmt"
	"os"
	"time"
)

// note appends a line to data/supervisor.log.
func note(p Paths, line string) {
	f, err := os.OpenFile(p.File("supervisor.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), line)
}
