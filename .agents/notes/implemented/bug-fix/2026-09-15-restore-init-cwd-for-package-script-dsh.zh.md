# Agent Note: Restore `INIT_CWD` for package-script `dsh` launches

Status: implemented

[English](2026-09-15-restore-init-cwd-for-package-script-dsh.md) | 中文

## Problem

产品 CLI 把调用目录当作 workspace 根目录，但 npm 与 pnpm 运行包脚本时会把 `process.cwd()` 设为拥有该脚本的包。从另一个项目执行 `pnpm --dir <checkout> dsh tui` 因此会把 checkout 记为 `session.header.cwd`，加载该 checkout 的 `.env` 与 `AGENTS.md`，并把工具沙箱到那里。直接 `node …/bin.js` 启动，以及在继承包管理器变量的同时带显式 `cwd` spawn 的子进程，并不是同一种改写。

## Decision

在参数解析与 `loadLayeredEnv` 之前，当 `INIT_CWD` 是存在的目录且 `npm_package_json` 指向当前 cwd 所在包时，`dsh` bin 会恢复 `INIT_CWD`。这就是 npm/pnpm 的脚本改写。缺失 `INIT_CWD`、缺失 `npm_package_json`、spawn cwd 不是该包目录，或陈旧的 `INIT_CWD` 路径，都保持 cwd 不变。已安装的 PATH 二进制不变：它没有脚本改写，保留 spawn cwd。

## Alternatives considered

**只要设置了 `INIT_CWD` 就总是 `chdir` 过去。** 不采用，因为测试与嵌入式 spawn 会复制父环境并传入自己的 `cwd`；那些子进程会跳到父进程的调用目录。

**从 `INIT_CWD` 向上走到 `.git` 根。** 不采用，因为现有 workspace 根就是调用目录；指令发现已经会走到项目标记。把 session cwd 改成 git 根会改写已安装二进制从子目录启动的目标。

**文档要求先 `cd` 再 `pnpm dsh`，并把 cwd 留在 checkout。** 不采用，因为 CLI 已经承诺调用目录，且 `pnpm --dir` 是用源码 checkout 对着另一个项目运行的受支持方式。

## Consequences

- 从项目 P 执行 `pnpm --dir <checkout> dsh tui` 会把 P 用作 session cwd、`.env` 层与沙箱根。
- 在 checkout 自身执行 `pnpm dsh tui` 不变：`INIT_CWD` 等于该包目录。
- [配置源所有权](../architecture/2026-08-04-configuration-source-ownership.zh.md) 仍拥有哪些 `.env` 名被拒绝；本记录只拥有包脚本改写之后哪一个目录是调用目录。

## Related decisions

调用目录环境层仍由 [配置源所有权](../architecture/2026-08-04-configuration-source-ownership.zh.md) 持有。
