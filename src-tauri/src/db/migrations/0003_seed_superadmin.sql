-- ============================================================================
-- 0003_seed_superadmin.sql —— 预留超级管理员账号（docs/design/02 §11 M10）
--
-- 为什么单独一个脚本而不是改 0002：`schema_migration.checksum` 会在启动时比对
-- 已应用脚本，改 0002 等于让每台已装好的机器拒启（tests/schema_contract.rs 里的
-- tampered_applied_script_refuses_startup 就是在钉这件事）。
--
-- 口令哈希同样写占位符，不写任何"看起来能用"的 argon2 串：
-- 该账号只有在库里仍是 `!set_on_first_run` 时才认装机初始口令
-- （`src/auth.rs::bootstrap_password`），改过一次密这条路即永久关闭。
-- must_change_pwd=1 保证进去第一件事就是设口令，不给现场留一个众所周知的后门。
-- ============================================================================

INSERT INTO user_account (username, display_name, password_hash, role, must_change_pwd, is_active, created_at)
SELECT 'superadmin', '超级管理员', '!set_on_first_run', 'station_master', 1, 1,
       strftime('%Y-%m-%dT%H:%M:%f', 'now', 'localtime') || '+08:00'
WHERE NOT EXISTS (SELECT 1 FROM user_account WHERE username = 'superadmin');
