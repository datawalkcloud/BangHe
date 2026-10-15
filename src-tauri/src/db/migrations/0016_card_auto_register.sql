-- ============================================================================
-- 0016_card_auto_register.sql —— 允许使用未登记的流转卡（docs/design/06 篇 §4.1 闸门 3）
--
-- 0913 起，工作台上刷到不在册的卡不再把磅员赶去「流转卡」页点一次登记：读到陌生卡号
-- 当场走 `card_pool_register` 入池留痕（`remark` 写「工作台刷卡自动登记」+ `audit card.register`），
-- 随即与一张普通空闲卡同路——有等卡的在途单就发卡绑上，没有就交给「身份与制单」就地制单。
--
-- 但"见卡就发"是有代价的：任何一张 13.56MHz Mifare 卡（公交卡、员工自己的卡、别的站的卡）
-- 都会被收进本站卡池并可能绑上一张真磅单。要不要接受这个代价归站长定，所以做成开关：
--   true （默认）＝未登记卡刷到即自动登记入库并继续使用；
--   false        ＝回到硬闸门，未登记的卡拦下并提示先到「流转卡」页登记（已注销的卡两种口径下都拦）。
--
-- 只加一个参数键，不动表结构（与 0010/0012/0014 同规）。只 INSERT OR IGNORE，
-- 站长已手动改过的值升级不覆盖。键集要与 03 §9.3.1 逐字相等，
-- 否则 schema_contract::seed_baseline_matches_design_doc 会红；
-- 目录里这一行若缺，masters_contract::every_key_the_frontend_catalog_renders_exists_in_the_library 也会红。
-- ============================================================================

INSERT OR IGNORE INTO app_setting (key, value_json, value_type, description, updated_at) VALUES
  ('card_auto_register', 'true', 'bool', '允许使用未登记的流转卡：true＝工作台上刷到没登记过的卡当场自动登记入库并继续用它制单/发卡（来源记在卡池备注里，事后可注销）；false＝未登记的卡一律拦下，必须先到「流转卡」页登记后才能用。已注销的卡两种口径下都不复活', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');
