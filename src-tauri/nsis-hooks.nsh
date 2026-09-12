; NSIS 安装程序钩子（tauri.conf.json > bundle > windows > nsis > installerHooks 引用本文件）。
;
; 只干一件事：安装收尾时往应用数据目录落一个「刚安装过」的记号文件 install.stamp。
; 内容无所谓，程序只读它的**修改时间**（epoch 精确到 100ns，两次安装必不同）：
; 启动时与 app_meta.install_stamp_seen 记账比对，不一致就说明这是"覆盖安装后的
; 首次启动"——先对新库做一份 pre_upgrade_ 快照，才继续开库跑迁移（见
; src-tauri/src/db/migrate.rs 与 src-tauri/src/db/mod.rs 的 install_stamp）。
;
; 为什么不在安装器里直接拷 banghe.db：SQLite 开着 WAL，文件级拷贝会截到
; 已提交未合并的页，得到一本"看起来在、恢复即坏"的假退路；VACUUM INTO 才自带一致性。
;
; 路径契约两处双源，改一必须改另一：
;   1. $APPDATA\cn.datawalk.bh == tauri.conf.json 的 identifier（Tauri v2 Windows
;      app_data_dir 就是 RoamingAppData\{identifier}）；
;   2. install.stamp == src-tauri/src/db/mod.rs 的 INSTALL_STAMP_FILE。
;
; 钩子宏会被模板在 currentUser / perMachine 两个安装段各插一次，所以段内**不得**
; 出现具名跳转标签（会撞 "duplicate label"），错误处理一律用 IfErrors 相对偏移。

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$APPDATA\cn.datawalk.bh"
  ClearErrors
  FileOpen $R9 "$APPDATA\cn.datawalk.bh\install.stamp" w
  IfErrors +3
  FileWrite $R9 "banghe"
  FileClose $R9
  ClearErrors
!macroend
