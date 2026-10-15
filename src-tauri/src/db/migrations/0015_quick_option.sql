-- ============================================================================
-- 0015_quick_option.sql —— 事由/结论类「快捷选项」进可维护的基础档案
--
-- 之前这些「点一句人话」的候选（作废事由 / 改价·改判事由 / 拒收原因 / 流转卡注销
-- 原因 / 制单备注 / 气味结论）是写死在前端 constants.ts 里的常量，换个站点的话术
-- 就要改代码重新打包。现在收进 `quick_option` 表，站长在「基础档案 › 常用语/快捷
-- 选项」里增删改（03 §9.27）。落库仍是自由文本，本表只给文本框预备选，不做枚举锁死。
--
-- `kind` 是分类码（void/price/reject/card_retire/remark/odor），值域只在代码里校验
-- （`masters.rs::QUICK_OPTION_KINDS` 与前端 `QuickOptionKind` 同源），**不加 CHECK**：
-- 将来扩一类只改代码，不必再动表结构。软删除/审计四件套对本表无意义（单据存的是
-- 那句文本本身，不引用行 id），故删除即物理删，历史单据不受影响。
-- ============================================================================

CREATE TABLE IF NOT EXISTS quick_option (
  id         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,                 -- void / price / reject / card_retire / remark / odor
  label      TEXT    NOT NULL,                 -- 下拉清单上看的短词
  value      TEXT    NOT NULL,                 -- 点一下真正填进文本框、进单据与审计的那句完整话
  sort_order INTEGER NOT NULL DEFAULT 0,       -- 同类内展示顺序
  is_active  INTEGER NOT NULL DEFAULT 1,       -- 停用只挡住下拉里不出现，不删历史
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quick_option_kind ON quick_option (kind, sort_order);

-- 首版种子：与 src/lib/constants.ts 里那六组 presets 逐字一致，装完库站长就能改。
-- 建表在升级库里也是新建（此前无此表），正常只灌一次；这里不额外去重，
-- 校验和机制保证脚本不会被二次执行（见 migrate.rs 规矩 2）。
INSERT INTO quick_option (kind, label, value, sort_order, is_active, created_at) VALUES
  ('void','农户取消售粮','农户临时取消售粮，车辆已卸离磅面',1,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('void','登记信息有误','售粮人或车牌登记错误，需重新制单',2,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('void','品种选错','粮食品种选错，需重新制单',3,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('void','同一车重复制单','同一车辆重复制单，本单作废',4,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('void','误触发称重','车辆未实际过磅，误触发称重',5,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('void','读数异常','磅面读数异常，需重新过磅',6,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('void','流转卡绑错','流转卡绑定错误，需重新发单',7,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('void','取样与本单不符','化验取样与本单不符，需重采重检',8,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),

  ('price','水分超扣价','水分超基准，按本站扣价下调',1,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('price','杂质超扣价','杂质超基准，按本站扣价下调',2,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('price','等级下调','化验等级下调，按低一等计价',3,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('price','外观欠佳','外观色差霉粒偏多，现场议价下调',4,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('price','无生效价目','该品种该等级暂无生效价目，手工定价',5,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('price','随行就市议价','与售粮人现场议价，价格与价目表不同',6,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),

  ('reject','水分超高','水分超过拒收上限，现场退粮',1,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('reject','霉变超标','霉变粒超标，现场退粮',2,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('reject','气味异常','气味异常有异味，现场退粮',3,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('reject','杂质太多','杂质过多含土含秆，现场退粮',4,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('reject','掺假掺杂','疑似掺假掺杂，现场退粮并报站长',5,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('reject','品种不符','实物与登记品种不符，现场退粮',6,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),

  ('card_retire','农户领走遗失','农户领走后遗失，已挂失停用',1,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('card_retire','卡面损坏','流转卡破损，感应失灵无法使用',2,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('card_retire','升级换发新卡','卡面信息过期，注销后换发新卡',3,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('card_retire','卡池清点回收','日结账卡卡数不符，注销留存根',4,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),

  ('remark','带皮带','带皮带过磅',1,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('remark','需复检','需复检',2,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('remark','自带编织袋','自带编织袋装粮',3,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('remark','换车再来','本车未卸完，换车继续售粮',4,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('remark','司机代售','农户未到场，司机代售',5,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),

  ('odor','正常','正常',1,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('odor','无异味','无异味',2,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('odor','轻微异味','轻微异味',3,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('odor','有霉味','有霉味',4,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('odor','异味明显','异味明显',5,1, strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');

