-- ============================================================================
-- 0027_qc_labels_to_order.sql —— 样品号与留样号搬回磅单（03 §3.5，0025 的后半截）
--
-- 0025 把两枚号纳进统一取号，号却仍存在 `qc_report` 上，于是唯一性只能建成
-- `WHERE is_effective = 1` 的部分索引——复检降级出来的留档行落在索引外。当时那样也确实安全，
-- 但靠的是一条**库里表达不出来**的不变式：每张有化验单的磅单恰好一行有效行（"至多一行"有
-- `uk_qc_effective` 硬挡，"至少一行"没有任何约束能兜住）。将来只要有人加一条"撤销化验单把
-- 有效行置 0、不插新单"的路径，那一单的号就整块掉出保护面，而且一声不响。
--
-- 号的归属本来就不在化验单：01 篇扦样口径「按车次扦取样品，生成样品编号绑定磅单」，一车粮
-- 一个样、一瓶留样。搬回 `weigh_order` 之后，一单一行由表结构保证，索引不再需要任何 `WHERE`，
-- 那条不变式从"必须成立否则保护失效"降级成"业务上顺便成立"。
--
-- 四步的顺序是有讲究的：
--   ① 加三列；② 从每单**最早的带号化验行**回填（顺手把空串归一成 NULL——0025 已经做过一次，
--      这里是双保险）；③ 才建全表 UNIQUE。SQLite 的唯一索引允许任意多个 NULL 并存，所以
--      "还没化验的单"这三列全空是正常态、不占约束位。这正是 0025 那个空串事故的反面教材：
--      **空号必须是 NULL，绝不能是 ''**，否则两张没留样的单会互相撞。
--   ④ 最后撤 `qc_report` 的两条部分索引并 DROP 三个旧列——SQLite 的 DROP COLUMN 要求列上没有
--      索引，顺序反了直接报错。`qc_report` 被三条外键指着（`weigh_order.qc_report_id`、自关联
--      `first_report_id`、`qc_indicator.report_id`），但 DROP COLUMN 走原地改元数据、不重建表，
--      碰不到 0024 那笔"DROP 时父表缺席、COMMIT 对不上账"的雷。
--
-- ③ 万一真撞上唯一（人工改库、或从外来备份灌进来的重复号），本脚本整体回滚、应用拒启并留下
-- startup_error.log。**刻意不做"发现重复就悄悄重新发号"**：这两枚号已经印在质检单上、贴在
-- 样瓶标签上，改号等于让纸和库对不上，比开不了机更坏——与 `codes.rs` 头注"历史磅单按编码
-- 留痕，重新编号等于把历史接不上"是同一条规矩。回滚后按 `backup/` 里的 pre_migrate 快照排查。
--
-- 迁移语义（见 migrate.rs 硬规矩）：本脚本只会整体执行一次，失败即回滚且不记账，所以 ① 的
-- `ADD COLUMN` 没有 `IF NOT EXISTS` 也不要紧；② 是幂等 UPDATE，③ 带 IF NOT EXISTS。
-- ============================================================================

-- ① 磅单侧三列
ALTER TABLE weigh_order ADD COLUMN sample_no TEXT;
ALTER TABLE weigh_order ADD COLUMN retention_no TEXT;
ALTER TABLE weigh_order ADD COLUMN retention_until TEXT;

-- ② 回填：取该单最早一行带号的化验记录。复检链上多行同值（0025 已按磅单归并过），
--    跨天复检留下的两个号在这里并成一枚——瓶只有一瓶。
UPDATE weigh_order
   SET sample_no = (SELECT CASE WHEN q.sample_no = '' THEN NULL ELSE q.sample_no END
                      FROM qc_report AS q
                     WHERE q.order_id = weigh_order.id AND q.sample_no IS NOT NULL
                     ORDER BY q.id LIMIT 1),
       retention_no = (SELECT CASE WHEN q.retention_no = '' THEN NULL ELSE q.retention_no END
                      FROM qc_report AS q
                     WHERE q.order_id = weigh_order.id AND q.retention_no IS NOT NULL
                     ORDER BY q.id LIMIT 1),
       retention_until = (SELECT q.retention_until
                      FROM qc_report AS q
                     WHERE q.order_id = weigh_order.id AND q.retention_until IS NOT NULL
                     ORDER BY q.id LIMIT 1)
 WHERE EXISTS (SELECT 1 FROM qc_report AS q WHERE q.order_id = weigh_order.id);

-- ③ 全表唯一，无 WHERE：一单一行由 weigh_order 的表结构本身保证
CREATE UNIQUE INDEX IF NOT EXISTS uk_order_sample    ON weigh_order(sample_no);
CREATE UNIQUE INDEX IF NOT EXISTS uk_order_retention ON weigh_order(retention_no);

-- ④ 撤掉化验单侧的旧痕迹（索引必须先于列消失）
DROP INDEX IF EXISTS uk_qc_sample;
DROP INDEX IF EXISTS uk_qc_retention;
ALTER TABLE qc_report DROP COLUMN sample_no;
ALTER TABLE qc_report DROP COLUMN retention_no;
ALTER TABLE qc_report DROP COLUMN retention_until;
