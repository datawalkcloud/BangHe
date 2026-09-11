//! ESC/POS 票面排版。这里只写"往 Printer 里塞什么指令"，不碰设备与 IO，
//! 因此主程序、现场工装、以及以后可能的"导出字节流留档"共用同一份实现。

use escpos::driver::Driver;
use escpos::printer::Printer;
use escpos::printer_options::PrinterOptions;
use escpos::utils::{CashDrawer, Encoder, JustifyMode, Protocol, UnderlineMode};
use encoding_rs::GBK;

use crate::model::{Paper, WeighTicket};

type R<T> = escpos::errors::Result<T>;

/// 进入中文模式：库本身不带汉字指令，靠打印机内置点阵字库按 GBK 解释双字节。
/// 现场实测（SPRT 80mm）这条不通就会打出乱码，是中文相关故障的第一排查点。
const FS_CN_ON: &[u8] = &[0x1C, 0x26];

/// 构造打印机对象：GBK 编码 + 按纸宽设定每行列数。
pub fn new_printer<D: Driver>(driver: D, paper: Paper) -> Printer<D> {
    let protocol = Protocol::new(Encoder::new(GBK).allow_unencodable(true));
    let options = PrinterOptions::new(None, None, paper.cols() as u8);
    Printer::new(driver, protocol, Some(options))
}

/// 每张票的起点：复位 + 中文模式 + 清掉上一张票残留的样式。
fn begin<D: Driver>(p: &mut Printer<D>) -> R<()> {
    p.init()?;
    p.custom(FS_CN_ON)?;
    p.reset_size()?;
    p.bold(false)?;
    p.underline(UnderlineMode::None)?;
    p.reverse(false)?;
    p.justify(JustifyMode::LEFT)?;
    Ok(())
}

/* ---------------------------------------------------------------- 排版原语 */

/// 显示宽度：CJK 与全角标点按 2 列算，其余按 1 列。
pub fn display_width(s: &str) -> usize {
    const RANGES: &[(u32, u32)] = &[
        (0x1100, 0x115F),
        (0x2E80, 0x32FF),
        (0x3400, 0x4DBF),
        (0x4E00, 0x9FFF),
        (0xA000, 0xA4CF),
        (0xAC00, 0xD7A3),
        (0xF900, 0xFAFF),
        (0xFE30, 0xFE6F),
        (0xFF00, 0xFF60),
        (0xFFE0, 0xFFE6),
    ];
    s.chars()
        .map(|c| {
            let u = c as u32;
            if RANGES.iter().any(|&(a, b)| (a..=b).contains(&u)) {
                2
            } else {
                1
            }
        })
        .sum()
}

fn line<D: Driver>(p: &mut Printer<D>, s: &str) -> R<()> {
    p.write(s)?;
    p.feed()?;
    Ok(())
}

/// 分隔线：铺满一行。打出来若折行，说明纸的实际列数比 `Paper::cols()` 小。
pub fn rule<D: Driver>(p: &mut Printer<D>, cols: usize) -> R<()> {
    line(p, &"-".repeat(cols))
}

/// 标签 + 右对齐数值。
pub fn kv<D: Driver>(p: &mut Printer<D>, label: &str, value: &str, cols: usize) -> R<()> {
    let pad = cols
        .saturating_sub(display_width(label) + display_width(value))
        .max(1);
    p.write(label)?;
    p.write(&" ".repeat(pad))?;
    line(p, value)
}

/// 一行两组键值，常用于"水分/杂质"这类并列项。
pub fn pair<D: Driver>(
    p: &mut Printer<D>,
    l1: &str,
    v1: &str,
    l2: &str,
    v2: &str,
    cols: usize,
) -> R<()> {
    let a = format!("{l1} {v1}");
    let b = format!("{l2} {v2}");
    let pad = cols
        .saturating_sub(display_width(&a) + display_width(&b))
        .max(1);
    p.write(&a)?;
    p.write(&" ".repeat(pad))?;
    line(p, &b)
}

fn center<D: Driver>(p: &mut Printer<D>, text: &str) -> R<()> {
    p.justify(JustifyMode::CENTER)?;
    line(p, text)?;
    p.justify(JustifyMode::LEFT)?;
    Ok(())
}

/* ---------------------------------------------------------------- 数字格式 */

fn group3(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let mut parts = Vec::new();
    while n > 0 {
        parts.push(format!("{:03}", n % 1000));
        n /= 1000;
    }
    let head = parts.pop().unwrap_or_default();
    let head = head.trim_start_matches('0');
    let mut out = head.to_string();
    for p in parts.into_iter().rev() {
        out.push(' ');
        out.push_str(&p);
    }
    out
}

/// 重量：0.1 kg 精度 + 千位空格分节（热敏纸没有可靠基线，分节比小数更影响判读）。
pub fn fmt_kg(v: f64) -> String {
    let tenths = (v * 10.0).round() as i64;
    let neg = tenths < 0;
    let a = tenths.unsigned_abs();
    let sign = if neg { "-" } else { "" };
    let whole = group3(a / 10);
    let d = a % 10;
    if d == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{d}")
    }
}

/// 金额：固定两位小数 + 千位分节。
pub fn fmt_money(v: f64) -> String {
    let cents = (v * 100.0).round() as i64;
    let neg = cents < 0;
    let a = cents.unsigned_abs();
    format!(
        "{sign}{yuan}.{jiao:02}",
        sign = if neg { "-" } else { "" },
        yuan = group3(a / 100),
        jiao = a % 100
    )
}

/// 单价：三位小数，粮站常见 2.860 元/kg 这种精度。
pub fn fmt_price(v: f64) -> String {
    let milli = (v * 1000.0).round() as i64;
    let neg = milli < 0;
    let a = milli.unsigned_abs();
    format!(
        "{sign}{yuan}.{rest:03}",
        sign = if neg { "-" } else { "" },
        yuan = a / 1000,
        rest = a % 1000
    )
}

/* ---------------------------------------------------------------- 票面 */

/// 过磅码单（热敏小票）。
pub fn write_weigh_ticket<D: Driver>(p: &mut Printer<D>, t: &WeighTicket) -> R<()> {
    let cols = t.paper.cols();
    let big = if cols >= 48 { (2, 2) } else { (1, 2) };

    for _ in 0..t.copies_or_default() {
        begin(p)?;
        p.justify(JustifyMode::CENTER)?;
        p.size(big.0, big.1)?;
        p.write(if t.station_name.is_empty() {
            "粮站过磅"
        } else {
            t.station_name.as_str()
        })?;
        p.feed()?;
        p.reset_size()?;
        p.size(1, 2)?;
        p.write("过磅码单")?;
        p.feed()?;
        p.reset_size()?;
        p.justify(JustifyMode::LEFT)?;

        if t.is_reprint {
            center(p, "【补打，已经站长授权】")?;
        }
        if !t.copy_note.is_empty() {
            center(p, &t.copy_note)?;
        }
        rule(p, cols)?;

        kv(p, "单号", &t.doc_no, cols)?;
        pair(p, "日期", &t.biz_date, "磅号", &t.scale_no, cols)?;
        if !t.farmer_name.is_empty() || !t.id_card_masked.is_empty() {
            pair(p, "售粮", &t.farmer_name, "证号", &t.id_card_masked, cols)?;
        }
        if !t.plate_no.is_empty() || !t.grain_name.is_empty() {
            let grain = if t.grade_name.is_empty() {
                t.grain_name.clone()
            } else {
                format!("{} {}", t.grain_name, t.grade_name)
            };
            pair(p, "车牌", &t.plate_no, "品种", &grain, cols)?;
        }

        rule(p, cols)?;
        kv(p, "毛重", &format!("{} kg", fmt_kg(t.gross_kg)), cols)?;
        kv(p, "皮重", &format!("{} kg", fmt_kg(t.tare_kg)), cols)?;
        kv(p, "净重", &format!("{} kg", fmt_kg(t.net_kg)), cols)?;
        if t.moisture.is_some() || t.impurity.is_some() {
            let m = t
                .moisture
                .map(|v| format!("{:.1}%", v))
                .unwrap_or_else(|| "-".into());
            let i = t
                .impurity
                .map(|v| format!("{:.1}%", v))
                .unwrap_or_else(|| "-".into());
            pair(p, "水分", &m, "杂质", &i, cols)?;
        }
        kv(p, "扣量", &format!("{} kg", fmt_kg(t.deduct_kg)), cols)?;
        p.bold(true)?;
        kv(p, "结算净重", &format!("{} kg", fmt_kg(t.settle_net_kg)), cols)?;
        p.bold(false)?;

        rule(p, cols)?;
        kv(p, "单价", &format!("{} 元/kg", fmt_price(t.unit_price)), cols)?;
        p.size(1, 2)?;
        kv(p, "金额", &format!("{} 元", fmt_money(t.amount)), cols)?;
        p.reset_size()?;
        if !t.amount_upper.is_empty() {
            center(p, &format!("({})", t.amount_upper))?;
        }

        if !t.qr_text.is_empty() {
            rule(p, cols)?;
            p.justify(JustifyMode::CENTER)?;
            p.qrcode(&t.qr_text)?;
            p.feed()?;
            p.justify(JustifyMode::LEFT)?;
        }

        rule(p, cols)?;
        if !t.weigher.is_empty() || !t.qc_by.is_empty() {
            pair(p, "磅员", &t.weigher, "化验", &t.qc_by, cols)?;
        }
        if !t.cashier.is_empty() {
            kv(p, "结算", &t.cashier, cols)?;
        }
        if !t.print_time.is_empty() {
            kv(p, "打印", &t.print_time, cols)?;
        }
        if !t.footer_note.is_empty() {
            center(p, &t.footer_note)?;
        }
        if !t.station_code.is_empty() {
            p.justify(JustifyMode::RIGHT)?;
            p.write(&t.station_code)?;
            p.feed()?;
            p.justify(JustifyMode::LEFT)?;
        }

        p.feeds(3)?;
        if t.open_drawer {
            // 钱箱脉冲放在切票前，避免切刀夹纸
            p.cash_drawer(CashDrawer::Pin2)?;
        }
        p.print_cut()?;
    }
    Ok(())
}

/// 设备自检票：与现场工装同一份代码，一次判读"通道 / 中文字库 / 栅格列数 / 切刀"四件事。
pub fn write_self_test<D: Driver>(p: &mut Printer<D>, paper: Paper, device_label: &str) -> R<()> {
    let cols = paper.cols();
    begin(p)?;
    p.justify(JustifyMode::CENTER)?;
    p.size(2, 2)?;
    p.write("粮站过磅系统")?;
    p.feed()?;
    p.reset_size()?;
    center(p, "小票机 ESC/POS 自检")?;
    rule(p, cols)?;

    kv(p, "设备", device_label, cols)?;
    kv(p, "纸宽", paper.label(), cols)?;
    kv(p, "栅格", &format!("{cols} 列/行"), cols)?;
    rule(p, cols)?;

    line(p, "ASCII  !\"#$%&'()*+,-./0123456789:;<=>?@A-Z")?;
    p.bold(true)?;
    line(p, "加粗 Emphasis BOLD")?;
    p.bold(false)?;
    p.underline(UnderlineMode::Single)?;
    line(p, "下划线 Underline")?;
    p.underline(UnderlineMode::None)?;
    p.reverse(true)?;
    line(p, "反白 Inverse")?;
    p.reverse(false)?;

    line(p, "字号 1x1 常规")?;
    p.size(2, 1)?;
    line(p, "字号 2x1 倍宽")?;
    p.size(1, 2)?;
    line(p, "字号 1x2 倍高")?;
    p.size(2, 2)?;
    line(p, "字号 2x2 倍宽倍高")?;
    p.reset_size()?;

    rule(p, cols)?;
    line(p, "中文点阵与对齐实测")?;
    kv(p, "毛重", &format!("{} kg", fmt_kg(12345.0)), cols)?;
    kv(p, "皮重", &format!("{} kg", fmt_kg(6165.0)), cols)?;
    kv(p, "净重", &format!("{} kg", fmt_kg(6180.0)), cols)?;
    pair(
        p,
        "水分",
        "12.5 %",
        "扣量",
        &format!("{} kg", fmt_kg(773.0)),
        cols,
    )?;
    kv(p, "金额", &format!("{} 元", fmt_money(15464.02)), cols)?;
    center(p, "壹万伍仟肆佰陆拾肆元零贰分")?;

    rule(p, cols)?;
    p.justify(JustifyMode::CENTER)?;
    p.qrcode("BANGHE-SELFTEST")?;
    p.feed()?;
    center(p, "若本页字清晰即通道可用")?;
    p.feeds(4)?;
    p.print_cut()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_width_counts_cjk_as_two() {
        assert_eq!(display_width("粮站"), 4);
        assert_eq!(display_width("kg"), 2);
        assert_eq!(display_width("粮站kg"), 6);
        assert_eq!(display_width("（全角"), 6);
    }

    #[test]
    fn weight_and_money_are_grouped() {
        assert_eq!(fmt_kg(12345.0), "12 345");
        assert_eq!(fmt_kg(6180.5), "6 180.5");
        assert_eq!(fmt_kg(0.0), "0");
        assert_eq!(fmt_kg(999.0), "999");
        assert_eq!(fmt_kg(1000.0), "1 000");
        assert_eq!(fmt_kg(-250.0), "-250");
        assert_eq!(fmt_money(15464.02), "15 464.02");
        assert_eq!(fmt_money(0.5), "0.50");
        assert_eq!(fmt_money(1234567.89), "1 234 567.89");
        assert_eq!(fmt_price(2.86), "2.860");
    }

    /// 栅格守卫：热敏纸一折行就变成两张票面，票面上每一行都必须留得下间隙。
    #[test]
    fn ticket_lines_fit_the_grid() {
        let cols = Paper::P80.cols();
        let heavy = kv_width("结算净重", &format!("{} kg", fmt_kg(999999.9)));
        assert!(heavy + 1 <= cols, "最重的结算净重行也要留空格: {heavy}");
        let money = kv_width("金额", &format!("{} 元", fmt_money(999999.99)));
        assert!(money + 1 <= cols);
        let both = display_width(&format!("日期 {}", "2026-09-11"))
            + display_width(&format!("磅号 {}", "1#"));
        assert!(both + 1 <= cols);
    }

    fn kv_width(l: &str, v: &str) -> usize {
        display_width(l) + display_width(v)
    }
}
