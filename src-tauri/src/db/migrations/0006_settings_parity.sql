-- ============================================================================
-- 0006_settings_parity.sql —— 补齐「站点参数」页在用、但 §9.3.1 未收录的 8 个键
--
-- 这轮把基础档案最后一块（站点参数）从 mock 换成真库。对键时分成两类：
--
--  1. **同一个参数两个名字**（皮重容差 / 付款时效 / 打印联数 / 允许挂账 / 抓拍留存）
--     —— 一律采用 §9.3.1 与 0002_seed 的权威键名，**旧名不入库**。
--     `tests/schema_contract.rs::seed_baseline_matches_design_doc` 要求文档键集
--     与库内键集逐字相等，所以这里加进来的 8 个键同时补写进 03 文档 §9.3.1。
--
--  2. **纯前端参数**（判稳、在途提醒、合并结算、打印通道、补打授权、留样、
--     界面掩码）—— 文档首版没提，但界面上站长一直在调，砍掉是功能倒退。
--     按 `masters.rs` 的读法补成 app_setting 行，值取前端现值。
--     先例是 `dashboard.rs`：它早就按同名键读 `open_order_alert_minutes`、
--     读不到退默认 30，只是 0002 一直没写这一行。
--
-- 只 INSERT OR IGNORE，绝不 UPDATE：参数值属现场调过的配置，重跑必须零影响，
-- 已装好的机器上站长自己改过的值也不能被升级覆盖掉。
--
-- 单位口径沿用它已有的写法：`_01kg` = 0.1kg 定点、`_pct` = 0.01% 定点、
-- `stable_window_ms` 用毫秒、`*_days` 用自然日、`*_minutes` 用分钟。
-- ============================================================================

INSERT OR IGNORE INTO app_setting (key, value_json, value_type, description, updated_at) VALUES
  ('stable_window_ms',          '1500',       'int',    '判稳窗口（毫秒）：连续这么久的读数波动在容差内才算稳', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('stable_tolerance_01kg',     '50',         'int',    '判稳波动容差，单位 0.1kg（50=5kg）',                  strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('open_order_alert_minutes',  '30',         'int',    '在途单停留提醒阈值（分钟），看板与工作台共用',        strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('settle_merge_by_day',       'true',       'bool',   '同一售粮人同日多单合并成一张结算单',                  strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('print_channel',             '"preview"',  'string', '打印通道：preview 窗口预览 / pdf_silent 静默 / raw ESC-POS 直写', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('reprint_need_auth',         'true',       'bool',   '补打需站长现场授权',                                  strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('retention_sample_days',     '30',         'int',    '留样保存天数（质检留样到期清库）',                    strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('pii_mask_id_card',          'true',       'bool',   '界面显示身份证号中间打码（与 pii_encrypt_enabled 的存储加密是两回事）', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');
