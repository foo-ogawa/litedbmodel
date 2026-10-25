//go:build darwin || linux

package litedbmodel_runtime

import (
	"net"
	"syscall"
	"testing"
	"time"
)

// socketKeepAlive reads a TCP socket's SO_KEEPALIVE and its idle time before the first keepalive probe
// (tcpKeepIdleOpt: TCP_KEEPALIVE on darwin, TCP_KEEPIDLE on linux — both in seconds).
func socketKeepAlive(t *testing.T, conn *net.TCPConn) (bool, time.Duration) {
	t.Helper()
	raw, err := conn.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var on, idle int
	var serr error
	if err := raw.Control(func(fd uintptr) {
		if on, serr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_KEEPALIVE); serr != nil {
			return
		}
		idle, serr = syscall.GetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpKeepIdleOpt)
	}); err != nil {
		t.Fatal(err)
	}
	if serr != nil {
		t.Fatal(serr)
	}
	return on != 0, time.Duration(idle) * time.Second
}
