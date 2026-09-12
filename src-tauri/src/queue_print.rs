//! 打印队列直打（无预览，04 §5.2 通道 B 的落地入口）。
//!
//! 磅房工作台的码单要求「点打印 = 直接出纸」：热敏机走 [`crate::printer::print_receipt`]
//! 的 usbprint 直写；A4 激光与 241 针式没有 USB 裸通道可走，只能进 Windows 假脱机队列。
//! 本模块把前端按用户模板排好的同一份行序列（`PrintLine`）用 GDI 画到打印机 DC 上，
//! 经 StartDoc/EndDoc 提交队列——全程不弹任何对话框。
//!
//! **纸张从哪里来**：这是这个模块最硬的一条规矩——**程序不选纸**。
//! 打开队列后取的是 `DocumentProperties` 返回的打印机**默认 DEVMODE**，一个字段都不改
//! 就交给 `CreateDC`：纸型、来源托盘、方向、驱动边距全部以打印机自身配置为准。
//! 针式机装的是 241 连续纸、激光机装的是 A4，票面就各自跟着装什么打什么；
//! 可打区域也从驱动上报的 PHYSICAL* 反推，绝不拿"A4 减 20mm"这类写死的页边距去套
//! 一台根本不知道装了什么的机器。
//!
//! 与热敏侧同款的三条硬性约定（见 `printer.rs` 头注释）：spawn_blocking、返回带
//! status/error、失败不抛错只回 ok=false——打印永远不能成为磅队的堵点。

use std::time::Instant;

use serde::Deserialize;
use tauri::command;

use crate::printer::PrintOutcome;
use ticket_core::model::PrintLine;

/// 队列直打的入参。
///
/// 与 [`crate::printer::ReceiptPrintInput`]（ESC/POS 直写）的关键差别：**没有 paper 字段**。
/// 纸是打印机的配置，不是票的参数；行序列里也没有任何需要纸宽才能定的东西——
/// 排版交给 GDI 的测量绘制完成，前端只管把票面拆成行。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptQueuePrintInput {
    /// 行序列（票头 / 字段区 / 表格 / 署名 / 票尾），与热敏通道同一份契约
    pub lines: Vec<PrintLine>,
    /// 目标打印队列名；缺省（None / 空串）= 用系统默认打印机
    #[serde(default)]
    pub printer: Option<String>,
    /// 份数；缺省 1，上限 6（与热敏侧 `write_lines` 同口径）
    #[serde(default)]
    pub copies: Option<u8>,
}

/// 队列直打：无预览，直达 Windows 打印队列，纸张等配置全随打印机。
#[command]
pub async fn print_receipt_queue(input: ReceiptQueuePrintInput) -> Result<PrintOutcome, String> {
    Ok(tauri::async_runtime::spawn_blocking(move || print_queue_blocking(input))
        .await
        .map_err(|e| format!("队列直打任务失败: {e}"))?)
}

/// 非 Windows：没有 Windows 假脱机可直打，明说一句（前端据此回退到预览框）。
#[cfg(not(target_os = "windows"))]
fn print_queue_blocking(input: ReceiptQueuePrintInput) -> PrintOutcome {
    drop(input);
    PrintOutcome::failed(
        Instant::now(),
        "队列直打仅支持 Windows；其余平台请走窗口预览".to_string(),
    )
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;

    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{COLORREF, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateDCW, CreateFontW, DeleteDC, DeleteObject, DrawTextW, GetDeviceCaps, GetStockObject,
        LineTo, MoveToEx, PatBlt, SelectObject, SetBkMode, SetTextColor, BLACK_BRUSH,
        CLIP_DEFAULT_PRECIS, DEFAULT_PITCH, DT_CALCRECT, DT_CENTER, DT_EDITCONTROL, DT_LEFT,
        DT_NOPREFIX, DT_RIGHT, DT_TOP, DT_WORDBREAK, FF_MODERN, FW_BOLD, GB2312_CHARSET, HDC,
        HFONT, LOGPIXELSX, LOGPIXELSY, NONANTIALIASED_QUALITY, OUT_DEFAULT_PRECIS, PATCOPY,
        PHYSICALHEIGHT, PHYSICALOFFSETX, PHYSICALOFFSETY, PHYSICALWIDTH, DEVMODEW, TRANSPARENT,
    };
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, DocumentPropertiesW, OpenPrinterW, PRINTER_HANDLE,
    };
    use windows::Win32::Storage::Xps::{EndDoc, StartDocW, StartPage, DOCINFOW};

    use ticket_core::model::TextAlign;

    pub(super) fn print_queue_blocking(input: ReceiptQueuePrintInput) -> PrintOutcome {
        let started = Instant::now();
        let copies = input.copies.unwrap_or(1).clamp(1, 6);

        // 1. 定机：点名就用点名的，否则取系统默认打印机（枚举口径与设备中心同一份）
        let printer = match resolve_printer(input.printer.as_deref()) {
            Ok(name) => name,
            Err(e) => return PrintOutcome::failed(started, e),
        };
        let name_w = to_nul_wide(&printer);

        // 2. 打开队列 + 取打印机**默认** DEVMODE（不改任何字段 = 纸型/托盘/方向全随打印机）
        let mut hprinter = PRINTER_HANDLE::default();
        let devmode_buf: Option<Vec<u64>>;
        let hdc;
        unsafe {
            if OpenPrinterW(PCWSTR(name_w.as_ptr()), &mut hprinter, None).is_err() {
                return PrintOutcome::failed(
                    started,
                    format!(
                        "打不开打印队列「{printer}」：确认打印机未被脱机/暂停，或改用系统默认打印机"
                    ),
                );
            }
            let name_pcw = PCWSTR(name_w.as_ptr());
            // 首调只要缓冲大小；驱动专属区可能远大于 DEVMODEW 本体，按上报字节数分配
            let size = DocumentPropertiesW(None, hprinter, name_pcw, None, None, 0);
            devmode_buf = if size > 0 {
                let mut buf = vec![0u64; (size as usize).div_ceil(8)];
                let out = buf.as_mut_ptr().cast::<DEVMODEW>();
                // fMode = 0：只取默认设置，不回写驱动（DM_OUT_DEFAULT 语义）
                if DocumentPropertiesW(None, hprinter, name_pcw, Some(out), None, 0) > 0 {
                    Some(buf)
                } else {
                    None
                }
            } else {
                None
            };
            // 3. 用那份默认 DEVMODE 建打印机 DC；取不到就传 None（效果同：驱动自配）
            let dm = devmode_buf
                .as_ref()
                .map(|b| b.as_ptr() as *const DEVMODEW);
            hdc = CreateDCW(w!("WINSPOOL"), name_pcw, PCWSTR::null(), dm);
            if hdc.is_invalid() {
                let _ = ClosePrinter(hprinter);
                return PrintOutcome::failed(
                    started,
                    format!("无法初始化打印机「{printer}」的绘图上下文（驱动异常或离线）"),
                );
            }
        }

        // 4. 度量：像素全部由驱动上报的 dpi 与物理幅面换算，可打区域 = 物理幅面 − 驱动边距
        unsafe {
            let dpi_x = safe_dpi(GetDeviceCaps(Some(hdc), LOGPIXELSX));
            let dpi_y = safe_dpi(GetDeviceCaps(Some(hdc), LOGPIXELSY));
            let phys_w = GetDeviceCaps(Some(hdc), PHYSICALWIDTH);
            let phys_h = GetDeviceCaps(Some(hdc), PHYSICALHEIGHT);
            let off_x = GetDeviceCaps(Some(hdc), PHYSICALOFFSETX).max(0);
            let off_y = GetDeviceCaps(Some(hdc), PHYSICALOFFSETY).max(0);
            let left = off_x;
            let mut right = phys_w - off_x;
            let top = off_y;
            let mut bottom = phys_h - off_y;
            // 个别驱动报回自相矛盾的幅面（offset≥width）：给一个能打字的最低限度
            if right <= left + 10 {
                right = (phys_w).max(left + 200);
            }
            if bottom <= top + 10 {
                bottom = phys_h.max(top + 200);
            }

            let em = pt_px(12, dpi_y).max(8); // 正文 12pt（小四），磅房票的标准起步字号
            let _ = SetTextColor(hdc, COLORREF(0));
            let _ = SetBkMode(hdc, TRANSPARENT);

            let doc_name_w = to_nul_wide("磅房票据");
            let di = DOCINFOW {
                cbSize: std::mem::size_of::<DOCINFOW>() as i32,
                lpszDocName: PCWSTR(doc_name_w.as_ptr()),
                lpszOutput: PCWSTR::null(),
                lpszDatatype: PCWSTR::null(),
                fwType: 0,
            };
            if StartDocW(hdc, &di) <= 0 {
                let _ = DeleteDC(hdc);
                let _ = ClosePrinter(hprinter);
                return PrintOutcome::failed(
                    started,
                    "提交打印任务失败（StartDoc 被驱动拒绝）".to_string(),
                );
            }

            let mut sheet = Sheet {
                hdc,
                left,
                right,
                top,
                bottom,
                y: top,
                em,
                dpi_x,
                dpi_y,
                page_open: false,
            };
            let mut qr_err: Option<String> = None;
            for _ in 0..copies {
                sheet.open_page();
                for line in &input.lines {
                    sheet.draw_line(line, &mut qr_err);
                }
                sheet.close_page();
            }
            let end = EndDoc(hdc);
            let _ = DeleteDC(hdc);
            let _ = ClosePrinter(hprinter);
            if end <= 0 {
                return PrintOutcome::failed(
                    started,
                    "打印任务收尾失败（EndDoc 被驱动拒绝）".to_string(),
                );
            }
            // 队列只保证"驱动收下了这一份"，纸是否真的出来要看那台机自己的状态；
            // 这就是 ok 的诚实边界——note 里写清楚，前端话术也不说"已出纸"。
            let note = match qr_err {
                Some(e) => {
                    format!("已提交打印队列「{printer}」（按打印机默认纸张）；二维码未能画出：{e}")
                }
                None => format!("已提交打印队列「{printer}」（按打印机默认纸张）"),
            };
            PrintOutcome {
                ok: true,
                device: printer,
                status: ticket_core::device::DeviceStatus {
                    responding: true,
                    online: true,
                    paper_adequate: true,
                    source: "queue".into(),
                    raw_byte: None,
                    ioctl: None,
                    note,
                },
                elapsed_ms: started.elapsed().as_millis() as u64,
                error: None,
            }
        }
    }

    /// 点名的队列优先；没点名取系统默认，默认机不在时退而取枚举到的第一台。
    fn resolve_printer(wanted: Option<&str>) -> Result<String, String> {
        if let Some(w) = wanted.map(|s| s.trim()).filter(|s| !s.is_empty()) {
            return Ok(w.to_string());
        }
        let queues = crate::printer::list_queues_blocking()?;
        queues
            .iter()
            .find(|p| p.is_default)
            .or_else(|| queues.first())
            .map(|p| p.name.clone())
            .ok_or_else(
                || "本机没有可用的打印机队列：先在 Windows「设置 → 蓝牙和其他设备 → 打印机和扫描仪」里装好打印机".to_string(),
            )
    }

    /* -------------------------------------------------------------- 排版 */

    /// 一次直打的画布状态：页边界来自驱动上报，程序自己只推进 y。
    struct Sheet {
        hdc: HDC,
        left: i32,
        right: i32,
        top: i32,
        bottom: i32,
        y: i32,
        /// 正文字号的字高（像素）；倍宽倍高在它上乘
        em: i32,
        #[allow(dead_code)]
        dpi_x: i32,
        dpi_y: i32,
        page_open: bool,
    }

    impl Sheet {
        fn open_page(&mut self) {
            unsafe {
                if StartPage(self.hdc) > 0 {
                    self.page_open = true;
                }
                self.y = self.top;
            }
        }

        fn close_page(&mut self) {
            unsafe {
                if self.page_open {
                    let _ = windows::Win32::Storage::Xps::EndPage(self.hdc);
                    self.page_open = false;
                }
            }
        }

        /// 打满一页就翻页（针式连续纸同样走 StartPage，让驱动自己走纸到下一页起始位）。
        fn need(&mut self, height: i32) {
            if self.page_open && self.y + height > self.bottom {
                self.close_page();
                self.open_page();
            }
        }

        fn line_gap(&self) -> i32 {
            (self.em / 4).max(2)
        }

        fn draw_line(&mut self, line: &PrintLine, qr_err: &mut Option<String>) {
            match line {
                PrintLine::Text {
                    text,
                    align,
                    bold,
                    underline,
                    reverse: _,
                    wide,
                    tall,
                } => {
                    let tall = (*tall as i32).clamp(1, 4);
                    self.need(self.em * tall + self.line_gap());
                    let y = self.y;
                    let h = self
                        .draw_text(text, *align, self.left, self.right, y, *bold, *underline, *wide, tall as u8)
                        .unwrap_or(self.em * tall);
                    self.y = y + h + self.line_gap();
                }
                PrintLine::Kv { label, value } => {
                    self.need(self.em + self.line_gap());
                    let y = self.y;
                    // 标签靠左、数值靠右，落在同一行两端——热敏票"项目……金额"的纸面习惯
                    let _ = self.draw_text(label, TextAlign::Left, self.left, self.right, y, false, false, 1, 1);
                    let _ = self.draw_text(value, TextAlign::Right, self.left, self.right, y, false, false, 1, 1);
                    self.y = y + self.em + self.line_gap();
                }
                PrintLine::Pair { l1, v1, l2, v2 } => {
                    self.need(self.em + self.line_gap());
                    let y = self.y;
                    let mid = (self.left + self.right) / 2;
                    let _ = self.draw_text(l1, TextAlign::Left, self.left, mid, y, false, false, 1, 1);
                    let _ = self.draw_text(v1, TextAlign::Right, self.left, mid, y, false, false, 1, 1);
                    let _ = self.draw_text(l2, TextAlign::Left, mid, self.right, y, false, false, 1, 1);
                    let _ = self.draw_text(v2, TextAlign::Right, mid, self.right, y, false, false, 1, 1);
                    self.y = y + self.em + self.line_gap();
                }
                PrintLine::Rule => {
                    self.need(self.em / 2 + 4);
                    unsafe {
                        let yy = self.y + self.em / 2;
                        let _ = MoveToEx(self.hdc, self.left, yy, None);
                        let _ = LineTo(self.hdc, self.right, yy);
                    }
                    self.y += self.em / 2 + 4;
                }
                PrintLine::Feed { n } => {
                    let h = (*n as i32).clamp(0, 12) * (self.em + self.line_gap());
                    self.need(h);
                    self.y += h;
                }
                PrintLine::Qr { text } => {
                    if text.is_empty() {
                        return;
                    }
                    self.qr(text, qr_err);
                }
            }
        }

        /// 在 [l, r) × y 的横条里画一段文本：先 DT_CALCRECT 量出占多高再真正画，
        /// 超宽自动折行（票面宁可长一页，不能少字）。返回实际用掉的高度。
        fn draw_text(
            &mut self,
            text: &str,
            align: TextAlign,
            l: i32,
            r: i32,
            y: i32,
            bold: bool,
            underline: bool,
            wide: u8,
            tall: u8,
        ) -> Option<i32> {
            if text.is_empty() {
                return None;
            }
            let mut w = to_wide(text);
            let flags = DT_TOP
                | DT_WORDBREAK
                | DT_EDITCONTROL
                | DT_NOPREFIX
                | match align {
                    TextAlign::Center => DT_CENTER,
                    TextAlign::Right => DT_RIGHT,
                    TextAlign::Left => DT_LEFT,
                };
            unsafe {
                let font = self.font_for(bold, underline, wide, tall);
                let old = SelectObject(self.hdc, font.into());
                let mut rc = RECT {
                    left: l,
                    top: y,
                    right: r,
                    bottom: y + 1,
                };
                let _ = DrawTextW(self.hdc, &mut w, &mut rc, flags | DT_CALCRECT);
                let used = (rc.bottom - rc.top).max(1);
                let mut rc2 = RECT {
                    left: l,
                    top: y,
                    right: r,
                    bottom: y + used,
                };
                let _ = DrawTextW(self.hdc, &mut w, &mut rc2, flags);
                SelectObject(self.hdc, old);
                let _ = DeleteObject(font.into());
                Some(used)
            }
        }

        /// 宋体（GB2312 字符集）；磅房的票不挑字体好看，挑"任何驱动都必有、字距稳"。
        /// 针式机上开反走样只会糊出一团灰，所以字体质量钉死为非反走样。
        fn font_for(&self, bold: bool, underline: bool, wide: u8, tall: u8) -> HFONT {
            let face = to_nul_wide("宋体");
            let tall = (tall as i32).clamp(1, 4);
            let wide = (wide as i32).clamp(1, 4);
            unsafe {
                CreateFontW(
                    -(self.em * tall),
                    if wide > 1 { self.em * wide } else { 0 },
                    0,
                    0,
                    if bold { FW_BOLD.0 as i32 } else { 400 },
                    0,
                    if underline { 1 } else { 0 },
                    0,
                    GB2312_CHARSET,
                    OUT_DEFAULT_PRECIS,
                    CLIP_DEFAULT_PRECIS,
                    NONANTIALIASED_QUALITY,
                    (DEFAULT_PITCH.0 | FF_MODERN.0) as u32,
                    PCWSTR(face.as_ptr()),
                )
            }
        }

        /// 二维码：前端不传位图，位图在这里现算（qrcode 纯 Rust），模块画实心方块。
        fn qr(&mut self, text: &str, qr_err: &mut Option<String>) {
            use qrcode::{Color, EcLevel, QrCode};
            let code = match QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M) {
                Ok(c) => c,
                Err(e) => {
                    if qr_err.is_none() {
                        *qr_err = Some(e.to_string());
                    }
                    return;
                }
            };
            let modules = code.width();
            if modules == 0 {
                return;
            }
            // 票面码 28mm 见方是"扫码枪在 20cm 外扫得动"的经验值；放不下就退到可打宽的一半
            let want = mm_px(28, self.dpi_y).min((self.right - self.left) / 2).max(8);
            let cell = (want / modules as i32).max(1);
            let side = cell * modules as i32;
            self.need(side + self.line_gap());
            let x0 = self.left + (self.right - self.left - side) / 2;
            let y0 = self.y;
            let colors = code.to_colors();
            unsafe {
                let black = GetStockObject(BLACK_BRUSH);
                let old = SelectObject(self.hdc, black);
                for (i, c) in colors.iter().enumerate() {
                    if matches!(c, Color::Dark) {
                        let cx = (i % modules) as i32;
                        let cy = (i / modules) as i32;
                        let _ = PatBlt(self.hdc, x0 + cx * cell, y0 + cy * cell, cell, cell, PATCOPY);
                    }
                }
                SelectObject(self.hdc, old);
            }
            self.y = y0 + side + self.line_gap();
        }
    }

    /* -------------------------------------------------------------- 工具 */

    /// UTF-16（不含终止符），给 `DrawTextW` 按长度传串用。
    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    /// UTF-16 + NUL，给 PCWSTR/PWSTR 用。
    fn to_nul_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 个别虚拟打印机报 dpi=0；300dpi 至少能让 StartDoc 走通而不是除零。
    fn safe_dpi(v: i32) -> i32 {
        if v > 0 {
            v
        } else {
            300
        }
    }

    /// 毫米 → 设备像素（按给定 dpi）。
    fn mm_px(mm: i32, dpi: i32) -> i32 {
        // mm·dpi/25.4 写成整数运算：×10/254，+127 即 0.5px 的四舍五入
        (mm * dpi * 10 + 127) / 254
    }

    /// 磅（pt）→ 设备像素：字号只有 DPI 一个换算分母（1pt = 1/72 英寸）。
    fn pt_px(pt: i32, dpi: i32) -> i32 {
        (pt * dpi + 36) / 72
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn millimetres_round_trip_through_dpi() {
            // 254mm @ 10dpi = 100px；25.4mm @ 300dpi ≈ 300px（各向都差不过半格）
            assert_eq!(mm_px(254, 10), 100);
            assert_eq!(mm_px(25, 300), 295);
            assert_eq!(mm_px(28, 600), 661);
            assert_eq!(mm_px(0, 300), 0);
        }

        #[test]
        fn points_convert_by_seventy_twoth_inch() {
            assert_eq!(pt_px(72, 300), 300); // 72pt = 1 英寸 = dpi 个像素
            assert_eq!(pt_px(12, 300), 50); // 小四在 300dpi 打印机上 50px
            assert_eq!(pt_px(12, 600), 100);
        }

        /// 真机冒烟：打一张最小样例票到**系统默认打印机**。
        /// 自动化环境不跑（`#[ignore]`）；磅房装机自检时手动执行，看驱动是否收下任务：
        /// `cargo test -p banghe --lib queue_print -- --ignored`
        #[test]
        #[ignore = "会真的往默认打印机提交任务，只在实机手动跑"]
        fn prints_a_sample_ticket_to_the_default_printer() {
            let lines = vec![
                PrintLine::Text {
                    text: "队列直打自检票".into(),
                    align: TextAlign::Center,
                    bold: true,
                    underline: false,
                    reverse: false,
                    wide: 2,
                    tall: 2,
                },
                PrintLine::Rule,
                PrintLine::Kv {
                    label: "单号".into(),
                    value: "QTEST-000001".into(),
                },
                PrintLine::Pair {
                    l1: "毛重".into(),
                    v1: "50,000 kg".into(),
                    l2: "皮重".into(),
                    v2: "20,000 kg".into(),
                },
                PrintLine::Qr {
                    text: "BH1:BD100120260912000001".into(),
                },
                PrintLine::Feed { n: 2 },
            ];
            let out = print_queue_blocking(ReceiptQueuePrintInput {
                lines,
                printer: None,
                copies: Some(1),
            });
            println!("→ {}: {:#?}", out.device, out);
            assert!(out.ok, "直打失败：{}", out.error.unwrap_or_default());
        }
    }
}

#[cfg(target_os = "windows")]
use imp::print_queue_blocking;
