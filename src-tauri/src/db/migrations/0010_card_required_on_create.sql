-- ============================================================================
-- 0010_card_required_on_create.sql —— 制单必须绑卡（docs/design/06 篇 §4.0）
--
-- 现场口径变更：流转卡不再是"制单之后靠后台监听认领"的便利件，而是**制单的前置闸门**——
-- 点「取号并制单」弹框刷 IC 小白卡，读不到卡就不取号，读到一张还挂着未完成单的卡也拦下。
-- 卡与单在同一次事务里绑定，任何一道闸不过整笔回滚，库里不留"已取号无卡"的半张单。
--
-- 只加一个参数键，不动表结构：`card`（0009）与 `weigh_order.card_no` 快照列照旧。
-- 与 0006/0008/0009 同规：只 INSERT OR IGNORE，站长已手动写过的值升级不覆盖。
-- 键集要与 03 §9.3.1 逐字相等，否则 schema_contract::seed_baseline_matches_design_doc 会红。
-- ============================================================================

INSERT OR IGNORE INTO app_setting (key, value_json, value_type, description, updated_at) VALUES
  ('card_required_on_create', 'true', 'bool', '取号制单是否必须先刷到流转卡：true＝没读到卡不许取号，读到即同事务绑卡；false＝照旧允许无卡制单，卡由后台监听发卡', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');
