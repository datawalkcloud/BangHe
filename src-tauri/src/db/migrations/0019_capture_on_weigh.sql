-- ============================================================================
-- 0019_capture_on_weigh.sql —— 过磅抓拍相机改为「按相机勾选、每次最多 3 台」（docs/design/04 §4）
--
-- 之前一次过磅（毛重一捕、皮重一捕）固定只用「台账里默认/启用的那台相机」拍一张。
-- 现在哪几台相机参与过磅抓拍，改由相机台账 config 里的 `captureOnWeigh` 勾选决定
-- （本机 USB 摄像头与内网 IP 摄像机可混着勾，一次最多 3 台各拍一张）。
--
-- 老数据升级不能静默丢掉抓拍：这里把「旧逻辑本来就会选中的那台相机」（kind='camera'
-- 且 is_enabled=1，按 is_default DESC, id 排第一）勾上 `captureOnWeigh`，让升级后的
-- 第一趟过磅与升级前拍同一台机；站长要加到 2～3 台，去设备中心再勾即可。
--
-- 只回填那一台（不是所有启用相机都勾），与 `is_default` 唯一索引 uk_dev_default 同一口径。
-- 用 json_patch 合并进原有 config，绝不覆盖 host/user/snapshotUrl 等既有键；
-- 只对 `json_valid` 的配置生效，脏数据跳过而不是把整趟升级卡住。不改表结构，
-- 因此不需重新 bless schema_snapshot（快照比的是 DDL，不是数据）。
-- ============================================================================

UPDATE device_config
SET config_json = json_patch(config_json, '{"captureOnWeigh":true}'),
    updated_at  = strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'
WHERE id = (
  SELECT id FROM device_config
  WHERE kind = 'camera' AND is_enabled = 1 AND json_valid(config_json)
  ORDER BY is_default DESC, id
  LIMIT 1
);
