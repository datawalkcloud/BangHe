-- ============================================================================
-- 0030_print_doc_type_outbound.sql —— print_log 认得「出库码单」与「付款小票」
--
-- 02 §M11 F11.7 出库码单打印落地，票面要走 `useSilentReceiptPrint` → `print_log_add`
-- 那条唯一的留痕路（`orders.rs::log_print`）。而 `log_print` 把**场景 id 原样当 doc_type
-- 写库**（前端 `silent.ts` 里 `doc_type: scenario`，中间没有第二份映射），所以新场景要能
-- 留痕，`print_log.doc_type` 的 CHECK 值域必须先扩容——否则出库单打完了、纸出来了，
-- 留痕那一句 INSERT 撞 CHECK，界面上是「已出纸，但打印留痕失败：…约束失败」，
-- 补打角标与「已打 N 张」从此不准（06 §2.2 那条承诺就废了）。
--
-- 顺带补一个**已经漏了三年**的值：`payment_receipt`。付款小票（§9.19 之后新增的第四张票）
-- 早就在前端 `ReceiptScenario` 与 `SCENARIOS` 注册表里（`scenarios.tsx`、`PaymentsPage` 的
-- 打印按钮），出厂默认模板也有它一份，唯独建表那六个值里没有它、`enums.rs::PrintDocType`
-- 里也没有——也就是说**桌面端每打一张付款小票，留痕都在撞 CHECK**。浏览器预览看不出来
-- （mock 的 `logPrint` 不校验值域），所以这条一直活到装机现场。既然这次要为出库单重建这张表，
-- 就把同一格里缺的两个值一起补上，别留半张。
--
-- 为什么必须重建而不是 ALTER：值域是 `CHECK (doc_type IN (...))`，SQLite 不能改列约束，
-- 只能走官方那套「建新表→搬数据→删旧表→改名→重建索引」（同 0024 / 0029）。
--
-- 这次重建同样是**安全的那一类**，不必像 0024 那样关外键：`print_log` 是叶子表——全库没有
-- 一张表外键指向它（`grep REFERENCES print_log` 为空），两个视图 `v_open_order` / `v_payable`
-- 也不碰它；它自己只有 `authorized_by` 一条外键指向 `user_account`（`operator_id` 刻意不带
-- 外键：账号注销后留痕还得写得进，见 0001），搬运期间父表一张不缺。0024 炸在 COMMIT
-- 是因为 DROP 掉的是被引用的父表，这里 DROP 的是子表。migrate.rs 收尾那遍
-- `PRAGMA foreign_key_check` 照旧会验，漏搬一行照样中止启动。
--
-- 两个索引先删后建：`idx_print_doc(doc_type, doc_id)` 是「这张单打过几次」那条查询走的口，
-- 漏建等于每次开详情页全表扫 print_log；`idx_print_date(printed_at)` 服务日报与作业量统计
-- （`ledger.rs` 按 `substr(printed_at,1,10)` 区间数补打次数）。
--
-- 值域四处必须同批改，否则 `schema_contract::enums_are_single_sourced_across_three_places`
-- 会红：这里、`domain/enums.rs::PrintDocType`、`ENUM_SPECS` 那条登记（`ts: None`——前端那份
-- 值域不叫显示字典而是 `ReceiptScenario`，在 `components/print/receipt/types.ts`，
-- `schema_contract` 只解析 `src/lib/constants.ts` 的联合，够不着它，所以第三处由
-- `scripts/receipt-code/check.ts` 的 N 段钉：SCENARIOS 注册表里的场景 id 必须是本列允许的值）、
-- 03 §9.19 的 `doc_type` 行。表结构变了还要手改 blessed 快照里 `table print_log` 那一行
-- （按 04 §5.4 的说明手改，不要 `BANGHE_BLESS_SCHEMA=1` 整份重写）。
-- ============================================================================

-- 1) 新表：除 `doc_type` 的 CHECK 多两个值，其余列与约束与 0001 逐字相同
CREATE TABLE print_log_new (
  id            INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  doc_type      TEXT    NOT NULL CHECK (doc_type IN
                    ('weigh_order','quality_report','settlement_voucher','payment_receipt','outbound_order','internal_flow','ledger','daily_report')),
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
