-- ============================================================================
-- 0024_device_scanner_kind.sql —— 设备类别加 `scanner`：扫码枪走串口通道（04 §5.4）
--
-- 为什么要这一类：HID 键盘通道的扫码枪在磅房有三类躲不掉的丢字——中文输入法把 `BH1:` 改写成
-- `BH：`/`！＠）`（实测，见 04 §5.4 与 `src-tauri/src/ime.rs` 头注）、光标停在输入框里时
-- 捕获主动让位、焦点不在本窗口时按键整个丢掉。串口（USB-CDC 虚拟 COM）模式一次绕开这三条：
-- 字节直接进程序，不经过输入法、不经过焦点。代价是"这台枪接在哪个 COM 口、什么波特率、
-- 一行怎么收尾"变成要配的东西——那就是设备台账的本职，所以新增一类，而不是再往
-- `app_setting` 里塞三个键（同类信息分两处存，迟早对不上）。
--
-- 为什么必须重建表：`kind` 的值域是 `CHECK (kind IN (...))`，SQLite 不能 ALTER 约束。
-- 走的是官方那套"建新表→搬数据→删旧表→改名→重建索引"。
--
-- 三个必须踩到的点，顺序不能调：
--  1) **`PRAGMA defer_foreign_keys=ON` 而不是 `foreign_keys=OFF`**：迁移整体跑在一个事务里
--     （migrate.rs `apply_one` 用 `tx.execute_batch`），而 `foreign_keys` 在事务内是空操作
--     ——0017 头注里就是这条坑。`defer_foreign_keys` 是"本次事务内把外键检查推迟到 COMMIT"，
--     事务里可用。推迟之后 `DROP TABLE device_config` 不会被两张子表的外键
--     （`weigh_record.device_id`、`attachment.source_device_id`）当场拦住，而改名之后
--     这些 id 一个不少地还在，COMMIT 时的检查自然过。迁移末尾 migrate.rs 还会跑一遍
--     `PRAGMA foreign_key_check`（`MigrateError::ForeignKey`），漏搬一行都会在这里红。
--  2) **两个索引先删后建**：`idx_dev_kind(kind, is_enabled)` 与半截唯一索引
--     `uk_dev_default(kind) WHERE is_default = 1`。后者那条 `WHERE` 子句是"同类只有一台默认"
--     的唯一实现（`devices.rs` 里设默认靠它兜底），重建时漏掉 WHERE 就等于允许两台默认，
--     出纸口解析（`print_silent` 那条路）会随机挑一台。
--  3) **没有视图引用本表**（`v_open_order` / `v_payable` 都不碰 `device_config`），所以不必
--     先 DROP VIEW；`sqlite_sequence` 由 `ALTER TABLE ... RENAME` 自动跟着改名，AUTOINCREMENT
--     的号不会从 1 重发。
--
-- 值域四处必须同批改，否则 `schema_contract::enums_are_single_sourced_across_three_places`
-- 会红：Rust `domain/enums.rs` 的 `DeviceKind`、`src/lib/constants.ts` 的 `DeviceKind` 联合、
-- 03 §9.20 的 `kind` 行，以及这里。表结构变了还要复量 blessed 快照
-- （`tests/schema_snapshot.sql` 里 `table device_config` 那一行，按 04 §5.4 的说明手改，
-- 不要用 `BANGHE_BLESS_SCHEMA=1` 整份重写——那会把别人在途的结构一起洗白）。
-- ============================================================================

PRAGMA defer_foreign_keys=ON;

-- 1) 新表：除 `kind` 的 CHECK 多一个 `scanner`，其余列与约束与 0001 逐字相同
CREATE TABLE device_config_new (
  id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,                  -- scale1/idcard1/cam1/prn_main/scanner1
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN
                    ('scale','idcard','camera','printer','scanner','led','cashbox','signpad')),
  driver      TEXT    NOT NULL,                         -- yaohua_xk3190/toledo/bridge_exe/hidapi/hikvision_isapi/dahua_cgi/preview/raw_escp/raw_escpos/mock
  config_json TEXT    NOT NULL DEFAULT '{}',            -- 端口/波特率/地址/账号/URL 模板/纸型边距
  secret_json TEXT,                                     -- 摄像头口令等，加密存
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  is_mock     INTEGER NOT NULL DEFAULT 0,
  is_default  INTEGER NOT NULL DEFAULT 0,               -- 同类默认设备
  last_status TEXT    NOT NULL DEFAULT 'unknown' CHECK (last_status IN ('unknown','online','offline','error')),
  last_ok_at  TEXT,
  last_err_at TEXT,
  last_error  TEXT,
  err_count   INTEGER NOT NULL DEFAULT 0,               -- 连续错误计数
  created_at  TEXT,
  updated_at  TEXT
);

-- 2) 整表搬运：显式列名，不写 `SELECT *`——列序将来变了这里不会静默错位
INSERT INTO device_config_new (id, code, name, kind, driver, config_json, secret_json, is_enabled, is_mock,
       is_default, last_status, last_ok_at, last_err_at, last_error, err_count, created_at, updated_at)
SELECT id, code, name, kind, driver, config_json, secret_json, is_enabled, is_mock,
       is_default, last_status, last_ok_at, last_err_at, last_error, err_count, created_at, updated_at
FROM device_config;

-- 3) 旧表连同两个索引一起退场（索引必须在 DROP 之前显式删掉，改名后重建的是同名新对象）
DROP INDEX IF EXISTS idx_dev_kind;
DROP INDEX IF EXISTS uk_dev_default;
DROP TABLE device_config;

-- 4) 改名接管
ALTER TABLE device_config_new RENAME TO device_config;

-- 5) 两个索引原样建回（半截唯一索引的 WHERE 子句一字不能少，见头注第 2 点）
CREATE INDEX IF NOT EXISTS idx_dev_kind ON device_config(kind, is_enabled);
CREATE UNIQUE INDEX IF NOT EXISTS uk_dev_default ON device_config(kind) WHERE is_default = 1;
