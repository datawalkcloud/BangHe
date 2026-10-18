-- ============================================================================
-- 0020_outbound_order.sql —— 粮食出库单（docs/design/02 §M11、03 §9.27）
--
-- 与收购链（weigh_order）**平行且独立**的一张单据：出库没有化验环节、没有
-- 「一次/二次称重」的强制顺序，最短路径就是「制单 → 完成出库」。硬套磅单那 13 态
-- 会把已经稳定的收粮主流程拖进回归面，所以另起一表、另起一条状态机。
--
-- 两档性质共用这一张表，刻意不再细分：
--   · `sale`   销售出库——有领出方与单价，出仓即挂货款（收款登记是波 3 的事）；
--   · `record` 登记出库——领用/自用/损耗，粮出仓但不产生钱，单价必须留空。
-- 两者的状态机、库存扣减、红冲路径完全同一条，差别只在计价与否。
-- 转仓（transfer）属 M11 后半段，本期不提供录入入口，也不在这张表上开口子。
--
-- 本期（波 1）只有手填净重：`weight_source` 建表即带、默认 `manual`，
-- 因为「这个重量是人敲的还是秤取的」是迎检必查项，不能等接了秤再补——
-- 补上去历史行只能一律回填 manual，等于事后编。波 2 接秤时新增毛/皮重列与
-- 称重记录（复用 weigh_record 的 doc_kind），这一列从此由捕获路径写 `scale`。
--
-- `payment_status` 值域沿用磅单那份 OrderPaymentStatus（登记出库恒 not_required，
-- 销售出库本期落 unpaid，收款核销在波 3 接手）。不新造枚举。
--
-- 号段：`CK` + 站点码 + YYYYMM + 流水（§3.5），与 BD/ZJ/JS/FK 同一张 seq_counter，
-- 同事务取号、月内归零。前缀键进 §9.3.1 基线，`schema_contract::
-- seed_baseline_matches_design_doc` 要求文档键集与库内键集逐字相等，故同批种子。
-- 与 0009/0010/0016 同规：只 INSERT OR IGNORE，站长手改过的值升级不覆盖。
-- ============================================================================

CREATE TABLE IF NOT EXISTS outbound_order (
  id                 INTEGER   PRIMARY KEY AUTOINCREMENT,
  order_no           TEXT      NOT NULL,                     -- CK 号段，唯一性由 uk_outbound_no
  station_id         INTEGER   NOT NULL REFERENCES station(id),
  business_date      TEXT      NOT NULL,                     -- 业务日期，统计归属日（与磅单同口径）
  kind               TEXT      NOT NULL DEFAULT 'sale'
                                 CHECK (kind IN ('sale','record')),
  status             TEXT      NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft','done','voided','reversed')),
  party_id           INTEGER   REFERENCES party(id),         -- sale 必填（服务层判），record 可空
  counterparty_label TEXT,                                    -- 非档案领出方：部门/用途对象，自由文本
  variety_id         INTEGER   REFERENCES grain_variety(id),
  grade              TEXT,                                     -- 等级，值域同磅单（服务层判，无 CHECK）
  warehouse_id       INTEGER   NOT NULL REFERENCES warehouse(id),  -- 出仓来源，不可空：出库必须有出处
  slot_id            INTEGER   REFERENCES storage_slot(id),
  vehicle_no         TEXT,
  net_weight_01kg    INTEGER,                                  -- 出库净重（0.1kg），波 1 手填
  weight_source      TEXT      NOT NULL DEFAULT 'manual'
                                 CHECK (weight_source IN ('scale','manual')),
  price_fen_per_ton  INTEGER,                                  -- 单价（分/吨），record 恒 NULL
  goods_amount_fen   INTEGER,                                  -- 货款 = 净重 × 单价 ÷ 10000，与 src/lib/calc.ts 同构
  payment_status     TEXT      NOT NULL DEFAULT 'not_required'
                                 CHECK (payment_status IN ('unpaid','partial','paid','not_required')),
  -- 超库存不拦车：账面结存不够时照常出库，服务端把算给你看的那句话存进来，
  -- 屏显醒目条 + 时间轴 + 票面留痕（与 0017/皮重容差同一口径）。
  stock_warning      TEXT,
  void_reason        TEXT,                                     -- 作废/红冲共用那一句原因（红冲必填）
  completed_at       TEXT,
  completed_by       INTEGER   REFERENCES user_account(id),    -- 值仓确认出仓的署名
  remark             TEXT,
  created_at         TEXT      NOT NULL,
  created_by         INTEGER   NOT NULL REFERENCES user_account(id),
  updated_at         TEXT,
  updated_by         INTEGER   REFERENCES user_account(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_outbound_no      ON outbound_order(order_no);
CREATE INDEX        IF NOT EXISTS idx_outbound_date   ON outbound_order(business_date, status);
CREATE INDEX        IF NOT EXISTS idx_outbound_party  ON outbound_order(party_id, business_date);
CREATE INDEX        IF NOT EXISTS idx_outbound_wh     ON outbound_order(warehouse_id, business_date);

INSERT OR IGNORE INTO app_setting (key, value_json, value_type, description, updated_at) VALUES
  ('doc_no_prefix_CK', '"CK"', 'string', '出库单号前缀（§3.5）', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');
