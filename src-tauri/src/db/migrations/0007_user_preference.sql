-- ============================================================================
-- 0007_user_preference.sql —— 新增 §9.25 `user_preference`：按账号存的个人界面偏好
--
-- 起因是磅房工作台要支持「千人千面」：磅员把称重区拉大成半屏、化验员把化验区挪到
-- 首屏左上、站长保留默认三栏。这类布局是**个人显示偏好**，不是站点参数：
--  - 不进 `app_setting`。那张表全站一行一键、由站长改并写审计，界面偏好每人每机都
--    不同，塞进去会把参数页淹成一屏噪音，也让"改了参数"的审计失去意义。
--  - 不存 localStorage（主题色板走的那条路）。磅房机是轮班共用的，同一个账号换一台机
--    重排一遍第二天又没了，等于没有。跟账号走才叫「他的布局」。
--
-- 值整体存 JSON 文本，服务端不解析其内部结构（布局是前端的概念），只做
-- 「合法 JSON + 长度上限」两道闸门，见 `src-tauri/src/prefs.rs`。
--
-- 主键取 (user_id, key)：同一账号同一键只有一行，写入用 UPSERT 覆盖，
-- 删账号时随 `user_account` 级联消失——偏好不是留痕数据，不需要像署名那样保留。
-- ============================================================================

CREATE TABLE user_preference (
    user_id    INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    key        TEXT    NOT NULL,               -- 偏好键，如 workstation.layout
    value_json TEXT    NOT NULL,               -- 偏好值（JSON 文本，服务端不解析结构）
    updated_at TEXT    NOT NULL,               -- 最后写入时间，排查"谁把它改乱了"用
    PRIMARY KEY (user_id, key)
);
