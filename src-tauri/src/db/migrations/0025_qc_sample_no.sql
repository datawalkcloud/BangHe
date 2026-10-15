-- ============================================================================
-- 0025_qc_sample_no.sql —— 样品号与留样号纳入统一取号（docs/design/03 §3.5）
--
-- 换掉的两行是 `orders.rs` 里手写出来的：
--     sample_no    = "YP" + yymmdd + (order_id % 1000)
--     retention_no = "LY" + yymmdd + "M"
-- 两个都不成立。样品号在同一天的两单 id 只差 1000 的整数倍时直接撞号，`%y` 还会十年回绕；
-- 留样号更硬——同一天所有化验单拿到的是**完全相同**的一串（尾巴那个 `M` 是常量，不是序号）。
-- 现场表现为质检单上印着两个不同样品的"样品号/留样号"长得一模一样，按号找样时找不出
-- 哪一个才是手里这瓶，迎检抽查留样也讲不清。
--
-- 改法：两枚号并入 `next_no` 那条 seq_counter 通道，由 `order_sample_label` 一单一号
-- （01 篇扦样口径「按车次扦取样品，生成样品编号绑定磅单」——一车粮一个样、一瓶留样，
-- 所以号绑的是磅单；复检只是新插一行 `qc_report`，同一瓶不能再贴一张新标签）。
--
-- 号段与其它单据同构，只把日期段换成到天：`<前缀><站点码2><YYYYMMDD><流水 seq_len>`。
-- 为什么到日而不沿用月段：留样清库按自然日算（`retention_sample_days`，且本脚本顺手把它
-- 真的接进 `retention_until`——原先那里写死 30 天，设置页那一栏改了不生效），磅房翻瓶子
-- 认的就是"哪天留的样"，月段正好把这一天抹平。计数器键随之变成 `<doc>:<站码>:<YYYYMMDD>`，
-- 即按日归零，`YP:` / `LY:` 与 `BD:` / `ZJ:` 共用同一张表。
--
-- ============================ 回灌与唯一索引的先后（这段是本次改动的风险中心）
--
-- ① 先落两枚前缀键：回灌要照它拼号，程序侧 `next_no_in_period` 取的也是同一枚键，
--   两边必须出自一处，否则历史号与新号的头一段就对不齐。与 0009/0016/0020/0023 同规：
--   只 INSERT OR IGNORE，站长改过的前缀升级不覆盖。
-- ② 再回灌历史行：一单一个号，日期段取当初的化验日（`inspected_at` 的本地日期部分），
--   序号按"每单最早那张化验单"的 id 升序在同一天内排。空值照旧留空（没留样就是没留样，
--   界面已经有「未留样」那条分支，`QcDetailPage.tsx` 与 `OrderDetailPage.tsx` 都在走）。
-- ③ **然后必须给 seq_counter 补账**。漏这一步是最坏的收场：某一天的号已经发到 000037，
--   但账上是空的，升级后第一次保存化验单就会重发 000001 —— 撞在 ④ 的索引上，
--   直接炸在「保存化验单」这个主操作里。补账用 `MAX(current, excluded.current)`，
--   只会往上抬、不会把已经跑得更远的计数器拉回来。
--   回灌顺带把**空串归成真 NULL**：SQLite 的唯一索引容得下任意多个 NULL 并存，却会把两个
--   `''` 判成重复。装机库里只要有一行样品号是空串（早期手改库、或从更老的备份回来的行），
--   ④ 建索引就会 `UNIQUE constraint failed: qc_report.sample_no` 让整个脚本回滚、应用拒绝启动
--   ——与 0024 那次闪退同一个收场。这一步**不能留给后面的脚本补**：炸就炸在 0025 自己身上，
--   走不到 0027。读路径本来就 `COALESCE(sample_no,'')`（orders.rs 的化验单查询），NULL 与
--   空串在界面上同形，归一不改变任何显示。
--   键的面貌必须与 `next_no_in_period` 里 `format!("{doc}:{code}:{period}")` **逐字**一致：
--   少写站码后面那个冒号（`'YP:' || 站码 || 日期段`），程序侧永远查不到这行账，补了等于
--   没补，而且一声不响——只有 ③ 之后真去查一次游标才抓得住（见 schema_contract 那条）。
-- ④ 最后才钉唯一索引。顺序反过来（先建索引再回灌）会在 COMMIT 上炸——同一天存量行
--   本来就同值，这是 0024 那次「装机版闪退」的同一形状。
--
-- 索引只覆盖 `is_effective = 1`，与本表既有的 `uk_qc_effective`（§4.3 不变式 7）同一个写法：
-- 有效行里每张磅单至多一条，所以"一单两枚号"在索引外、"两单撞一枚号"在索引内。
-- 复检降级出来的历史行不受约束，正是复用同一枚号的必要余地。它兜的是人工改库、
-- 从备份回灌进外来数据这类路径；主防线仍是 ③ 之后 `next_no` 永不重发已用号。
--
-- 幂等性（执行器允许同一脚本在记账失败后被重放）：② 是纯 UPDATE，重放算出同样的值；
-- ③ 用 MAX 单调上抬；④ 带 IF NOT EXISTS。三条都成立。
-- ============================================================================

-- ① 前缀键（§9.3.1 基线，`schema_contract::seed_baseline_matches_design_doc` 要求
--    文档键集与库内键集逐字相等，故同批把 YP/LY 写进 03 篇）
INSERT OR IGNORE INTO app_setting (key, value_json, value_type, description, updated_at) VALUES
  ('doc_no_prefix_YP', '"YP"', 'string', '样品号前缀（§3.5，号段到天）', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'),
  ('doc_no_prefix_LY', '"LY"', 'string', '留样号前缀（§3.5，号段到天）', strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00');

-- ② 回灌：一单一号，与 `order_sample_label` 的复用口径一致
WITH
  scope AS (                              -- 每单最早那张化验单，作为发号锚点
    SELECT order_id AS oid, min(id) AS rid
      FROM qc_report
     GROUP BY order_id
    HAVING sum(CASE WHEN (sample_no IS NOT NULL AND sample_no <> '')
                      OR (retention_no IS NOT NULL AND retention_no <> '')
                    THEN 1 ELSE 0 END) > 0     -- 两列都空的单不发号，也别让它在游标上凭空吃掉一位
  ),
  numbered AS (                           -- 号里的日期段沿用当初的化验日，按日排号
    SELECT s.oid,
           replace(substr(q.inspected_at, 1, 10), '-', '') AS ymd,
           row_number() OVER (PARTITION BY substr(q.inspected_at, 1, 10) ORDER BY s.rid) AS rn
      FROM scope AS s
      JOIN qc_report AS q ON q.id = s.rid
  ),
  cfg AS (
    SELECT COALESCE((SELECT code FROM station ORDER BY is_active DESC, id LIMIT 1), '00') AS sc,
           -- 与 Rust 的 `setting_int(...).clamp(1, 12)` 同规，别让库里一个坏值把号面宽度带跑
           MIN(MAX(COALESCE((SELECT CAST(value_json AS INTEGER) FROM app_setting WHERE key = 'doc_no_seq_len'), 6), 1), 12) AS w,
           COALESCE(replace((SELECT value_json FROM app_setting WHERE key = 'doc_no_prefix_YP'), '"', ''), 'YP') AS pyp,
           COALESCE(replace((SELECT value_json FROM app_setting WHERE key = 'doc_no_prefix_LY'), '"', ''), 'LY') AS ply
  )
UPDATE qc_report
   SET sample_no = CASE
         WHEN sample_no IS NULL OR sample_no = '' THEN NULL     -- 空串归一成"真没号"
         ELSE (SELECT (SELECT pyp FROM cfg) || (SELECT sc FROM cfg) || n.ymd
                            || printf('%0' || (SELECT w FROM cfg) || 'd', n.rn)
                 FROM numbered AS n WHERE n.oid = qc_report.order_id)
       END,
       retention_no = CASE
         WHEN retention_no IS NULL OR retention_no = '' THEN NULL   -- 同上，空串不是"没号"
         ELSE (SELECT (SELECT ply FROM cfg) || (SELECT sc FROM cfg) || n.ymd
                           || printf('%0' || (SELECT w FROM cfg) || 'd', n.rn)
                 FROM numbered AS n WHERE n.oid = qc_report.order_id)
       END
 WHERE sample_no IS NOT NULL OR retention_no IS NOT NULL;
-- ↑ 行过滤器只把「两列都从没赋过值」的行挡在外面，**空串不能一起挡掉**：那样上面 CASE 里
--   那条归一分支根本轮不到执行，两个 '' 就原样留在有效行上撞 ④。本机实测过一次，报错是
--   `UNIQUE constraint failed: qc_report.sample_no`——整个脚本回滚、应用拒绝启动，
--   磅房机连一句人话都看不到。判"有没有号"要按 `IS NOT NULL`，判"是不是空号"交给 CASE 逐列处理。

-- ③ 补账：把每一天的游标抬到已发号之上，否则升级后第一次取号必撞 ④
WITH
  scope AS (                              -- 每单最早那张化验单，作为发号锚点
    SELECT order_id AS oid, min(id) AS rid
      FROM qc_report
     GROUP BY order_id
    HAVING sum(CASE WHEN (sample_no IS NOT NULL AND sample_no <> '')
                      OR (retention_no IS NOT NULL AND retention_no <> '')
                    THEN 1 ELSE 0 END) > 0     -- 两列都空的单不发号，也别让它在游标上凭空吃掉一位
  ),
  numbered AS (
    SELECT s.oid,
           replace(substr(q.inspected_at, 1, 10), '-', '') AS ymd,
           row_number() OVER (PARTITION BY substr(q.inspected_at, 1, 10) ORDER BY s.rid) AS rn
      FROM scope AS s
      JOIN qc_report AS q ON q.id = s.rid
  ),
  cfg AS (
    SELECT COALESCE((SELECT code FROM station ORDER BY is_active DESC, id LIMIT 1), '00') AS sc
  )
INSERT INTO seq_counter (prefix_key, current, step, updated_at)
SELECT 'YP:' || (SELECT sc FROM cfg) || ':' || ymd, max(rn), 1,
       strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'
  FROM numbered GROUP BY ymd
UNION ALL
SELECT 'LY:' || (SELECT sc FROM cfg) || ':' || ymd, max(rn), 1,
       strftime('%Y-%m-%dT%H:%M:%f','now','localtime') || '+08:00'
  FROM numbered GROUP BY ymd
ON CONFLICT(prefix_key) DO UPDATE SET
  current    = MAX(current, excluded.current),
  updated_at = excluded.updated_at;

-- ④ 唯一索引：回灌完成之后才建（见头注"顺序反过来会炸在 COMMIT"那段）
CREATE UNIQUE INDEX IF NOT EXISTS uk_qc_sample    ON qc_report(sample_no)    WHERE is_effective = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uk_qc_retention ON qc_report(retention_no) WHERE is_effective = 1;
