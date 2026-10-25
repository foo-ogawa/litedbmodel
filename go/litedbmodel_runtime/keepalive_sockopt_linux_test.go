package litedbmodel_runtime

import "syscall"

// tcpKeepIdleOpt is linux's idle-before-first-probe socket option.
const tcpKeepIdleOpt = syscall.TCP_KEEPIDLE
