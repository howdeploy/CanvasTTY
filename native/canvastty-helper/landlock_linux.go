//go:build linux

package main

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

const (
	closeRangeSyscall            = 436
	landlockCreateRulesetSyscall = 444
	landlockAddRuleSyscall       = 445
	landlockRestrictSelfSyscall  = 446

	closeRangeCloexec            = 1 << 2
	landlockCreateRulesetVersion = 1
	landlockRulePathBeneath      = 1
	landlockRestrictSelfTSYNC    = 1 << 3

	landlockAccessFSRefer       = 1 << 13
	landlockAccessFSResolveUnix = 1 << 16
	landlockScopeAbstractUnix   = 1 << 0

	prSetNoNewPrivs = 38
	oPath           = 0x200000
)

type landlockRulesetAttr struct {
	handledAccessFS  uint64
	handledAccessNet uint64
	scoped           uint64
}

// The kernel's landlock_path_beneath_attr is packed (12 bytes). Go's natural struct padding is harmless here: the
// kernel copies the packed 12-byte UAPI prefix, and the pointer remains 8-byte aligned.
type landlockPathBeneathAttr struct {
	allowedAccess uint64
	parentFD      int32
}

type landlockSocketIdentity struct {
	device uint64
	inode  uint64
}

type landlockSocketRule struct {
	fd   int
	path string
}

// installUnixSocketGuard permits externally created pathname sockets only when their exact socket inode was granted.
// Landlock's ABI 9 RESOLVE_UNIX right leaves sockets created inside this domain available to same-domain servers.
func installUnixSocketGuard(allowedSocketPaths []string) error {
	abi, err := landlockABIVersion()
	if err != nil {
		return err
	}
	if abi < 9 {
		return fmt.Errorf("Landlock ABI %d is too old; ABI 9 is required", abi)
	}

	openFDs := make([]int, 0, len(allowedSocketPaths)+1)
	defer func() {
		for _, fd := range openFDs {
			_ = syscall.Close(fd)
		}
	}()

	rootFD, err := openLandlockPath("/")
	if err != nil {
		return fmt.Errorf("open / for the cross-directory rename rule: %w", err)
	}
	openFDs = append(openFDs, rootFD)

	socketRules := make([]landlockSocketRule, 0, len(allowedSocketPaths))
	identities := make(map[landlockSocketIdentity]struct{}, len(allowedSocketPaths))
	for _, path := range allowedSocketPaths {
		fd, openErr := openLandlockPath(path)
		if openErr != nil {
			return fmt.Errorf("open allowed Unix socket %q: %w", path, openErr)
		}
		openFDs = append(openFDs, fd)

		var stat syscall.Stat_t
		if statErr := syscall.Fstat(fd, &stat); statErr != nil {
			return fmt.Errorf("inspect allowed Unix socket %q: %w", path, statErr)
		}
		if stat.Mode&syscall.S_IFMT != syscall.S_IFSOCK {
			return fmt.Errorf("allowed Unix socket %q is not a socket", path)
		}
		identity := landlockSocketIdentity{device: uint64(stat.Dev), inode: stat.Ino}
		if _, exists := identities[identity]; exists {
			continue
		}
		identities[identity] = struct{}{}
		socketRules = append(socketRules, landlockSocketRule{fd: fd, path: path})
	}

	attr := landlockRulesetAttr{
		handledAccessFS: landlockAccessFSRefer | landlockAccessFSResolveUnix,
		scoped:          landlockScopeAbstractUnix,
	}
	rulesetFD, _, errno := syscall.RawSyscall(landlockCreateRulesetSyscall,
		uintptr(unsafe.Pointer(&attr)), unsafe.Sizeof(attr), 0)
	runtime.KeepAlive(&attr)
	if errno != 0 {
		return fmt.Errorf("create Landlock ruleset: %w", errno)
	}
	defer syscall.Close(int(rulesetFD))

	if err := addLandlockPathRule(int(rulesetFD), rootFD, landlockAccessFSRefer); err != nil {
		return fmt.Errorf("allow cross-directory rename and link operations: %w", err)
	}
	for _, rule := range socketRules {
		if err := addLandlockPathRule(int(rulesetFD), rule.fd, landlockAccessFSResolveUnix); err != nil {
			return fmt.Errorf("allow Unix socket %q: %w", rule.path, err)
		}
	}
	// Keep inherited descriptors available to this helper and the Go runtime, but never pass them through exec to
	// the agent. close_range(CLOSE_RANGE_CLOEXEC) makes preopened non-CLOEXEC descriptors safe without closing them.
	if _, _, errno := syscall.RawSyscall(closeRangeSyscall, 3, uintptr(^uint32(0)), closeRangeCloexec); errno != 0 {
		return fmt.Errorf("mark inherited descriptors close-on-exec: %w", errno)
	}

	// no_new_privs is per-thread. Keep this goroutine on the same OS thread through restrict_self(TSYNC), which
	// applies the Landlock domain to every Go runtime thread before any application goroutine or child is started.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0); errno != 0 {
		return fmt.Errorf("set no_new_privs: %w", errno)
	}
	if _, _, errno := syscall.RawSyscall(landlockRestrictSelfSyscall,
		rulesetFD, landlockRestrictSelfTSYNC, 0); errno != 0 {
		return fmt.Errorf("restrict all process threads with Landlock: %w", errno)
	}
	return nil
}

func landlockABIVersion() (int, error) {
	abi, _, errno := syscall.RawSyscall(landlockCreateRulesetSyscall, 0, 0, landlockCreateRulesetVersion)
	if errno != 0 {
		return 0, fmt.Errorf("query Landlock ABI: %w", errno)
	}
	return int(abi), nil
}

func openLandlockPath(path string) (int, error) {
	return syscall.Open(path, oPath|syscall.O_CLOEXEC, 0)
}

func addLandlockPathRule(rulesetFD, parentFD int, allowedAccess uint64) error {
	rule := landlockPathBeneathAttr{allowedAccess: allowedAccess, parentFD: int32(parentFD)}
	_, _, errno := syscall.RawSyscall6(landlockAddRuleSyscall,
		uintptr(rulesetFD), landlockRulePathBeneath, uintptr(unsafe.Pointer(&rule)), 0, 0, 0)
	runtime.KeepAlive(&rule)
	if errno != 0 {
		return errno
	}
	return nil
}
