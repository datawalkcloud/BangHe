-- ============================================================================
-- 0005_fix_view_timezone.sql —— 修正 §9.24 两支视图的时长口径（时区虚增 bug）
--
-- 0001 里 v_open_order.stuck_minutes / v_payable.unpaid_hours 写的是
--   julianday('now','localtime') - julianday(带 +08:00 偏移的落库文本)
-- 左侧把本地挂钟**当 UTC** 取儒略日，右侧按偏移正确归一到时点——两个基准
-- 差着一个时区：东八区上任何时长都恒定多算 8 小时（刚进磅的车显示"停留
-- 8 小时"，落单一瞬间的挂账显示"未付 8 小时"）。本机时区验证：同一毫秒
-- 相减，'now','localtime' 式给 480 分钟，'now' 式给 0。
--
-- 修法：两侧统一到 `julianday('now')`（真时点）。落库文本自带 +08:00 偏移
-- （0002 头注、§3.2），julianday() 会按偏移归一，因此与 'now' 同基准，
-- 与执行机时区无关。其余列、别名、WHERE 与 0001 逐字相同。
--
-- 0001 本体不能改（checksum 比对会让已装机器的启动被拒，见 migrate.rs 与
-- tests/schema_contract.rs::tampered_applied_script_refuses_startup），
-- 所以按 0003 / 0004 的惯例上新脚本。DROP + CREATE 天然幂等，重跑零影响。
-- ============================================================================

DROP VIEW IF EXISTS v_open_order;
CREATE VIEW v_open_order AS
SELECT o.*, p.name AS party_name, v.name AS variety_name,
       CAST((julianday('now') - julianday(COALESCE(o.tare_at, o.gross_at, o.registered_at))) * 24 * 60 AS INTEGER) AS stuck_minutes
FROM weigh_order o
JOIN party p ON p.id = o.party_id
JOIN grain_variety v ON v.id = o.variety_id
WHERE o.status NOT IN ('archived','voided','reversed','rejected');

DROP VIEW IF EXISTS v_payable;
CREATE VIEW v_payable AS
SELECT s.id, s.settle_no, s.party_id, p.name, s.payable_fen, s.paid_fen,
       s.payable_fen - s.paid_fen AS unpaid_fen, s.settled_at,
       CAST((julianday('now') - julianday(s.settled_at)) * 24 AS INTEGER) AS unpaid_hours
FROM settlement s JOIN party p ON p.id = s.party_id
WHERE s.status = 'normal' AND s.payment_status <> 'paid';
