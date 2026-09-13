-- ============================================================================
-- 0014_idle_lock_setting.sql —— 空闲自动锁屏时长进「站点参数」
--
-- M10 交付时锁屏时长是 `auth.rs::IDLE_TTL_SECS` 常量（那时就写明：做成设置项
-- 要补这个键）。现在按承诺落键：
--   idle_lock_minutes：无操作多少分钟后自动锁屏；0＝从不锁屏。
-- 锁屏≠登出——只输一次本人密码即原地继续，所以时长由站长按现场节奏定。
--
-- 只 INSERT OR IGNORE：站长改过的值不许被升级覆盖（与 0006 同一条纪律）。
-- `tests/schema_contract.rs::seed_baseline_matches_design_doc` 要求键集与
-- 03 文档 §9.3.1 逐字相等，本文加键的同时已补写文档。
-- ============================================================================

INSERT OR IGNORE INTO app_setting (key, value_json, value_type, description, updated_at) VALUES
  ('idle_lock_minutes', '60', 'int', '无操作多少分钟后自动锁屏（0＝从不）；锁屏只输本人密码解锁，不退出登录', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');
