-- ============================================================================
-- 0009_ic_flow_card.sql —— 流转卡池（docs/design/06 篇）
--
-- 一单一卡、循环回收。制单后磅员把一张空闲卡放上机器 → 绑到这张在途单，
-- 农户拿这张卡上磅刷三次推进「毛重 → 皮重 → 结算」，结算终态自动释放回池。
-- 卡只认单不认人：`card_no` 是寻卡返回的 UID（大写十六进制、去分隔符归一），
-- 卡内不写任何业务数据（routon-idr 不暴露写块接口），所有映射只在这张表里。
--
-- `weigh_order.card_no` 是 0001 建表就留的死列，本篇**启用**为单据侧卡号快照；
-- 但占用真相只在本表一行内，不在 weigh_order 上玩部分唯一索引（06 §5.2）。
-- `idx_order_card` 建在 weigh_order 上，只加速"按卡号反查在途单"，不点名为 §9.26 索引。
--
-- 同批补 §9.3.1 的四个参数键：`schema_contract.rs::seed_baseline_matches_design_doc`
-- 要求文档键集与库内键集逐字相等，所以建表脚本与参数种子一起提交。
-- 与 0006/0008 同规：只 INSERT OR IGNORE，站长已手动写过的值升级不覆盖。
-- ============================================================================

CREATE TABLE IF NOT EXISTS card (
  card_no           TEXT    NOT NULL PRIMARY KEY,            -- 归一后的卡 UID，出厂不可改
  label             TEXT,                                     -- 印刷编号/贴签，现场人眼认的那串
  status            TEXT    NOT NULL DEFAULT 'in_pool'
                      CHECK (status IN ('in_pool','in_use','retired')),
  current_order_id  INTEGER REFERENCES weigh_order(id),       -- 仅 status='in_use' 时非空
  issued_at         TEXT,
  issued_by         INTEGER REFERENCES user_account(id),
  retired_at        TEXT,
  retire_reason     TEXT,
  remark            TEXT,
  created_at        TEXT NOT NULL,
  created_by        INTEGER NOT NULL REFERENCES user_account(id),
  updated_at        TEXT,
  updated_by        INTEGER REFERENCES user_account(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_card_label ON card(label) WHERE label IS NOT NULL AND label <> '';
CREATE INDEX IF NOT EXISTS idx_order_card ON weigh_order(card_no) WHERE card_no IS NOT NULL;

INSERT OR IGNORE INTO app_setting (key, value_json, value_type, description, updated_at) VALUES
  ('card_flow_mode',            '"auto"', 'string', '是否启用流转卡：auto＝工作台后台常听 IC、刷卡推进毛重/皮重/结算；off＝不启用流转卡，工作台一律手点',           strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('card_pool_warn_free',       '5',      'int',    '空闲卡低于此值时看板与卡池页黄色预警（06 §4.4 C8）',                                                   strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('card_release_on_terminal',  'true',   'bool',   '磅单到终态是否同事务自动解绑回池；置 false 则强制人工退卡才回池',                                     strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('card_swipe_debounce_ms',    '1500',   'int',    '同一张卡重复命中的去抖窗口（毫秒），窗口内只算一刷（06 §4.2 防连击）',                                 strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');
