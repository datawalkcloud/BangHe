-- ============================================================================
-- 0036_outbound_voucher.sql —— print_log 认得「发货凭证」
--
-- 出库单多了一张随车交接的表单「发货凭证」（场景 id `outbound_voucher`，02 §F11.7 之后
-- 新增的第五种带出库的票）。它走与出库码单同一条打印留痕路（`orders.rs::log_print`），
-- 而 `log_print` 把**场景 id 原样当 doc_type 写库**（前端 `silent.ts` 里 `doc_type: scenario`），
-- 所以同 0030 一样：值域必须先扩容，否则纸出来了、留痕 INSERT 撞 CHECK，
-- 「已打 N 张 / 补打角标」从此不准。
--
-- 为什么必须重建而不是 ALTER：值域是 `CHECK (doc_type IN (...))`，SQLite 不能改列约束，
-- 只能走官方那套「建新表→搬数据→删旧表→改名→重建索引」（同 0024 / 0029 / 0030）。
--
-- 这次重建是安全的那一类：`print_log` 是叶子表——全库没有一张表外键指向它，它自己只有
-- `authorized_by` 一条外键指向 `user_account`。migrate.rs 收尾那遍
-- `PRAGMA foreign_key_check` 照旧会验，漏搬一行照样中止启动。
--
-- 两个索引先删后建：`idx_print_doc(doc_type, doc_id)` 是「这张单打过几次」那条查询走的口，
-- 漏建等于每次开详情页全表扫 print_log；`idx_print_date(printed_at)` 服务日报与作业量统计。
--
-- 值域四处必须同批改：这里、`domain/enums.rs::PrintDocType`、`tests/schema_snapshot.sql`
-- 里 `table print_log` 那一行（按 04 §5.4 手改，不要整份重写）、前端 `ReceiptScenario` 与
-- `mock/types.ts` 的 `PrintLog["doc_type"]` 联合（由 `scripts/receipt-code/check.ts` 的 N 段钉：
-- SCENARIOS 注册表里的场景 id 必须是本列允许的值）。
-- ============================================================================

-- 1) 新表：除 `doc_type` 的 CHECK 多一个值，其余列与约束与 0030 逐字相同
CREATE TABLE print_log_new (
  id            INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  doc_type      TEXT    NOT NULL CHECK (doc_type IN
                    ('weigh_order','quality_report','settlement_voucher','payment_receipt','outbound_order','outbound_voucher','internal_flow','ledger','daily_report')),
  doc_id        INTEGER NOT NULL,
  doc_no        TEXT    NOT NULL,                        -- 快照，便于单据删除前审计（实际不删）
  copies        INTEGER NOT NULL DEFAULT 1,
  paper         TEXT    NOT NULL,                        -- A4/dot241/thermal58/thermal80（无 CHECK，待 §3.6 拍板）
  printer_name  TEXT    NOT NULL,
  channel       TEXT    NOT NULL CHECK (channel IN ('preview','pdf_silent','raw')),
  is_reprint    INTEGER NOT NULL DEFAULT 0,
  authorized_by INTEGER REFERENCES user_account(id),     -- 补打授权人
  result        TEXT    NOT NULL CHECK (result IN ('success','failed')),
  error_msg     TEXT,
  rendered_json TEXT,                                    -- 本次打印的数据快照，复现"当初打了什么"
  printed_at    TEXT    NOT NULL,
  operator_id   INTEGER NOT NULL
);

-- 2) 整表搬运：显式列名 + 显式 id（print_log 是审计流水，换号等于把历史对不回经办人）
INSERT INTO print_log_new (id, doc_type, doc_id, doc_no, copies, paper, printer_name, channel,
       is_reprint, authorized_by, result, error_msg, rendered_json, printed_at, operator_id)
SELECT id, doc_type, doc_id, doc_no, copies, paper, printer_name, channel,
       is_reprint, authorized_by, result, error_msg, rendered_json, printed_at, operator_id
FROM print_log;

-- 3) 旧表连同两个索引一起退场（索引必须在 DROP 之前显式删掉，改名后重建的是同名新对象）
DROP INDEX IF EXISTS idx_print_doc;
DROP INDEX IF EXISTS idx_print_date;
DROP TABLE print_log;

-- 4) 改名接管。`sqlite_sequence` 由 RENAME 自动跟着走，AUTOINCREMENT 的号不从 1 重发。
ALTER TABLE print_log_new RENAME TO print_log;

-- 5) 两个索引原样建回
CREATE INDEX IF NOT EXISTS idx_print_doc  ON print_log(doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_print_date ON print_log(printed_at);
