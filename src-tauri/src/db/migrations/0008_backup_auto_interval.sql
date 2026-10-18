-- ============================================================================
-- 0008_backup_auto_interval.sql —— 补 `backup_auto_interval_days` 一行
--
-- §7 承诺"每日首次启动或跨日时"自动出快照，实现是 `system.rs` 里一个每小时醒一次的
-- 后台线程：比对备份目录里最新一份（`pre_migrate_*` 除外，那是迁移退路不是日常快照）
-- 的时间戳，间隔够数才补一份。间隔天数读这个键，读不到退默认 1。
--
-- 为什么现在才入库：`masters.rs::setting_update` 只 UPDATE 不 INSERT，库里没有行的键
-- 站长改了会直接报"在库里没有这一项"。参数页（`lib/settings-catalog.ts`）已经收录了
-- 这一项，没有这行就成了一个看得见、点不动的输入框，所以补上。
--
-- 与 0006 同一条规矩：只 INSERT OR IGNORE。这台机器上站长若已手动写过值，升级不许覆盖。
-- 键名同时补进 03 文档 §9.3.1——`schema_contract.rs::seed_baseline_matches_design_doc`
-- 要求文档键集与库内键集逐字相等。
-- ============================================================================

INSERT OR IGNORE INTO app_setting (key, value_json, value_type, description, updated_at) VALUES
  ('backup_auto_interval_days', '1', 'int', '自动备份间隔（天）：程序每小时检查一次，距上次副本超过这个天数就补一份', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');
