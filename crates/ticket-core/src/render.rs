//! ESC/POS 票面排版。这里只写"往 Printer 里塞什么指令"，不碰设备与 IO，
//! 因此主程序、现场工装、以及以后可能的"导出字节流留档"共用同一份实现。

use std::borrow::Cow;

use escpos::driver::Driver;
use escpos::printer::Printer;
use escpos::printer_options::PrinterOptions;
use escpos::utils::{CashDrawer, Encoder, JustifyMode, Protocol, UnderlineMode};
use encoding_rs::GBK;

use crate::model::{Paper, PrintLine, TextAlign, WeighTicket};

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
    // 左对齐是整张票的恒定基准：文字行的对齐全靠空格补齐（见 `aligned`），
    // 全文只有 `qr` 会临时改 justify，且它自己负责复位。
    p.justify(JustifyMode::LEFT)?;
    Ok(())
}

/* --------------------------------------------------------- 字库与编码守卫 */

/// GBK 净化：打印机内置字库按 GBK 解释字节，而 `encoding_rs` 对 GBK 里根本没有的
/// 字符（典型是半角 `¥`，U+00A5）会**退化成 HTML 数字实体**——`¥` 变成 `&#165;`，
/// 六个 ASCII 字符原样印在票面上。
///
/// 所以票面文字出门前统一过一遍这里：能换等价字形的换（半角 `¥` → 全角 `￥`，
/// GBK 的 A1E3 有），换不到的退成 `?`。宁可缺一个字形，也不能在收据上印一串转义码。
///
/// 放在 Rust 侧的理由和折行一样——"这台机器的字库缺哪个码位"是机器的属性；
/// 前端只负责说"这里要印一笔金额"，不该去猜现场那台机有没有这个字。
fn gbk_safe(s: &str) -> Cow<'_, str> {
    // 快路径：整串都能编码就零拷贝返回（绝大多数行都是这种）
    if !GBK.encode(s).2 {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() + 4);
    for ch in s.chars() {
        let one = ch.to_string();
        if !GBK.encode(&one).2 {
            out.push(ch);
            continue;
        }
        match ch {
            '\u{00A5}' => out.push('\u{FFE5}'), // 半角人民币符号 → 全角（GBK 有）
            _ => out.push('?'),                 // 生僻字、特殊符号：宁可缺字不要转义码
        }
    }
    Cow::Owned(out)
}

/// 所有票面文字的唯一出口：写之前统一做 GBK 净化。
fn put<D: Driver>(p: &mut Printer<D>, s: &str) -> R<()> {
    p.write(&gbk_safe(s))?;
    Ok(())
}

/* ---------------------------------------------------------------- 排版原语 */

/// 单个字符占几列：CJK 与全角标点按 2 列算，其余按 1 列。
fn char_width(c: char) -> usize {
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
    let u = c as u32;
    if RANGES.iter().any(|&(a, b)| (a..=b).contains(&u)) {
        2
    } else {
        1
    }
}

/// 显示宽度：CJK 与全角标点按 2 列算，其余按 1 列。
pub fn display_width(s: &str) -> usize {
    s.chars().map(char_width).sum()
}

/// 按列宽折行。热敏纸只有 48 / 32 列，前端给的备注、地址这类长文本必须在这里折——
/// 不然打印机会按自己的规则硬折，票面就散了。折点落在字符边界上（汉字可以任意处断行）。
fn wrap(text: &str, cols: usize) -> Vec<String> {
    if cols == 0 {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut w = 0usize;
    for ch in text.chars() {
        let cw = char_width(ch);
        if w + cw > cols && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
            w = 0;
        }
        cur.push(ch);
        w += cw;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

/// 按 `align` 用**前导空格**把一行补到 `cols` 列。
///
/// 对齐不交给 `ESC a 1/2`：打印机的居中/右对齐按**它自己的可打宽度**算，而不是按我们
/// 排版的列数。80 机（48 列）装 58 纸、按 32 列排版时，`ESC a 2` 会把行尾推到第 48 列，
/// 整行右移 16 列 ≈ 24mm，直接掉到纸外——票面上就是"正文齐、金额和标题偏右"那种怪相。
/// 空格补齐的落点只取决于传进来的 `cols`，与机型头宽无关（`kv`/`pair` 本来就这么排）。
///
/// 宽窄余数落在右边（居中取左半边）。
fn aligned(text: &str, cols: usize, align: TextAlign) -> String {
    let blank = cols.saturating_sub(display_width(text));
    match align {
        // 左对齐不补尾：免得往字节流里塞无意义空白
        TextAlign::Left => text.to_string(),
        TextAlign::Right => format!("{}{}", " ".repeat(blank), text),
        TextAlign::Center => format!("{}{}", " ".repeat(blank / 2), text),
    }
}

fn line<D: Driver>(p: &mut Printer<D>, s: &str) -> R<()> {
    put(p, s)?;
    p.feed()?;
    Ok(())
}

/// 整行右对齐。折行先做在 Rust 侧——不然打印机把一长串右对齐文本折成几段，
/// 每段各贴右边，票面读不出是从哪儿连过来的。
///
/// 补齐走 `aligned` 的前导空格，不走 `ESC a 2`：理由见那里的注释。
fn right<D: Driver>(p: &mut Printer<D>, s: &str, cols: usize) -> R<()> {
    for seg in wrap(s, cols) {
        line(p, &aligned(&seg, cols, TextAlign::Right))?;
    }
    Ok(())
}

/// 分隔线：铺满一行。打出来若折行，说明纸的实际列数比这里声明的 `cols` 小。
pub fn rule<D: Driver>(p: &mut Printer<D>, cols: usize) -> R<()> {
    line(p, &"-".repeat(cols))
}

/// 列宽标尺：每 5 列一个 `+`，每 10 列打该十位的数字。拿在手里一眼读出实机列数——
/// 数到折行处前面有几个刻度，就是这台机器真正能打多少列。
pub fn ruler<D: Driver>(p: &mut Printer<D>, cols: usize) -> R<()> {
    let mut s = String::with_capacity(cols);
    for i in 1..=cols {
        s.push(if i % 10 == 0 {
            char::from_digit(((i / 10) % 10) as u32, 10).unwrap_or('|')
        } else if i % 5 == 0 {
            '+'
        } else {
            '-'
        });
    }
    line(p, &s)
}

/// 标签 + 右对齐数值（热敏票最常见的"项目 …… 数值"）。
///
/// 放不下时**不能**只留一个空格硬挤：那一行会超出实机列数，热敏机会在边界上自己折，
/// 票面立刻变成"标签一行、数值另起一行还带一长串空白"的破相——这正是"打印效果和
/// 预览不一样"最常见的成因。这里改成有意的两行式（标签一行、数值整行右对齐），
/// 破相就成了版式，而且实机是 24 列还是 48 列都读得通。
///
/// 宽度一律按**净化后**的串算：半角 `¥` 换成全角 `￥` 后一个字符占两列，折点会变。
pub fn kv<D: Driver>(p: &mut Printer<D>, label: &str, value: &str, cols: usize) -> R<()> {
    let label = gbk_safe(label);
    let value = gbk_safe(value);
    // 留一列余量：正好占满时，个别机型会把最后一个字挤到下一行去
    let need = display_width(&label) + display_width(&value);
    if need + 1 > cols {
        line(p, &label)?;
        return right(p, &value, cols);
    }
    put(p, &label)?;
    put(p, &" ".repeat(cols - need))?;
    line(p, &value)
}

/// 一行两组键值，常用于"水分/杂质"这类并列项。放不下时退化成两行 `kv`，不硬挤。
pub fn pair<D: Driver>(
    p: &mut Printer<D>,
    l1: &str,
    v1: &str,
    l2: &str,
    v2: &str,
    cols: usize,
) -> R<()> {
    let raw_a = format!("{l1} {v1}");
    let raw_b = format!("{l2} {v2}");
    let a = gbk_safe(&raw_a);
    let b = gbk_safe(&raw_b);
    let need = display_width(&a) + display_width(&b);
    if need + 1 > cols {
        kv(p, l1, v1, cols)?;
        return kv(p, l2, v2, cols);
    }
    put(p, &a)?;
    put(p, &" ".repeat(cols - need))?;
    line(p, &b)
}

/// 整行居中。同 `right`：补齐在 Rust 侧算，不交给 `ESC a 1`。
fn center<D: Driver>(p: &mut Printer<D>, text: &str, cols: usize) -> R<()> {
    line(p, &aligned(text, cols, TextAlign::Center))
}

/// 二维码。栅格图补不了空格（`GS ( k` 从当前位置起打），居中只能交给 `ESC a 1`——
/// 于是这是全文件唯一还按**机内可打宽度**对齐的地方：80 机（48 列）装 58 纸、票面按
/// 32 列排版时，码会落在第 24 列正中而非第 16 列，整体偏右约 8 列 ≈ 12mm。
/// 发完必须复位左对齐，否则这行 `ESC a 1` 会泄漏给后面的文字行。
fn qr<D: Driver>(p: &mut Printer<D>, text: &str) -> R<()> {
    p.justify(JustifyMode::CENTER)?;
    p.qrcode(text)?;
    p.feed()?;
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
        p.size(big.0, big.1)?;
        line(
            p,
            &aligned(
                if t.station_name.is_empty() {
                    "粮站过磅"
                } else {
                    t.station_name.as_str()
                },
                (cols / big.0 as usize).max(1),
                TextAlign::Center,
            ),
        )?;
        p.reset_size()?;
        p.size(1, 2)?;
        center(p, "过磅码单", cols)?;
        p.reset_size()?;

        if t.is_reprint {
            center(p, "【补打，已经站长授权】", cols)?;
        }
        if !t.copy_note.is_empty() {
            center(p, &t.copy_note, cols)?;
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
            center(p, &format!("({})", t.amount_upper), cols)?;
        }

        if !t.qr_text.is_empty() {
            rule(p, cols)?;
            qr(p, &t.qr_text)?;
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
            center(p, &t.footer_note, cols)?;
        }
        if !t.station_code.is_empty() {
            line(p, &aligned(&t.station_code, cols, TextAlign::Right))?;
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
    p.size(2, 2)?;
    line(p, &aligned("粮站过磅系统", cols / 2, TextAlign::Center))?;
    p.reset_size()?;
    center(p, "小票机 ESC/POS 自检", cols)?;
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
    center(p, "壹万伍仟肆佰陆拾肆元零贰分", cols)?;

    // 列宽自检：票面折行的头号原因是"声明的列数比实机大"。满格线和标尺一起看——
    // 哪一行折了、折在第几格，就是这台机器的真实列数，填回「小票机列数」即可。
    rule(p, cols)?;
    line(p, &format!("列宽基准 {cols} 列（汉字占 2 列）"))?;
    ruler(p, cols)?;
    line(p, "以上两行各应占满一行；折行即实机更窄")?;
    line(p, "把折行处的刻度数填进「小票机列数」")?;

    rule(p, cols)?;
    qr(p, "BANGHE-SELFTEST")?;
    center(p, "若本页字清晰即通道可用", cols)?;
    p.feeds(4)?;
    p.print_cut()?;
    Ok(())
}

/// 通用票面输出：照前端排好的行序列打一张。**自定义模板的唯一出口。**
///
/// 与 [`write_weigh_ticket`] 共用同一套排版原语（`kv` / `pair` / `rule` / 折行），
/// 所以"汉字占两列、栅格多少列"这些规则仍然只有一份实现——前端换模板换不出折行差异。
///
/// `cols` 由调用方定：默认是纸宽标称（[`Paper::cols`]），现场实测过就用 [`Paper::cols_with`]
/// 的结果。**票面折行几乎都是这个数比实机大**，所以它必须能从外面改。
///
/// `copies` 份数（0 按 1 份兜底，上限 6 份）；`open_drawer` 为真时在切纸**之前**弹钱箱
/// （与 [`write_weigh_ticket`] 同一处理：脉冲排在切刀后容易被刀口夹住）。
///
/// 行序列里没有切纸指令——每份打完统一走纸 3 行再切，票与票之间才不会粘连。
pub fn write_lines<D: Driver>(
    p: &mut Printer<D>,
    cols: usize,
    lines: &[PrintLine],
    copies: u8,
    open_drawer: bool,
) -> R<()> {
    let n = if copies == 0 { 1 } else { copies.min(6) };
    for _ in 0..n {
        begin(p)?;
        for l in lines {
            match l {
                PrintLine::Text {
                    text,
                    align,
                    bold,
                    underline,
                    reverse,
                    wide,
                    tall,
                } => {
                    // 字号先服从纸宽：倍宽行占的列是双倍，实机只有 24 列时 2 倍宽的站名
                    // 会把纸撑破、站名自己折成两行——比"字号小一点"难看得多。
                    // 折行预算再按压缩后的倍数折算，于是"净化过 + 压过字号 + 折过行"的
                    // 每一段都必然塞得进纸宽。
                    let text = gbk_safe(text);
                    let total = display_width(&text);
                    let want = (*wide).clamp(1, 8);
                    let scale = if total == 0 {
                        want
                    } else {
                        want.min((cols / total).clamp(1, 8) as u8)
                    };
                    p.size(scale, (*tall).clamp(1, 8))?;
                    p.bold(*bold)?;
                    p.underline(if *underline {
                        UnderlineMode::Single
                    } else {
                        UnderlineMode::None
                    })?;
                    p.reverse(*reverse)?;
                    // 折行在 Rust 侧做：前端只给一段文字，能不能放下由纸宽说了算。
                    // 对齐同样在 Rust 侧做：补齐预算按缩放后的列数算，一个补位空格
                    // 和正文一样是倍宽，于是 `unit * scale` 恰好还是纸宽。
                    let unit = (cols / scale as usize).max(1);
                    for seg in wrap(&text, unit) {
                        line(p, &aligned(&seg, unit, *align))?;
                    }
                    // 样式只作用于这一行：立刻复位，否则整票都会跟着变粗 / 变反白
                    p.reset_size()?;
                    p.bold(false)?;
                    p.underline(UnderlineMode::None)?;
                    p.reverse(false)?;
                }
                PrintLine::Kv { label, value } => kv(p, label, value, cols)?,
                PrintLine::Pair { l1, v1, l2, v2 } => pair(p, l1, v1, l2, v2, cols)?,
                PrintLine::Rule => rule(p, cols)?,
                // feeds 返回 &mut Printer，不返回 ()：不加大括号会让 match 各分支类型不一致
                PrintLine::Feed { n } => {
                    p.feeds((*n).clamp(1, 8))?;
                }
                PrintLine::Qr { text } => {
                    if !text.is_empty() {
                        qr(p, text)?;
                    }
                }
            }
        }
        p.feeds(3)?;
        if open_drawer {
            p.cash_drawer(CashDrawer::Pin2)?;
        }
        p.print_cut()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PrintLine, TextAlign};

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

    /// 折行必须按列宽断、且不丢字：热敏票上一旦折成两行，观感立刻变成"两张票"。
    #[test]
    fn wrap_breaks_on_column_budget() {
        // 汉字占 2 列：48 列放得下 24 个汉字
        let long = "周".repeat(30);
        let segs = wrap(&long, 48);
        assert_eq!(segs.len(), 2);
        assert_eq!(display_width(&segs[0]), 48);
        assert_eq!(segs.concat(), long, "折行不能丢字");
        // 已是空串也要回一行，否则这一行在纸上整个消失
        assert_eq!(wrap("", 48), vec![String::new()]);
        // 混排：ASCII 占 1 列，折点仍以列宽为准
        let mixed = "abcd".repeat(20); // 80 列
        assert_eq!(wrap(&mixed, 32).len(), 3);
    }

    /// 跨语言契约：前端 `receiptLines()` 排出来的行序列，Rust 必须原样收下。
    /// 覆盖每一个 variant（含 unit variant `rule`）——内部标签枚举最容易在这里出岔。
    #[test]
    fn print_line_json_contract() {
        let json = r#"[
            {"kind":"text","text":"滨河粮食收购站","align":"center","bold":true,"wide":2,"tall":2},
            {"kind":"kv","label":"单据号","value":"BD20260912-00317"},
            {"kind":"pair","l1":"水分","v1":"14.0 %","l2":"杂质","v2":"1.0 %"},
            {"kind":"rule"},
            {"kind":"feed","n":2},
            {"kind":"qr","text":"BANGHE-SELFTEST"}
        ]"#;
        let lines: Vec<PrintLine> = serde_json::from_str(json).expect("前端行序列必须能反序列化");
        assert_eq!(lines.len(), 6);
        match &lines[0] {
            // 缺省字段（underline / reverse）要走 serde default，不能报缺字段
            PrintLine::Text { text, align, bold, wide, tall, underline, reverse } => {
                assert_eq!(text, "滨河粮食收购站");
                assert_eq!(*align, TextAlign::Center);
                assert!(*bold);
                assert_eq!((*wide, *tall), (2, 2));
                assert!(!*underline && !*reverse);
            }
            other => panic!("第 0 行应为 Text，实际 {other:?}"),
        }
        assert!(matches!(lines[3], PrintLine::Rule));
        // 极简形态也要成立：只给 kind，其余全默认
        let bare: Vec<PrintLine> = serde_json::from_str(r#"[{"kind":"text","text":"x"}]"#).unwrap();
        match &bare[0] {
            PrintLine::Text { align, wide, tall, .. } => {
                assert_eq!(*align, TextAlign::Left);
                assert_eq!((*wide, *tall), (1, 1), "字号缺省必须是 1，0 会被 escpos 当非法尺寸");
            }
            other => panic!("应为 Text，实际 {other:?}"),
        }
    }

    /* ------------------------------------------- 字节流守卫（两次现场事故的回归） */

    /// 记录写入的假驱动：把真发给小票机的字节原样收下来。
    #[derive(Clone, Default)]
    struct Capture(std::rc::Rc<std::cell::RefCell<Vec<u8>>>);

    impl Driver for Capture {
        fn name(&self) -> String {
            "capture".to_string()
        }
        fn write(&self, data: &[u8]) -> R<()> {
            self.0.borrow_mut().extend_from_slice(data);
            Ok(())
        }
        fn read(&self, _buf: &mut [u8]) -> R<usize> {
            Ok(0)
        }
        fn flush(&self) -> R<()> {
            Ok(())
        }
    }

    /// 已知控制序列的字节数。只覆盖本 crate 会发的那几条，不求解析整个 ESC/POS
    /// （二维码那种带长度域的 `GS ( k` 不在覆盖范围内，测试票面里也别放）。
    fn ctrl_len(b: &[u8]) -> usize {
        match b {
            [0x1B, 0x40, ..] => 2,                // ESC @
            [0x1B, 0x32, ..] | [0x1B, 0x33, ..] => 2, // ESC 2 / ESC 3（行距）
            [0x1B, ..] => 3,                      // ESC a / E / - / d / !
            [0x1C, ..] => 2,                      // FS &
            [0x1D, ..] => 3,                      // GS ! / GS B / GS V
            _ => 1,
        }
    }

    /// 走一遍字节流，返回每一行的可见文字，以及该行生效的**字宽倍数**。
    /// 倍数必须跟着 `GS ! n` 走——倍宽行占的列是双倍，守卫得按物理宽度算；
    /// 顺带把"打完倍宽忘了复位"这类故障也一起守住。
    fn visible_lines(bytes: &[u8]) -> Vec<(String, usize)> {
        let mut out = Vec::new();
        let mut cur: Vec<u8> = Vec::new();
        let mut wide = 1usize;
        let mut i = 0usize;
        while i < bytes.len() {
            let b = bytes[i];
            if b == 0x0A {
                out.push((GBK.decode(&cur).0.into_owned(), wide));
                cur.clear();
                i += 1;
                continue;
            }
            // 走纸用的是 `ESC d n`（不是 0x0A）：它既是"打印当前行"也是换行，
            // 漏掉这条会一行都收不到——第一版守卫就栽在这里。
            if b == 0x1B && bytes.get(i + 1) == Some(&0x64) {
                for _ in 0..bytes.get(i + 2).copied().unwrap_or(1).max(1) {
                    out.push((GBK.decode(&cur).0.into_owned(), wide));
                    cur.clear();
                }
                i += 3;
                continue;
            }
            if b == 0x1D && bytes.get(i + 1) == Some(&0x21) {
                wide = ((bytes.get(i + 2).copied().unwrap_or(0) >> 4) & 0x07) as usize + 1;
                i += 3;
                continue;
            }
            if b == 0x1B || b == 0x1C || b == 0x1D {
                i += ctrl_len(&bytes[i..]);
                continue;
            }
            cur.push(b);
            i += 1;
        }
        out
    }

    /// 现场事故回归 ①：半角 `¥` 不在 GBK 里，编码器会把它退化成 `&#165;` 印在纸上。
    #[test]
    fn half_width_yuan_survives_the_gbk_font() {
        assert!(GBK.encode("\u{00A5}").2, "前提：半角 ¥ 确实不在 GBK 里");
        assert_eq!(gbk_safe("\u{00A5}122,133.40"), "\u{FFE5}122,133.40");
        assert!(!gbk_safe("货款 \u{00A5}1.00").contains("&#"));
        // 全角串不必再动（幂等）；纯中文走零拷贝快路径
        assert_eq!(gbk_safe("\u{FFE5}1.00"), "\u{FFE5}1.00");
        assert!(matches!(gbk_safe("毛重"), Cow::Borrowed(_)));
    }

    /// 票面实际用到的非汉字符号也必须落在 GBK 里——否则它们会被静默换成 `?`，
    /// 而这种缺失只有打出来才看得见。这条测试就是"哪些字形能上票"的清单。
    #[test]
    fn glyphs_used_on_tickets_are_in_gbk() {
        for s in [
            "＿＿＿＿＿＿", // escpos.ts 的署名栏空线（全角下划线 U+FF3F）
            "—",          // lib/format.ts 的空值占位 EMPTY（U+2014）
            "·",          // 车牌里的间隔号，如 浙A·8F2K6（U+00B7）
            "（过磅单）",   // 票据标题里的全角括号
            "￥",          // 金额用的全角人民币符号（半角 ¥ 换过来的那个）
        ] {
            assert!(!GBK.encode(s).2, "{s:?} 不在 GBK 里，打出来会变成 ?");
            assert_eq!(gbk_safe(s), s, "{s:?} 不该被 gbk_safe 改动");
        }
    }

    /// 现场事故回归 ②：一张票真正发出去的字节，每一行都必须塞得进实机列数。
    ///
    /// 溢出不会"自动截断"——热敏机会在边界上自己折，票面立刻变成"标签一行、
    /// 数值另起一行还带一长串空白"，也就是"打印效果和预览不一样"。
    #[test]
    fn emitted_bytes_never_overflow_the_grid() {
        let lines = vec![
            PrintLine::Text {
                text: "滨河粮食收购站".into(),
                align: TextAlign::Center,
                bold: true,
                underline: false,
                reverse: false,
                wide: 2,
                tall: 2,
            },
            PrintLine::Text {
                text: "收购码单（过磅单）".into(),
                align: TextAlign::Center,
                bold: true,
                underline: false,
                reverse: false,
                wide: 1,
                tall: 1,
            },
            PrintLine::Rule,
            PrintLine::Kv { label: "单号".into(), value: "BD20260912-00317".into() },
            // 净化后 ¥ 变全角占两列，宽度必须按净化后的串算
            PrintLine::Kv { label: "货款".into(), value: "\u{00A5}122,133.40".into() },
            PrintLine::Pair { l1: "水分".into(), v1: "14.00 %".into(), l2: "杂质".into(), v2: "1.00 %".into() },
            // 一行放不下：必须走"标签一行 + 数值右对齐一行"，而不是交给打印机硬折
            PrintLine::Kv { label: "身份证号(脱敏)".into(), value: "330184********4419".into() },
        ];

        // 三种真实配置：80 标称、58 标称、以及"实机比标称窄"（现场最常见的那种）
        for (paper, over) in [(Paper::P80, None), (Paper::P58, None), (Paper::P80, Some(24))] {
            let cols = paper.cols_with(over);
            let buf = Capture::default();
            let mut p = new_printer(buf.clone(), paper);
            write_lines(&mut p, cols, &lines, 1, false).expect("出票不应失败");

            let tag = format!("{paper:?}/{cols}列");
            let rendered = visible_lines(&buf.0.borrow());
            for (i, (l, wide)) in rendered.iter().enumerate() {
                let physical = display_width(l) * wide;
                assert!(
                    physical <= cols,
                    "{tag} 第 {i} 行物理宽 {physical} 超过 {cols} 列（字号 {wide} 倍）：{l:?}"
                );
                assert!(!l.contains("&#"), "{tag} 第 {i} 行印出了 HTML 数字实体：{l:?}");
            }

            // 满格线必须真的铺满，否则"列数"这件事根本没被验证
            assert!(
                rendered.iter().any(|(l, _)| l.len() == cols && l.chars().all(|c| c == '-')),
                "{tag} 未见 {cols} 个减号的满格线"
            );
            // 半角 ¥ 已换成打得出来的字形
            assert!(rendered.iter().any(|(l, _)| l.contains('\u{FFE5}')), "{tag} 金额未换成全角 ￥");

            // 放得下就排一行；放不下就走有意的两行式，而不是交给打印机硬折
            let label = "身份证号(脱敏)";
            let value = "330184********4419";
            if display_width(label) + display_width(value) + 1 > cols {
                assert!(rendered.iter().any(|(l, _)| l == label), "{tag} 长标签未单独成行");
                // 数值行现在带前导补齐空格（右对齐在 Rust 侧算），比较时去掉空白
                assert!(
                    rendered.iter().any(|(l, _)| l.trim() == value),
                    "{tag} 长数值未单独成行"
                );
            } else {
                assert!(
                    rendered.iter().any(|(l, _)| l.contains(label) && l.contains(value)),
                    "{tag} 放得下就该排成一行"
                );
            }
        }
    }

    /// 对齐回归（80 机装 58 纸）：居中/右对齐的落点必须按**票面列数**算。
    /// 交给 `ESC a 1/2` 的话，打印机会按自己的头宽对齐（80 机 = 48 列），
    /// 整行右移 16 列 ≈ 24mm 直接掉出 58 纸——票面上就是"正文齐、标题和金额偏右"。
    #[test]
    fn alignment_follows_the_layout_columns_not_the_head_width() {
        let json = r#"[
            {"kind":"text","text":"货款","align":"right"},
            {"kind":"text","text":"存根联","align":"center"},
            {"kind":"text","text":"滨河粮食收购站","align":"center","wide":2,"tall":2}
        ]"#;
        let lines: Vec<PrintLine> = serde_json::from_str(json).expect("前端行序列必须能反序列化");

        // 实机 80（头宽 48 列），票面按 58 纸的 32 列排
        let buf = Capture::default();
        let mut p = new_printer(buf.clone(), Paper::P80);
        write_lines(&mut p, 32, &lines, 1, false).expect("出票不应失败");
        let bytes = buf.0.borrow();

        // 文字行一律左对齐：整张票只允许 begin() 那一条 `ESC a 0`
        //（0x1B 既不是 GBK 的首字节也不是尾字节，不会和正文撞出假阳性）
        let delegated: Vec<u8> = bytes
            .windows(3)
            .filter(|w| w[0] == 0x1B && w[1] == 0x61 && w[2] != 0)
            .map(|w| w[2])
            .collect();
        assert!(delegated.is_empty(), "对齐仍交给了打印机的 ESC a {delegated:?}");

        let rendered = visible_lines(&bytes);
        let right = rendered.iter().find(|(l, _)| l.trim() == "货款").expect("右对齐行没打出来");
        assert_eq!(display_width(&right.0), 32, "右对齐应贴到票面第 32 列");

        let mid = rendered.iter().find(|(l, _)| l.trim() == "存根联").expect("居中行没打出来");
        assert_eq!(display_width(&mid.0), 6 + 13, "居中应补 13 列（余数落右边）");

        let head = rendered
            .iter()
            .find(|(l, _)| l.trim() == "滨河粮食收购站")
            .expect("倍宽站名没打出来");
        assert_eq!(head.1, 2, "站名应仍是 2 倍宽");
        // 补位空格和正文一样是倍宽：按缩放后的 16 列补 1 列 → 物理宽 15 × 2
        assert_eq!(display_width(&head.0) * head.1, 30, "倍宽行的补齐要按缩放后的列数算");
    }

    /// 实测列数必须真的改变排版：同一个"身份证号"行在 48 列放得下、在 24 列放不下。
    #[test]
    fn measured_columns_change_the_layout() {
        let label = "身份证号(脱敏)";
        let value = "330184********4419";
        let need = display_width(label) + display_width(value);
        assert!(need + 1 > 24, "前提：这一行在 24 列下确实放不下（need = {need}）");
        assert!(need + 1 <= 48, "前提：这一行在 48 列下放得下（need = {need}）");

        let cols = Paper::P80.cols_with(Some(24));
        assert_eq!(cols, 24);
        assert_eq!(Paper::P80.cols_with(None), 48, "不给实测值时仍按纸宽标称");
        assert_eq!(Paper::P58.cols_with(Some(8)), 32, "过小的实测值按误填处理，退回标称");

        let buf = Capture::default();
        let mut p = new_printer(buf.clone(), Paper::P80);
        write_lines(&mut p, cols, &[PrintLine::Kv { label: label.into(), value: value.into() }], 1, false)
            .unwrap();
        let rendered = visible_lines(&buf.0.borrow());
        assert!(
            rendered.iter().any(|(l, _)| l == label) && rendered.iter().any(|(l, _)| l.trim() == value),
            "24 列下应退化成两行式，实际 {rendered:?}"
        );
    }
}
