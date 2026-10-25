//go:build windows

package main

// ConPTY, straight from kernel32 (no packages to fetch): a pseudo console, the program started
// suspended inside it, put in a job object that kills the whole tree when the host goes, then
// resumed.

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var (
	k32                                   = syscall.NewLazyDLL("kernel32.dll")
	procCreatePseudoConsole               = k32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole               = k32.NewProc("ResizePseudoConsole")
	procClosePseudoConsole                = k32.NewProc("ClosePseudoConsole")
	procInitializeProcThreadAttributeList = k32.NewProc("InitializeProcThreadAttributeList")
	procUpdateProcThreadAttribute         = k32.NewProc("UpdateProcThreadAttribute")
	procDeleteProcThreadAttributeList     = k32.NewProc("DeleteProcThreadAttributeList")
	procCreateProcessW                    = k32.NewProc("CreateProcessW")
	procCreateJobObjectW                  = k32.NewProc("CreateJobObjectW")
	procSetInformationJobObject           = k32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject          = k32.NewProc("AssignProcessToJobObject")
	procResumeThread                      = k32.NewProc("ResumeThread")
	procTerminateJobObject                = k32.NewProc("TerminateJobObject")
)

const (
	procThreadAttributePseudoConsole = 0x00020016
	extendedStartupInfoPresent       = 0x00080000
	createSuspended                  = 0x00000004
	createUnicodeEnvironment         = 0x00000400
	jobObjectExtendedLimitInfo       = 9
	jobObjectLimitKillOnJobClose     = 0x00002000
)

type startupInfoEx struct {
	si    syscall.StartupInfo
	attrs uintptr
}

type jobBasicLimit struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobExtendedLimit struct {
	Basic                 jobBasicLimit
	IoInfo                [6]uint64
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type conPTY struct {
	hpc     uintptr
	in      *os.File
	out     *os.File
	process syscall.Handle
	job     uintptr
	once    sync.Once
}

func coord(cols, rows int) uintptr { return uintptr(uint32(uint16(cols)) | uint32(uint16(rows))<<16) }

// StartConsole runs argv in a pseudo console of cols × rows, in cwd.
func StartConsole(argv []string, cwd string, cols, rows int) (Console, error) {
	if err := procCreatePseudoConsole.Find(); err != nil {
		return nil, errors.New("this Windows has no pseudo console (ConPTY needs Windows 10 1809 or later)")
	}
	var inR, inW, outR, outW syscall.Handle
	if err := syscall.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, err
	}
	if err := syscall.CreatePipe(&outR, &outW, nil, 0); err != nil {
		return nil, err
	}
	var hpc uintptr
	if r, _, _ := procCreatePseudoConsole.Call(coord(cols, rows), uintptr(inR), uintptr(outW), 0, uintptr(unsafe.Pointer(&hpc))); r != 0 {
		return nil, fmt.Errorf("CreatePseudoConsole: 0x%x", r)
	}
	// The pseudo console holds its own copies now.
	_ = syscall.CloseHandle(inR)
	_ = syscall.CloseHandle(outW)

	var size uintptr
	procInitializeProcThreadAttributeList.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	attrs := make([]byte, size)
	if r, _, err := procInitializeProcThreadAttributeList.Call(uintptr(unsafe.Pointer(&attrs[0])), 1, 0, uintptr(unsafe.Pointer(&size))); r == 0 {
		return nil, fmt.Errorf("InitializeProcThreadAttributeList: %v", err)
	}
	defer procDeleteProcThreadAttributeList.Call(uintptr(unsafe.Pointer(&attrs[0])))
	if r, _, err := procUpdateProcThreadAttribute.Call(uintptr(unsafe.Pointer(&attrs[0])), 0, procThreadAttributePseudoConsole, hpc, unsafe.Sizeof(hpc), 0, 0); r == 0 {
		return nil, fmt.Errorf("UpdateProcThreadAttribute: %v", err)
	}
	var si startupInfoEx
	si.si.Cb = uint32(unsafe.Sizeof(si))
	// This host's own stdio is pipes to the server; without this the program would get those
	// instead of the pseudo console.
	si.si.Flags = syscall.STARTF_USESTDHANDLES
	si.attrs = uintptr(unsafe.Pointer(&attrs[0]))

	quoted := make([]string, len(argv))
	for i, a := range argv {
		quoted[i] = syscall.EscapeArg(a)
	}
	cmdline, err := syscall.UTF16PtrFromString(strings.Join(quoted, " "))
	if err != nil {
		return nil, err
	}
	var dir *uint16
	if cwd != "" {
		if dir, err = syscall.UTF16PtrFromString(cwd); err != nil {
			return nil, err
		}
	}
	var pi syscall.ProcessInformation
	if r, _, err := procCreateProcessW.Call(0, uintptr(unsafe.Pointer(cmdline)), 0, 0, 0, extendedStartupInfoPresent|createSuspended|createUnicodeEnvironment, 0, uintptr(unsafe.Pointer(dir)), uintptr(unsafe.Pointer(&si)), uintptr(unsafe.Pointer(&pi))); r == 0 {
		procClosePseudoConsole.Call(hpc)
		return nil, fmt.Errorf("couldn't start %s: %v", argv[0], err)
	}
	// Everything the program starts dies with this host: closing the last handle kills the job.
	job, _, _ := procCreateJobObjectW.Call(0, 0)
	if job != 0 {
		var info jobExtendedLimit
		info.Basic.LimitFlags = jobObjectLimitKillOnJobClose
		procSetInformationJobObject.Call(job, jobObjectExtendedLimitInfo, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
		procAssignProcessToJobObject.Call(job, uintptr(pi.Process))
	}
	procResumeThread.Call(uintptr(pi.Thread))
	_ = syscall.CloseHandle(pi.Thread)
	return &conPTY{hpc: hpc, in: os.NewFile(uintptr(inW), "pty-in"), out: os.NewFile(uintptr(outR), "pty-out"), process: pi.Process, job: job}, nil
}

func (c *conPTY) Read(p []byte) (int, error)  { return c.out.Read(p) }
func (c *conPTY) Write(p []byte) (int, error) { return c.in.Write(p) }
func (c *conPTY) Resize(cols, rows int) error {
	if r, _, _ := procResizePseudoConsole.Call(c.hpc, coord(cols, rows)); r != 0 {
		return fmt.Errorf("ResizePseudoConsole: 0x%x", r)
	}
	return nil
}

func (c *conPTY) Wait() int {
	_, _ = syscall.WaitForSingleObject(c.process, syscall.INFINITE)
	var code uint32
	_ = syscall.GetExitCodeProcess(c.process, &code)
	c.close()
	return int(code)
}

func (c *conPTY) Kill() {
	if c.job != 0 {
		procTerminateJobObject.Call(c.job, 1)
	} else {
		_ = syscall.TerminateProcess(c.process, 1)
	}
}

// close ends the pseudo console, which ends its output once it's drained.
func (c *conPTY) close() {
	c.once.Do(func() {
		procClosePseudoConsole.Call(c.hpc)
		_ = c.in.Close()
	})
}
