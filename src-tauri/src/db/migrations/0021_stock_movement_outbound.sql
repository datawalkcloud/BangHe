-- ============================================================================
-- 0021_stock_movement_outbound.sql —— 库存账两条腿落地（docs/design/03 §9.23、§4.3 不变式 9）
--
-- `stock_movement` 自 0001 建表起就是「只建表不写入」的预留（01 §6 首版非目标）。
-- 出库一开，结存必须真算：**结存 = Σ入 − Σ出**，按 仓房 × 品种 聚合。
-- 只补出腿不补入腿，结存会永远对不上（第一天就负数），所以本脚本一次性把
-- 历史入仓磅单回填成 `in` 流水，并从此由 `stock::sync_in_movement` 保持同步。
--
-- 两条腿的权威源不对称，这是本表最重要的口径，写下来免得实现时两边摇摆：
--   · `in`  的权威源是 **磅单**，本表的 in 行只是投影 → 改派仓房 = UPDATE 那一行，
--     清空去向 = 删掉那一行（可重放、无信息损失，真相永远在 weigh_order 上）；
--   · `out` 的权威源是 **出库单 + 本表流水**，出库单只是入口 → 一律 append-only，
--     红冲补一条对称 `in` 行并用 `reversal_of_id` 指回被冲的那条，原行永不删改。
--
-- 「什么算已入仓」的判据（本脚本与 sync_in_movement 必须逐字同口径）：
--   去向已定 AND 结算重量已写入 AND status ∈ (settled,paid,archived) AND 不是红冲单。
--   （`settlement_weight_01kg` 全仓只有 orders::settle 那一刻才写，to_settle 阶段它还是 NULL，
--   所以旧稿里「COALESCE 回落净重 + 收 to_settle」两处都是空的，已一并收紧成上面这一句。）
-- 刻意以**结算重量**为准而非「磅一过就算入库」：扣水扣杂之前的数量是要付给农户的
-- 钱所对应的量，未结算的单数量未定，算进结存会把「还能出多少」虚报。
-- 已称未结的部分不丢：结存查询另出一列 `pending_in_01kg` 供值仓看住「仓里已卸但还没入账」。
--
-- `move_no` 对派生流水留空：人类可读的单据号在 weigh_order.order_no /
-- outbound_order.order_no 上，本表靠 order_id / outbound_id 反查即可，
-- 再造一个号段只会多一处对不上号的编号。
--
-- 幂等：迁移执行器本身按 checksum 只跑一次，回填仍带 NOT EXISTS 兜一层，
-- 为的是「同一条磅单被塞进两条 in 流水」这种账不可能悄悄发生。
-- ============================================================================

ALTER TABLE stock_movement ADD COLUMN outbound_id INTEGER REFERENCES outbound_order(id);
-- 红冲产生的对称入库行指回被它冲掉的那条出库行；普通派生 in 行为 NULL。
ALTER TABLE stock_movement ADD COLUMN reversal_of_id INTEGER REFERENCES stock_movement(id);

CREATE INDEX IF NOT EXISTS idx_move_outbound ON stock_movement(outbound_id) WHERE outbound_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_move_from_wh  ON stock_movement(from_warehouse_id, business_date);
-- 投影唯一性：一条磅单最多一条（非冲销的）入库行 —— sync_in_movement 靠它做 UPSERT。
CREATE UNIQUE INDEX IF NOT EXISTS uk_move_in_order ON stock_movement(order_id) WHERE kind = 'in' AND order_id IS NOT NULL AND reversal_of_id IS NULL;
-- 一张出库单只留一条出库流水（红冲的对称行是 kind='in'，不受此约束挡）。
CREATE UNIQUE INDEX IF NOT EXISTS uk_move_out_order ON stock_movement(outbound_id) WHERE kind = 'out' AND outbound_id IS NOT NULL;

INSERT INTO stock_movement (
  kind, order_id, party_id, variety_id, grade,
  to_warehouse_id, to_slot_id,
  weight_01kg, price_fen_per_ton, amount_fen,
  business_date, operated_at, operator_id, remark
)
SELECT
  'in', o.id, o.party_id, o.variety_id, o.grade,
  o.warehouse_id, o.slot_id,
  o.settlement_weight_01kg,
  o.price_fen_per_ton, o.goods_amount_fen,
  o.business_date,
  COALESCE(o.settled_at, o.updated_at, o.created_at),
  COALESCE(o.keeper_id, o.created_by),
  '历史入仓磅单回填（0021）'
FROM weigh_order o
WHERE o.warehouse_id IS NOT NULL
  AND o.settlement_weight_01kg IS NOT NULL
  AND o.status IN ('settled','paid','archived')
  AND o.reversed_order_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM stock_movement m
    WHERE m.kind = 'in' AND m.order_id = o.id AND m.reversal_of_id IS NULL
  );
