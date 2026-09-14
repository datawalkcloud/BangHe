-- ============================================================================
-- 0017_order_variety_nullable.sql —— 磅单收购品种改为可空（制单后置到结算/化验）
--
-- 06 §4.0 把制单改成「两刷一条流」：IC 流转卡就位 + 身份证认出售粮人，这一张单就该成立。
-- 现场农户一手拿证一手拿卡，站在窗口前，品种却常常要等卸完货看清粮食才报得出来——
-- 让品种挡在制单闸门口，等于把「零点击」又退回成一次人工填写。所以真把列改成可空，
-- 而不是拿某个默认品种糊过去（糊过去的单会带着一个错的品种进台账与日报，比空着更坏）。
-- 口径：制单可空，**结算与录化验前必填**，两道闸门在 Rust（orders.rs 的 settle / save_qc）。
--
-- 为什么不走重建表：迁移脚本整体跑在一个事务里（migrate.rs `apply_one` 用
-- `tx.execute_batch`），而 `PRAGMA foreign_keys=OFF` 在事务内是空操作——重建表那条路
-- 要同时开 `legacy_alter_table` 和 `defer_foreign_keys`，把 weigh_order 上 9 条外键关系
-- （子表 weigh_record RESTRICT、qc_report、settlement_order…）全拖进文本改写，风险不值当。
-- SQLite ≥3.35 支持 `DROP/ADD COLUMN`，本机实测过：先删掉引用该列的视图与索引，列就能删。
--
-- 三个必须踩到的坑，顺序不能调：
--  1) `v_open_order` 与 `idx_order_variety_date` 都引用了这一列，不先 DROP 会直接报
--     `error in view/index ... no such column: variety_id`；
--  2) **`DROP COLUMN` 连数据一起消失**——不像重建表那样有 SELECT 兜着，所以必须先把存量
--     品种备份进临时表，加回列之后按 id 逐行还原（下面的 `_variety_keep`）；漏了这一步，
--     老站升完级历史单的品种全部变成空，日报与档案页全瞎；
--  3) 新列只能追加到表尾，`weigh_order` 的物理列序因此变了。读路径全按显式列名取
--     （orders.rs `ORDER_SELECT` / `map_order_row`），`v_open_order` 用 `o.*` 重建后
--     跟着新列序走，`dashboard.rs` 那支查询按列名取值，不受影响。
--
-- 还原后再验一遍外键仍然生效：新列全 NULL 时 `ADD COLUMN ... REFERENCES` 不触发检查，
-- 但此后写入的坏品种号照样要被拒（`PRAGMA foreign_key_check` 归零是迁移后的例行体检，
-- 见 migrate.rs `MigrateError::ForeignKey`）。
-- ============================================================================

-- 1) 拆掉引用该列的视图与索引（都必须在 DROP COLUMN 之前）
DROP VIEW IF EXISTS v_open_order;
DROP INDEX IF EXISTS idx_order_variety_date;

-- 2) 备份存量品种：DROP COLUMN 会把它连数据一起删掉
CREATE TEMP TABLE _variety_keep AS SELECT id, variety_id FROM weigh_order;

-- 3) 删列、按可空重加（列序落到表尾）
ALTER TABLE weigh_order DROP COLUMN variety_id;
ALTER TABLE weigh_order ADD COLUMN variety_id INTEGER REFERENCES grain_variety(id);

-- 4) 存量品种逐行还原
UPDATE weigh_order
   SET variety_id = (SELECT k.variety_id FROM _variety_keep k WHERE k.id = weigh_order.id);
DROP TABLE _variety_keep;

-- 5) 索引原样建回（日报按品种+日期分组走它）
CREATE INDEX IF NOT EXISTS idx_order_variety_date ON weigh_order(variety_id, business_date);

-- 6) 视图重建：抄 0005 的时区修法一字不动，只把 `JOIN grain_variety` 换成 LEFT JOIN。
--    不换的话没品种的在途单会从「在途作业看板」上凭空消失（dashboard.rs 读的就是这支视图）——
--    车就在磅上，看板却说没车，这是最坏的一种丢单。
CREATE VIEW v_open_order AS
SELECT o.*, p.name AS party_name, v.name AS variety_name,
       CAST((julianday('now') - julianday(COALESCE(o.tare_at, o.gross_at, o.registered_at))) * 24 * 60 AS INTEGER) AS stuck_minutes
FROM weigh_order o
JOIN party p ON p.id = o.party_id
LEFT JOIN grain_variety v ON v.id = o.variety_id
WHERE o.status NOT IN ('archived','voided','reversed','rejected');
