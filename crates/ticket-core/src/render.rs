//! ESC/POS 票面排版。这里只写"往 Printer 里塞什么指令"，不碰设备与 IO，
//! 因此主程序、现场工装、以及以后可能的"导出字节流留档"共用同一份实现。

use std::borrow::Cow;

use escpos::driver::Driver;
use escpos::printer::Printer;
use escpos::printer_options::PrinterOptions;
use escpos::utils::{
    CashDrawer, Encoder, JustifyMode, Protocol, QRCodeCorrectionLevel, QRCodeModel, QRCodeOption, UnderlineMode,
};
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
    // 左对齐是整张票的恒定基准：**没有任何一行靠 `ESC a` 对齐**——文字行用前导空格补齐
    // （见 `aligned`），两种码行用前端算好的 `pad_left`（见 `barcode` / `qr`）。
    // 理由只有一个：固件的居中是按机身头宽算的，而票要落在**这卷纸**上。
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

/// 单个字符在票面上占几列。
///
/// 判据**不手写码表**，直接问 GBK：编出来是双字节的就是全角（2 列），其余 1 列。
///
/// 手写区段表必然漏——`—`(U+2014)、`…`(U+2026)、`“”`、`·` 这些全角标点在 Unicode 里落在
/// General Punctuation / Latin-1 补充段，不属于任何 CJK 区段，但在 GBK 里占两个字节、
/// 打印机一律按全角画。按 1 列算的后果是 `kv` / `pair` 少算一列：行尾正好顶到纸宽，
/// 热敏机在边界上自己硬折，数值被甩到下一行单独打——"皮重净重为空时打了横杠，
/// 横杠换行单独打印"就是这么来的（有数值时全是 ASCII，算得对，所以只有空值才犯）。
///
/// 与 `gbk_safe` 同一口径：编不出的字符出门前已经是 `?`（1 列），半角 `¥` 已经是
/// 全角 `￥`（2 列）。按"净化后的结果"计宽，折点才不会和纸上错位。
fn char_width(c: char) -> usize {
    if c == '\u{00A5}' {
        return 2; // 出门前换成全角 ￥（见 gbk_safe）
    }
    let mut buf = [0u8; 4];
    let (bytes, _, unmappable) = GBK.encode(c.encode_utf8(&mut buf));
    if unmappable || bytes.len() < 2 {
        1
    } else {
        2
    }
}

/// 显示宽度：GBK 双字节字形（CJK 与全角标点）按 2 列，其余按 1 列。判据见 `char_width`。
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

/// 二维码缺省模块尺寸（点）：与 escpos 的 `QRCodeOption::default().size()` 同值。
/// 写死版式的老码单与自检票走这一档，行为与引入尺寸参数之前完全一致。
const QR_DEFAULT_SIZE: u8 = 4;

/// 字体 A 里一个半角字符的前进宽度（点）：203dpi 下标准的 12 点/字符。
///
/// 二维码的横向落点只能靠它来推：`GS ( k` 从**当前位置**起排点，补不了栅格，
/// 唯一能把它推到别处的手段就是先打几个空格。`ESC a 1` 不行——那是按机身的头宽居中，
/// 装 58 卷的 80 机会把码推出纸外（与 `barcode` 同一个坑，见那里的说明）。
const HALF_COL_DOTS: usize = 12;

/// 二维码。`pad_left` 是前端按纸算好的左侧空点（见 `code-size.ts::codeOffsetDots`），
/// 这里换算成空格：**向下取整**，宁可偏左一个字符，也不能因为取整把它推出纸面。
/// 量化误差最多 11 点（1.4mm），对"和条码对齐"这件事看不出来。
///
/// **`pad_left` 只能由算得出二维码点宽的那一侧给。** 这一侧算不出来：`escpos` 的
/// `qrcode_option` 只把载荷发出去（`escpos::domain::codes::qrcode` 里连编码器都没有），
/// 版本是**固件**按自己的容量表和字符集挑的，于是点宽随机器而变。模板票那边由前端
/// `QrGraphic.tsx::qrSideDots`（`qrcode` 库，纠错 H，与固件同档）算出落点传进来；
/// 写死版式的两张老票（[`write_weigh_ticket`] / [`write_self_test`]）没有这个来源，
/// 一律传 **0**：贴可打区左端起排，宁可偏左，绝不推出纸面。
///
/// `size` 是模板里那一档尺寸换算成的点数。**纠错等级钉死 H**：前端画预览用的也是 H
/// （见 `QrGraphic.tsx`），等级不同会让两边挑到不同的 QR 版本，模块数一变，
/// "预览里多大、纸上多大"就成了一句空话。
fn qr<D: Driver>(p: &mut Printer<D>, text: &str, size: u8, pad_left: u16) -> R<()> {
    let cols = pad_left as usize / HALF_COL_DOTS;
    if cols > 0 {
        put(p, &" ".repeat(cols))?;
    }
    p.qrcode_option(
        text,
        QRCodeOption::new(QRCodeModel::Model1, size.clamp(1, 16), QRCodeCorrectionLevel::H),
    )?;
    p.feed()?;
    Ok(())
}

/// 一维条码：把前端 `code128.ts` 算好的条空模块序列排成 `GS v 0` 栅格打出去。
///
/// 为什么不在这里编码：见 [`crate::model::PrintLine::Barcode`]——CODE128 不在 ESC/POS
/// 功能 A 支持的码制里，让固件自己编码又会让纸比预览窄。这里只按 `runs` 排点，
/// 于是屏幕上的条空与纸上的条空是同一个数组。
///
/// 每一行都一样，所以只算一行再重复 `height` 次。
///
/// **段宽按总宽分，不按"每模块几点"乘**：纸窄的时候前端压出来的模块宽度是小数
/// （58 纸上常见 1.52 点/模块），而栅格只认整数点。若在这里各自取整，要么整条缩回
/// 纸的一半，要么顶出纸外——所以前端把小数折进总宽 `width`，这里按累计模块数把
/// 总宽分摊到每一段（`round(累计模块 × 总宽 ÷ 总模块)`），保证：
///   - 整条宽度**恰好**是 `width` 个点（误差 0，因为最后一段取到边）；
///   - 每一段至少 1 个点（`width` ≥ 总模块数，前端已保证），不会有条被抹掉。
/// 分摊出来的段宽会有 1 点的抖动，这是任何栅格化都有的，扫码枪按相对宽度解码，读得动。
///
/// **横向落点自己补**：`pad_left` 个空点补在栅格左边，然后**左对齐**发出去。
/// 从前这里走 `ESC a 1` 让固件居中，而固件是按机身头宽居中的——80 机装 58 卷时它仍按
/// 576 点（72mm）居中，48mm 宽的条码落在 12~60mm，纸只有 58mm，右端连着停止符一起
/// 被切在纸外：票看着打出来了，扫码枪读不出来。落点由知道纸宽的前端算（`code-size.ts`
/// 的 `codeOffsetDots`），这里只照点排。
fn barcode<D: Driver>(p: &mut Printer<D>, runs: &[u8], width: u16, height: u8, pad_left: u16) -> R<()> {
    let total: usize = runs.iter().map(|&w| w as usize).sum();
    let body = (width as usize).max(total); // 至少每段 1 点，否则会有条被抹平
    let height = (height as usize).clamp(1, 255);
    let pad = pad_left as usize;
    if total == 0 {
        return Ok(());
    }
    let row_dots = pad + body;
    let row_bytes = (row_dots + 7) / 8;
    let mut row = vec![0u8; row_bytes];
    // 从 pad 处开始排：左边那一段保持 0（白），就是落点
    let mut x = pad;
    let mut cum = 0usize; // 已走过的模块数
    for (i, &w) in runs.iter().enumerate() {
        cum += w as usize;
        // 这一段的右沿（点）：按累计模块数分摊总宽，四舍五入
        let edge = pad + (cum * body + total / 2) / total;
        let n = edge.saturating_sub(x);
        if i % 2 == 0 {
            // 偶数个元素是"条"：点亮这一段里的每一个点（MSB 在左，与 GS v 0 一致）
            for _ in 0..n {
                row[x / 8] |= 0x80 >> (x % 8);
                x += 1;
            }
        }
        x = edge;
    }
    let mut cmd: Vec<u8> = vec![
        0x1D, 0x76, 0x30, 0x00, // GS v 0，模式 0 = 正常密度
        (row_bytes & 0xFF) as u8,
        ((row_bytes >> 8) & 0xFF) as u8,
        (height & 0xFF) as u8,
        ((height >> 8) & 0xFF) as u8,
    ];
    for _ in 0..height {
        cmd.extend_from_slice(&row);
    }
    p.custom(&cmd)?;
    p.feed()?;
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
            // 写死版式的老码单没有前端算好的落点：按 `pad_left` 的缺省口径贴左端起排
            // （与 `PrintLine::Barcode/Qr` 不带这个字段时同一条路）。要居中得由调用方按纸宽算。
            qr(p, &t.qr_text, QR_DEFAULT_SIZE, 0)?;
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
    // 自检票同样走缺省落点（贴左端起排）：这一页是给装纸/列宽的对位用的，
    // 码在不在正中无关紧要，能不能完整落在纸上才是要害（见 `qr` 的说明）。
    qr(p, "BANGHE-SELFTEST", QR_DEFAULT_SIZE, 0)?;
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
                PrintLine::Qr { text, size, pad_left } => {
                    if !text.is_empty() {
                        qr(p, text, *size, *pad_left)?;
                    }
                }
                PrintLine::Barcode { runs, width, height, pad_left } => {
                    barcode(p, runs, *width, *height, *pad_left)?
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
    use crate::model::{PrintLine, TextAlign, WeighTicket};

    #[test]
    fn display_width_counts_cjk_as_two() {
        assert_eq!(display_width("粮站"), 4);
        assert_eq!(display_width("kg"), 2);
        assert_eq!(display_width("粮站kg"), 6);
        assert_eq!(display_width("（全角"), 6);
    }

    /// 全角标点回归：`—` `…` `“”` `·` 在 Unicode 里**不在**任何 CJK 区段（落在
    /// General Punctuation / Latin-1 补充段），但在 GBK 里是双字节、打印机按全角画。
    /// 手写区段表会按 1 列算它们——这条测试就是那张表已经被换掉的依据。
    #[test]
    fn gbk_full_width_punctuation_is_two_columns() {
        for c in ['—', '…', '“', '”', '·'] {
            assert!(!GBK.encode(&c.to_string()).2, "前提：{c:?} 在 GBK 里");
            assert_eq!(
                display_width(&c.to_string()),
                2,
                "{c:?} 在 GBK 里是双字节，票面上占两列"
            );
        }
        // 纯 ASCII 的数值不受影响：有数值的行一列都不会挪
        assert_eq!(display_width("1 234.5 kg"), 10);
        assert_eq!(display_width("— kg"), 5);
    }

    /// 现场事故回归：空值打成横杠时，横杠必须留在标签那一行的行尾。
    ///
    /// 少算一列 → 行尾顶到纸宽 → 热敏机在边界上硬折 → 横杠另起一行单独打，
    /// 票面看起来就是"皮重"下面孤零零一个横杠。溢出不会截断，只会折行，所以这里
    /// 钉的是**发出去的字节里到底有几行**。
    #[test]
    fn an_empty_value_stays_at_the_end_of_its_row() {
        for paper in [Paper::P58, Paper::P80] {
            let buf = Capture::default();
            let mut p = new_printer(buf.clone(), paper);
            let lines = vec![
                PrintLine::Kv { label: "皮重".into(), value: "—".into() },
                PrintLine::Kv { label: "净重".into(), value: "—".into() },
            ];
            write_lines(&mut p, paper.cols(), &lines, 1, false).expect("kv 行不应失败");
            let bytes = buf.0.borrow();
            let rows: Vec<(String, usize)> = visible_lines(&bytes)
                .into_iter()
                .filter(|(l, _)| l.contains('皮') || l.contains('净'))
                .collect();
            assert_eq!(
                rows.len(),
                2,
                "{paper:?}：皮重/净重各占一行，横杠不该被折到下一行——实际 {rows:?}"
            );
            for (l, wide) in &rows {
                // 基准用 physical_cols（数 GBK 字节），不用 display_width：
                // 这次的 bug 正是 display_width 少算一列，用它自己当基准会自洽地通过
                assert_eq!(
                    physical_cols(l) * wide,
                    paper.cols(),
                    "{paper:?}：行宽要正好是纸的列数，多一列就会被机器硬折——实际 {l:?}"
                );
                assert!(l.trim_end().ends_with('—'), "{paper:?}：横杠应留在行尾——实际 {l:?}");
            }
        }
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
            {"kind":"qr","text":"BANGHE-SELFTEST","size":6},
            {"kind":"qr","text":"BH1:BD20260912000031"},
            {"kind":"barcode","runs":[2,2,2,2,2,1,4,4,4,4,4,1],"width":96,"height":96},
            {"kind":"barcode","runs":[2,2,2,2,2,1,4,4,4,4,4,1],"width":96,"height":96,"pad_left":40}
        ]"#;
        let lines: Vec<PrintLine> = serde_json::from_str(json).expect("前端行序列必须能反序列化");
        assert_eq!(lines.len(), 9);
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
        // 尺寸档位是前端换算好送上来的（见 code-size.ts），Rust 只负责照发
        match (&lines[5], &lines[6]) {
            (PrintLine::Qr { size: big, .. }, PrintLine::Qr { size: def, .. }) => {
                assert_eq!(*big, 6);
                assert_eq!(
                    *def, 4,
                    "不带 size 的老调用必须落回机器出厂的 4 点，不能悄悄变大"
                );
            }
            other => panic!("第 5/6 行应为 Qr，实际 {other:?}"),
        }
        match &lines[7] {
            PrintLine::Barcode { runs, width, height, pad_left } => {
                assert_eq!(runs.as_slice(), &[2, 2, 2, 2, 2, 1, 4, 4, 4, 4, 4, 1]);
                assert_eq!((*width, *height), (96, 96));
                assert_eq!(*pad_left, 0, "不带 pad_left 的老调用必须落回贴左端起排");
            }
            other => panic!("第 7 行应为 Barcode，实际 {other:?}"),
        }
        match &lines[8] {
            PrintLine::Barcode { pad_left, .. } => assert_eq!(*pad_left, 40),
            other => panic!("第 8 行应为带落点的 Barcode，实际 {other:?}"),
        }
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

    /// 一维条码的栅格：条空序列 × 模块点数 → `GS v 0` 点阵，MSB 在左。
    ///
    /// 这条测试钉的是"纸上那些条到底画在哪"：位序反了、或者行宽少算一字节，
    /// 打出来就是一根根错位糊在一起的废码，而它在预览里完全看不出来。
    #[test]
    fn barcode_emits_a_left_aligned_msb_raster() {
        let lines = vec![PrintLine::Barcode {
            runs: vec![2, 1, 2, 1], // 条2 空1 条2 空1 = 6 模块
            width: 12,              // 6 模块 × 2 点 → 每行 2 字节
            height: 3,
            pad_left: 0,            // 贴左端起排
        }];
        let buf = Capture::default();
        let mut p = new_printer(buf.clone(), Paper::P80);
        write_lines(&mut p, Paper::P80.cols(), &lines, 1, false).expect("条码行不应失败");
        let bytes = buf.0.borrow();

        let head = bytes.windows(8).position(|w| w == [0x1D, 0x76, 0x30, 0x00, 2, 0, 3, 0]);
        assert!(head.is_some(), "未找到 GS v 0 头（xL=2 字节/行，yL=3 行）：{bytes:02X?}");
        let data = &bytes[head.unwrap() + 8..];
        // 点 0-3 黑、4-5 白、6-9 黑、10-11 白 → 1111 0011 | 1100 0000
        assert_eq!(
            &data[..6],
            &[0xF3, 0xC0, 0xF3, 0xC0, 0xF3, 0xC0],
            "点阵必须每行都一样、且黑位在左"
        );
        // `begin` 那次复位之后，整张票不许再出现任何 `ESC a`——尤其 `ESC a 1`（固件居中）。
        // 固件是按**机身头宽**对齐的：80 机装 58 卷时它把 48mm 宽的条码推到 12~60mm，
        // 右端连着停止符一起出纸外。对齐一律自己算（文字补空格、码补 pad_left）。
        assert!(
            !bytes.windows(3).skip(2).any(|w| w == [0x1B, 0x61, 0x01]),
            "整张票不得把对齐交回固件：{bytes:02X?}"
        );
    }

    /// 落点：`pad_left` 个空点补在栅格左边，机器照点排就落在纸上那个位置。
    ///
    /// 这条钉的是"80 机装 58 卷"那类装态——不在纸上画出来，谁都不知道它跑哪儿去了。
    #[test]
    fn barcode_starts_at_the_pad_left_the_frontend_computed() {
        let lines = vec![PrintLine::Barcode {
            runs: vec![2, 1, 2, 1], // 6 模块
            width: 12,              // 12 点宽
            height: 2,
            pad_left: 8,            // 左边先空 8 点 → 每行 20 点 → 3 字节
        }];
        let buf = Capture::default();
        let mut p = new_printer(buf.clone(), Paper::P80);
        write_lines(&mut p, Paper::P80.cols(), &lines, 1, false).expect("条码行不应失败");
        let bytes = buf.0.borrow();

        let head = bytes.windows(8).position(|w| w == [0x1D, 0x76, 0x30, 0x00, 3, 0, 2, 0]);
        assert!(head.is_some(), "行宽必须把空点算进去（xL=3 字节）：{bytes:02X?}");
        let data = &bytes[head.unwrap() + 8..];
        // 空 8 点 → 0x00；条 4 点 + 空 2 点 → 1111 0011 = 0xF3；条 4 点 + 尾 4 位 → 1100 0000 = 0xC0
        assert_eq!(
            &data[..6],
            &[0x00, 0xF3, 0xC0, 0x00, 0xF3, 0xC0],
            "条必须整段右移 8 点，不是被压扁"
        );
    }

    /// 总宽不是模块数的整数倍时（纸窄，前端按实数压过模块宽度），按累计模块数分摊。
    ///
    /// 这一条钉的是"58 纸上条码只占半张纸"那个坑的另一半：光能压还不够，压出来的小数
    /// 必须真的落到纸上——分摊完的整条宽度要**分毫不差**等于前端给的总宽，多一个点就
    /// 可能顶出纸外，少一段就是缴掉的纸宽。
    #[test]
    fn barcode_shares_an_awkward_width_across_the_runs() {
        let lines = vec![PrintLine::Barcode {
            runs: vec![2, 1, 2, 1], // 6 模块，总宽 11 点 → 折合 1.83 点/模块
            width: 11,
            height: 2,
            pad_left: 0,
        }];
        let buf = Capture::default();
        let mut p = new_printer(buf.clone(), Paper::P80);
        write_lines(&mut p, Paper::P80.cols(), &lines, 1, false).expect("条码行不应失败");
        let bytes = buf.0.borrow();

        // 11 点宽 → 每行仍是 2 字节（不是按 12 点算出的 2 字节碰巧一样，是 11 就该是 2）
        let head = bytes.windows(8).position(|w| w == [0x1D, 0x76, 0x30, 0x00, 2, 0, 2, 0]);
        assert!(head.is_some(), "未找到 GS v 0 头（xL=2 字节/行）：{bytes:02X?}");
        let data = &bytes[head.unwrap() + 8..];
        // 分摊：4 点黑 | 2 白 | 3 点黑 | 2 白（合计 11）→ 1111 0011 | 1000 0000
        assert_eq!(
            &data[..4],
            &[0xF3, 0x80, 0xF3, 0x80],
            "段宽要按 4/2/3/2 分摊，整条正好 11 点：{data:02X?}"
        );
    }

    /// 二维码的落点只能靠空格推（`GS ( k` 从当前位置起排点），换算必须向下取整：
    /// 宁可偏左一个字符，也不能因为取整把码推出纸面。
    #[test]
    fn qr_pad_becomes_half_width_spaces() {
        let lines = vec![PrintLine::Qr {
            text: "BH1:BD20260912000031".into(),
            size: 4,
            pad_left: 36, // 36 / 12 = 3 个半角空格
        }];
        let buf = Capture::default();
        let mut p = new_printer(buf.clone(), Paper::P80);
        write_lines(&mut p, Paper::P80.cols(), &lines, 1, false).expect("二维码行不应失败");
        let bytes = buf.0.borrow();
        assert!(
            bytes.windows(6).any(|w| w == [0x20, 0x20, 0x20, 0x1D, 0x28, 0x6B]),
            "三个空格后必须紧跟 GS ( k：{bytes:02X?}"
        );
        // 取不满一格就丢掉（36 → 3 格是对的；再多 11 点仍是 3 格，绝不进位到 4）
        let lines = vec![PrintLine::Qr { text: "X".into(), size: 4, pad_left: 47 }];
        let buf2 = Capture::default();
        let mut p2 = new_printer(buf2.clone(), Paper::P80);
        write_lines(&mut p2, Paper::P80.cols(), &lines, 1, false).expect("二维码行不应失败");
        let bytes2 = buf2.0.borrow();
        assert!(
            !bytes2.windows(6).any(|w| w == [0x20, 0x20, 0x20, 0x20, 0x1D, 0x28]),
            "47 点只能推 3 格，不许进位：{bytes2:02X?}"
        );
    }

    /// 已知控制序列的字节数。只覆盖本 crate 会发的那几条，不求解析整个 ESC/POS
    /// （带长度域的序列不在覆盖范围内——二维码的 `GS ( k`、条码的 `GS v 0` 都是，
    /// 往 `visible_lines` 的测试票面里放这种行，解析结果不作数）。
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

    /// **独立口径**的行宽：直接数 GBK 字节——单字节 1 列、双字节 2 列。
    ///
    /// 断言行宽必须用这个，不能用 `display_width`：`display_width` 就是被测的那个函数，
    /// 它算错了会连断言一起错，测试自洽地通过，坑还在（第一版守卫就是这个下场）。
    /// 字节长度不受任何宽度表影响——GBK 里一个字符占几个字节，打印机就画几列。
    fn physical_cols(s: &str) -> usize {
        let (bytes, _, _) = GBK.encode(s);
        let mut cols = 0usize;
        let mut i = 0usize;
        while i < bytes.len() {
            if bytes[i] < 0x80 {
                cols += 1;
                i += 1;
            } else {
                cols += 2; // 双字节字形，打印机按全角画
                i += 2;
            }
        }
        cols
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
                // 用独立口径（数 GBK 字节），不用 display_width——那是被测函数自己
                let physical = physical_cols(l) * wide;
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
        assert_eq!(physical_cols(&right.0), 32, "右对齐应贴到票面第 32 列");

        let mid = rendered.iter().find(|(l, _)| l.trim() == "存根联").expect("居中行没打出来");
        assert_eq!(physical_cols(&mid.0), 6 + 13, "居中应补 13 列（余数落右边）");

        let head = rendered
            .iter()
            .find(|(l, _)| l.trim() == "滨河粮食收购站")
            .expect("倍宽站名没打出来");
        assert_eq!(head.1, 2, "站名应仍是 2 倍宽");
        // 补位空格和正文一样是倍宽：按缩放后的 16 列补 1 列 → 物理宽 15 × 2
        assert_eq!(physical_cols(&head.0) * head.1, 30, "倍宽行的补齐要按缩放后的列数算");
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

    /// 写死版式的两张老票（内建码单 / 自检票）同样不许把横向对齐交回固件。
    ///
    /// 这两张票的落点只能传 0——这一侧算不出二维码的点宽（固件自己挑版本，见 `qr` 的
    /// 说明），而 0 是唯一不可能把码推出纸面的值。这条测试钉住的就是"别再给它们塞一个
    /// 猜出来的落点、也别退回去用 `ESC a 1`"：`ESC a 1` 按机身头宽居中，
    /// 80 机装 58 卷时正好是这次要修的那个坑。
    #[test]
    fn fixed_layout_tickets_never_delegate_alignment() {
        for paper in [Paper::P58, Paper::P80] {
            let ticket = WeighTicket {
                qr_text: "BH1:BD20260912000031".into(),
                paper,
                ..Default::default()
            };
            let buf = Capture::default();
            let mut p = new_printer(buf.clone(), paper);
            write_weigh_ticket(&mut p, &ticket).expect("内建码单不应失败");
            write_self_test(&mut p, paper, "捕获-01").expect("自检票不应失败");
            let bytes = buf.0.borrow();

            // `begin()` 那条 `ESC a 0` 允许留着；带非零参数的（= 交给固件居中/右对齐）一律不许
            let delegated: Vec<u8> = bytes
                .windows(3)
                .filter(|w| w[0] == 0x1B && w[1] == 0x61 && w[2] != 0)
                .map(|w| w[2])
                .collect();
            assert!(
                delegated.is_empty(),
                "{paper:?} 上仍把对齐交给了固件（ESC a {delegated:?}）"
            );
            // 两张票都得真的发出二维码：`GS ( k` 的三个字节，否则上一条断言是空过的
            assert!(
                bytes.windows(3).any(|w| w == [0x1D, 0x28, 0x6B]),
                "{paper:?} 未发出二维码指令，这张票的落点没被验证到"
            );
            // 落点 0：二维码指令前面不许有补位空格（`GS ( k` 从当前位起排点，空格就是位移）
            assert!(
                !bytes.windows(4).any(|w| w == [0x20, 0x1D, 0x28, 0x6B]),
                "{paper:?} 二维码前冒出了补位空格，说明落点不是 0"
            );
        }
    }
}
