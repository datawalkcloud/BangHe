-- ============================================================================
-- 0033_auto_print_switches.sql —— 自动出票的两枚站点开关（打印与联次组）
--
-- 此前全仓只有两处"不经人手就出纸"的路，都是写死的：
--   1. 工作台第二刷皮重定净重后自动出码单（自动挂账成功 / 挂账失败回退 / 需人工结算
--      三条出口共用 triggerPrint）；
--   2. 登记付款成功后自动出结算凭证（PayForm.printVoucher，分次付款每笔一张）。
-- 有的站点码单走预印纸、凭证月底统一打，不需要每单当场出纸，却没有参数能关。
--
-- 两枚都默认 true＝升级后行为与升级前逐字一致；置 false 只关"自动"那一路，
-- F9 / 顶部按钮 / 结算弹窗「凭票打印」/ 各详情页的补打按钮不受影响。
--
-- 只加参数键，不动表结构（与 0010/0012/0014/0016/0018/0023 同规）。
-- 只 INSERT OR IGNORE，站长已手动改过的值升级不覆盖。键集要与 03 §9.3.1 逐字相等，
-- 否则 schema_contract::seed_baseline_matches_design_doc 会红；
-- 目录里这两行若缺，masters_contract::every_key_the_frontend_catalog_renders_exists_in_the_library 也会红。
-- ============================================================================

INSERT OR IGNORE INTO app_setting (key, value_json, value_type, description, updated_at) VALUES
  ('auto_print_weigh_order', 'true', 'bool', '过磅完成自动出码单：第二刷皮重定净重后自动打一张码单（挂账成功印结算后确数，需人工结算印「预估」）。false＝不自动出纸，F9、顶部「打印」按钮与结算弹窗「凭票打印」仍可手动出票', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('auto_print_settlement_voucher', 'true', 'bool', '付款后自动打印结算凭证：每登记一笔付款成功自动打一张结算凭证（分次付款每笔一张）。false＝不自动出纸，结算单详情页「打印凭证」仍可手动出票', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');