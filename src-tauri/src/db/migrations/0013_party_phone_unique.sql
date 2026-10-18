-- ============================================================================
-- 0013_party_phone_unique.sql —— 售粮人手机号唯一（与证号同档）
--
-- 02 §F3.1 档案维护的口径是「一人一档」：证号从建库起就带唯一索引（`idx_party_fp`），
-- 手机号却一直只有个普通前缀索引，谁都能重复填。现场两种翻车：工作台按电话搜人
-- 一次跳出三户不知道选哪个；回访电话打过去，另一端是中介而不是农户。
-- 这里把电话抬到与证号同一档——库侧唯一索引兜底，`party_save` 侧先查后写、
-- 报出「该手机号已是档案 X」的人话提示（02 §F3.1 验收口径）。
--
-- 归一口径：存进去的就是比对的形状——去空格、去 `-`、转大写，空串一律 `NULL`。
-- NULL 不参与唯一约束，两个「没填电话」的档案不会互相顶掉；留着 `'138-0013-8000'`
-- 与 `'13800138000'` 两种写法并存，唯一索引就是摆设。
--
-- 存量重复按现场规矩收敛：**保留最早那份档案**（`id` 最小，通常是首次读卡建的），
-- 其余档案的电话置空并在 `audit_log` 逐条留痕（action=`party.phone.dedupe`），
-- 现场照审计清单补录即可。不这么处理的话，只要库里有一对重复号，建索引就会让
-- 站点机直接开不了机——人没法进界面改档案，只能拿 SQL 救。
--
-- `phone_enc` 现在是明文 UTF-8（PII 加密的过渡态，见 0001 §9.6 注释与 orders.rs 头注），
-- 唯一性直接建在该列上。真上 AES-GCM（随机 IV 使密文不可比较）时，唯一性要换到
-- 哈希列 `phone_fp` 上承担，与证号同一条路子；届时本索引随之改列，业务口径不变。
-- ============================================================================

-- 1) 归一存量：去分隔符、转大写；空串转 NULL
UPDATE party
   SET phone_enc = NULLIF(upper(replace(replace(trim(CAST(phone_enc AS TEXT)), '-', ''), ' ', '')), '');

-- 2) 同一号码只留最早那份档案，其余置空并留痕
CREATE TEMP TABLE _phone_dup AS
SELECT id, phone_enc,
       (SELECT MIN(q.id) FROM party q WHERE q.phone_enc = party.phone_enc) AS keep_id
  FROM party
 WHERE phone_enc IS NOT NULL;

INSERT INTO audit_log (at, actor_name, action, entity, entity_id, entity_no, reason, result)
SELECT strftime('%Y-%m-%dT%H:%M:%f', 'now', 'localtime'),
       '系统迁移', 'party.phone.dedupe', 'party', d.id, COALESCE(p.code, CAST(d.id AS TEXT)),
       '手机号 ' || CAST(d.phone_enc AS TEXT) || ' 与档案 #' || d.keep_id || ' 重复，本次迁移已置空，请在档案页补录',
       'ok'
  FROM _phone_dup d JOIN party p ON p.id = d.id
 WHERE d.id <> d.keep_id;

UPDATE party SET phone_enc = NULL
 WHERE id IN (SELECT id FROM _phone_dup WHERE id <> keep_id);

DROP TABLE _phone_dup;

-- 3) 唯一索引顶掉原来的普通索引（同一列上不留两个索引）
DROP INDEX IF EXISTS idx_party_phone;
CREATE UNIQUE INDEX IF NOT EXISTS uk_party_phone ON party(phone_enc) WHERE phone_enc IS NOT NULL;
