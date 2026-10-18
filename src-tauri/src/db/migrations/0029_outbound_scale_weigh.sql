-- ============================================================================
-- 0029_outbound_scale_weigh.sql —— 出库支持过地磅（02 §M11、03 §9.12/§9.28）
--
-- 0020 建 `outbound_order` 时就把波 2 的口子留好了：`weight_source` 建表即带、值域里有
-- `scale` 却没有一条路径写得进去，头注定的是「接秤时新增毛/皮重列与称重记录（复用
-- weigh_record 的 doc_kind）」。这里就是那一刀，两件事：
--
--  1) **`outbound_order` 加毛/皮两列**。出库净重不再只有"人敲的一个数"：重车上一磅（毛）、
--     空车下一磅（皮），净重 = 毛 − 皮 由服务端算，`weight_source` 由捕获路径落 `scale`。
--     两列可空——登记出库常常一磅都不过（领用半袋种子的三轮车），只有手填净重那一条老路。
--  2) **`weigh_record` 加 `doc_kind`，成为两条单据链共用的称重轨迹表**。出库侧要的正是
--     磅单侧已有的那几样东西：哪台磅、原始帧、判没判稳、谁在什么时候按的、复称过几次、
--     当前采用的是哪一次。再造一张同构的表，就是把"这个数怎么来的"分两处存——
--     迎检查轨迹时要跑两个地方，迟早对不上。
--
-- 为什么 `order_id` 的外键必须去掉：加了 `doc_kind` 之后这一列装的是**两张表**的 id，
-- 而 `weigh_order.id` 与 `outbound_order.id` 各自独立递增、数字互相重叠。留着
-- `REFERENCES weigh_order(id)`，出库那条轨迹要么写不进去（那个数字在磅单里不存在），
-- 要么更糟——碰巧存在，就被外键认定挂到了一张毫不相干的磅单上。外键换不成的是**引用完整性**，
-- 那就由服务层判（`outbound::capture` 先按单号读回出库单才写轨迹），
-- 跨态与终态由 `status` 闸门守住，与 0020 那句「不硬套磅单 13 态」同一立场。
--
-- 这次重建是**安全的那一类**，不必像 0024 那样关外键：`weigh_record` 只有指向别人的外键，
-- 全库没有任何一张表外键指向它（`attachment.biz_id` 是松引用，不是 FK），`v_open_order` /
-- `v_payable` 两个视图也不碰它。0024 炸在 COMMIT 是因为 DROP 掉的是**被引用的父表**，
-- `defer_foreign_keys` 记的是那一刻的账；这里 DROP 的是子表，父表一张都没缺席，
-- 所以照 SQLite 官方"建新表→搬数据→删旧表→改名→重建索引"走完即可，
-- migrate.rs 收尾那遍 `PRAGMA foreign_key_check` 依旧会验（漏搬一行照样中止启动）。
--
-- 三个必须踩到的点：
--  1) **两个索引的列序都要带上 `doc_kind`**。`uk_record(order_id, seq)` 不改就是错的：
--     磅单 5 号和出库单 5 号会撞同一个唯一键，第二张单的第一捕直接 `UNIQUE constraint failed`，
--     或者更坏——复称时 `UPDATE ... WHERE order_id = ?` 把别人家的轨迹行改成"未采用"。
--     `idx_adopted` 同理，它服务的是"这一单这一类当前采用哪一次"。
--  2) **id 显式搬**：`attachment.biz_id` 存的就是 `weigh_record.id`（过磅抓拍图挂在这行上），
--     重新发号会让历史抓拍全部对不回称重记录。`INSERT ... SELECT id, ...` 一字不能省。
--  3) **列序变了**：`doc_kind` 落在第 2 列、`order_id` 跟着后移。读路径全按显式列名取
--     （`orders.rs::RECORD_COLS`、`outbound.rs` 自己那份），没有 `SELECT *` 的位置依赖。
--
-- 值域四处必须同批改，否则 `schema_contract::enums_are_single_sourced_across_three_places`
-- 会红：Rust `domain/enums.rs` 的 `WeighDocKind` + `ENUM_SPECS` 登记、03 §9.12 的表结构、
-- 以及这里。`doc_kind` 不进前端常量（界面按单据链各查各的轨迹，不拿这个值当筛选条件），
-- 登记口径与 `WeighType` 一样 `ts: None`。结构变了还要手改 blessed 快照里
-- `table weigh_record` / `table outbound_order` 两行（按 04 §5.4 的说明手改，
-- 不要 `BANGHE_BLESS_SCHEMA=1` 整份重写——那会把别人在途的结构一起洗白）。
-- ============================================================================

-- 1) 出库单：毛/皮两个采用值，与 §9.11 磅单同名字同单位（0.1kg 定点整数）
ALTER TABLE outbound_order ADD COLUMN gross_weight_01kg INTEGER;
ALTER TABLE outbound_order ADD COLUMN tare_weight_01kg INTEGER;

-- 2) 称重轨迹表接上出库侧
CREATE TABLE weigh_record_new (
  id                  INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  -- 哪张单据的哪一次称重。值域见 `enums.rs::WeighDocKind`：
  --   `weigh_order`    → `order_id` 指 §9.11 磅单（历史行全部落这一档）
  --   `outbound_order` → `order_id` 指 §9.28 出库单
  -- 刻意不带外键，理由见头注；查询必须同时带 `doc_kind`，否则跨单据链串号。
  doc_kind            TEXT    NOT NULL DEFAULT 'weigh_order'
                                    CHECK (doc_kind IN ('weigh_order','outbound_order')),
  order_id            INTEGER NOT NULL,
  seq                 INTEGER NOT NULL,                     -- 单内递增
  weigh_type          TEXT    NOT NULL CHECK (weigh_type IN ('gross','tare')),
  weight_01kg         INTEGER NOT NULL,                     -- 本次捕获原始值
  aligned_weight_01kg INTEGER NOT NULL,                     -- 按分度值取整后的值
  is_adopted          INTEGER NOT NULL DEFAULT 0,
  adopt_reason        TEXT,                                 -- 复称替换原因
  source              TEXT    NOT NULL CHECK (source IN ('scale','manual')),
  device_id           INTEGER REFERENCES device_config(id), -- 哪台磅
  raw_frame           TEXT,                                 -- 仪表原始帧（脱敏后存），排障关键
  stable              INTEGER NOT NULL DEFAULT 1,
  captured_at         TEXT    NOT NULL,
  operator_id         INTEGER NOT NULL REFERENCES user_account(id),
  -- 上磅抓拍。出库侧本期不接摄像头（02 §M11「本批刻意不做」沿用），恒 NULL；
  -- 列留着是因为这是同一张轨迹表，不是为了摆样子——哪天出库也要抓拍，加的是捕获路径不是表。
  photo_attachment_id INTEGER REFERENCES attachment(id)
);

-- 3) 整表搬运：显式列名 + 显式 id（attachment.biz_id 指着这些 id，见头注第 2 点）
INSERT INTO weigh_record_new (id, doc_kind, order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg,
       is_adopted, adopt_reason, source, device_id, raw_frame, stable, captured_at, operator_id, photo_attachment_id)
SELECT id, 'weigh_order', order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg,
       is_adopted, adopt_reason, source, device_id, raw_frame, stable, captured_at, operator_id, photo_attachment_id
FROM weigh_record;

-- 4) 旧表连同两个索引一起退场（索引必须在 DROP 之前显式删掉，改名后重建的是同名新对象）
DROP INDEX IF EXISTS uk_record;
DROP INDEX IF EXISTS idx_adopted;
DROP TABLE weigh_record;

-- 5) 改名接管。`sqlite_sequence` 由 RENAME 自动跟着走，AUTOINCREMENT 的号不从 1 重发。
ALTER TABLE weigh_record_new RENAME TO weigh_record;

-- 6) 两个索引按新口径建回：单据类型进列序最前（见头注第 1 点）
CREATE UNIQUE INDEX IF NOT EXISTS uk_record    ON weigh_record(doc_kind, order_id, seq);
CREATE INDEX        IF NOT EXISTS idx_adopted  ON weigh_record(doc_kind, order_id, weigh_type, is_adopted);
