package litedbmodel_runtime

import "syscall"

// tcpKeepIdleOpt is darwin's idle-before-first-probe socket option.
const tcpKeepIdleOpt = syscall.TCP_KEEPALIVE
