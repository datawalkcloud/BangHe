-- ============================================================================
-- 0002_seed.sql —— 首版数据基线（docs/design/03 §6）
--
-- 只写「有确定来源」的数据：§9.3.1 的系统参数键值、§6 点名的四个默认品种、
-- 承担外键根的单条站点记录、以及强制改密的初始站长账号。
-- 不写演示数据：品种国标限量（std_*）、袋重、真实站名地址电话、员工名单在
-- 设计文档里没有可信来源，一律留 NULL / 由现场在 M6 档案与 M10 设置页维护，
-- 免得把 mock 里编的值当成基线灌进生产库。
-- ============================================================================

-- §3.2 要求 ISO 8601 本地时间 + 偏移。SQLite 的 strftime 无 %z，且部署地
-- （河南周口）无夏令时，偏移恒为 +08:00，故直接拼接。Rust 侧写入走 chrono，不用这里。
-- 注意：如未来部署到非 +08:00 区域，需改本文件与 domain 的时间工具。

-- ------------------------------------------------------------- 站点（外键根）
INSERT INTO station (code, name, created_at)
VALUES ('01', '邦禾粮食收储站', strftime('%Y-%m-%dT%H:%M:%f', 'now', 'localtime') || '+08:00');
-- tax_no / address / phone / legal_person 属站点实际信息，首启后在设置页填写。

-- ------------------------------------------------------------------ 初始账号
-- 口令哈希写占位符而非可用的 argon2 串：真实哈希属登录实现（02 文档 M10），
-- must_change_pwd=1 保证首次登录必须改密后才能进主界面。
INSERT INTO user_account (username, display_name, password_hash, role, must_change_pwd, is_active, created_at)
VALUES ('admin', '站长', '!set_on_first_run', 'station_master', 1, 1,
        strftime('%Y-%m-%dT%H:%M:%f', 'now', 'localtime') || '+08:00');

-- -------------------------------------------------------------- 系统参数 22 键
-- 值一律 JSON 编码（app_setting.value_json 由 serde_json 解析），描述用于设置页提示。
INSERT INTO app_setting (key, value_json, value_type, description, updated_at) VALUES
  ('doc_no_prefix_BD',            '"BD"',    'string', '磅单号前缀（§3.5）',                    strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('doc_no_prefix_ZJ',            '"ZJ"',    'string', '质检单号前缀',                            strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('doc_no_prefix_JS',            '"JS"',    'string', '结算单号前缀',                            strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('doc_no_prefix_FK',            '"FK"',    'string', '付款单号前缀',                            strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('doc_no_seq_len',              '6',       'int',    '单据编号流水位数',                        strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('weight_rounding_mode',        '"nearest_div"', 'string', '分度值对齐方式：floor/half_up/nearest_div', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('scale_division_01kg',         '100',     'int',    '汽车衡分度值（0.1kg 单位，100=10kg）',    strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('tare_tolerance_pct',          '300',     'int',    '皮重容差，单位 0.01%（300=3.00%）',       strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('payment_due_warn_hours',      '72',      'int',    '粮款支付时效预警（小时）',                strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('moisture_deduct_manual',      'true',    'bool',   '扣水为人工录入（规则引擎未启用）',        strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('impurity_deduct_manual',      'true',    'bool',   '扣杂为人工录入',                          strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('print_default_copies',        '3',       'int',    '默认打印份数（农户/留存/结算）',          strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('print_paper',                 '"A4"',    'string', '码单纸型：A4/dot241/thermal58/thermal80', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('print_silent',                'false',   'bool',   'PDF 静默打印（需先真机验证）',            strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('capture_on_gross',            'true',    'bool',   '毛重抓拍',                                strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('capture_on_tare',             'true',    'bool',   '皮重抓拍',                                strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('attachment_max_kb',           '500',     'int',    '抓拍压缩上限（KB）',                      strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('attachment_keep_days',        '3650',    'int',    '附件留存天数（10 年）',                   strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('backup_dir',                  '""',      'string', '备份目录，空=AppDataDir/backup',          strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('backup_keep_count',           '30',      'int',    '备份保留份数',                            strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('settlement_allow_part_pay',   'true',    'bool',   '允许部分付款（挂账）',                    strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('pii_encrypt_enabled',         'true',    'bool',   '证号/照片字段级加密（aes-gcm + keyring）', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');

-- ---------------------------------------------------------------- 默认品种
-- §6 点名玉米/小麦/稻谷/大豆；code 与 §9.8 注释、前端 VARIETY_COLOR 一致。
-- enabled_indicators_json 取 constants.ts 的 INDICATOR_ORDER 全集（当前 UI 的指标字典
-- 就是这个集合），品种差异化停用由 M6 档案页维护；此处不凭猜测裁剪。
-- std_* 留 NULL：国标限量各品种各等级不同，文档未给，写死会变成错的提示。
INSERT INTO grain_variety (code, name, category, enabled_indicators_json, sort_order, is_active, created_at) VALUES
  ('YM', '玉米', '主粮', '["moisture","impurity","unsound","bulk_density","mold","yellow_grain","head_rice","odor"]', 10, 1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('XM', '小麦', '主粮', '["moisture","impurity","unsound","bulk_density","mold","yellow_grain","head_rice","odor"]', 20, 1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('DG', '稻谷', '主粮', '["moisture","impurity","unsound","bulk_density","mold","yellow_grain","head_rice","odor"]', 30, 1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('DD', '大豆', '油料', '["moisture","impurity","unsound","bulk_density","mold","yellow_grain","head_rice","odor"]', 40, 1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');

-- role_permission 首版建表但不灌授权数据：默认授予集需要业务确认（02 文档 P1），
-- 空表 + 代码里的「站长恒允许」即可跑通首版。
