-- ============================================================================
-- 0011_retire_print_channel.sql —— 退役 `print_channel` / `print_silent` 两个打印参数
--
-- 现场规矩收敛成一条：磅房工作台点打印 = 不弹预览、直接打到默认打印机。
-- 出口按**模板纸型**自动分流——热敏走 ESC/POS 直写 usbprint.sys，A4/241 针式经
-- `queue_print.rs` 的 GDI 直打 Windows 打印队列，纸型/托盘/方向一概随打印机自身配置。
-- 于是：
--  - `print_channel`（preview|pdf_silent|raw 三选）没有可配的了：没有"通道"让人选，
--    选纸也不再是软件的事；
--  - `print_silent`（"PDF 静默打印"开关）从建库起就没有一行代码读过它，是纯摆设。
-- 参数目录（`lib/settings-catalog.ts`）同步移除两项，03 文档 §9.3.1 基线一并删行
-- （`schema_contract.rs::seed_baseline_matches_design_doc` 要求文档键集与库内键集逐字相等）。
--
-- 历史脚本（0002 的 print_silent、0006 的 print_channel）一字不改：迁移按已应用哈希校验，
-- 改历史即验校失败。这里只在末尾 DELETE，把两行从存量库里请出去。
-- ============================================================================

DELETE FROM app_setting WHERE key IN ('print_channel', 'print_silent');
