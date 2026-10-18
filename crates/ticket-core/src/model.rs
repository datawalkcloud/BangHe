//! 小票数据模型：前端把"这张票要印什么"快照成 JSON 交过来，Rust 只负责排版与送达。
//!
//! 字段全部 `#[serde(default)]`：缺字段只会少印一行，绝不允许把磅队堵在打印这一步。
//! 大写金额由前端 `lib/format.ts` 的 `rmbUpper` 生成后传入——算法只在一处维护，
//! Rust 里再写一份必然分叉。

use serde::{Deserialize, Serialize};

/// 热敏纸宽度。实测现场机是 80 mm（Font A 48 列），58 mm 留给后续小票机站点。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Paper {
    P58,
    #[default]
    P80,
}

impl Paper {
    /// Font A 下每行可打字符数：汉字/全角占 2 列。80 mm = 48 列（实机打 48 个 `-` 不折行）。
    pub fn cols(&self) -> usize {
        match self {
            Paper::P58 => 32,
            Paper::P80 => 48,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Paper::P58 => "58mm 热敏",
            Paper::P80 => "80mm 热敏",
        }
    }

    /// 实际排版用的列数：`override_cols` 是现场实测值，`None` 时用纸宽标称。
    ///
    /// 为什么必须留这个口子：票面折行的头号原因不是版式，而是"声明 48 列、实机只有 32 列"。
    /// 真实列数随机型、驱动、纸宽、字库模式而变，标称值只能当默认。实测入口在
    /// 「小票模板 → 小票机列数」，自检票上的标尺就是用来读这个数的。
    /// 小于 16 列的输入按无效处理——连一个"身份证号(脱敏)"都放不下，必是误填。
    pub fn cols_with(&self, override_cols: Option<u8>) -> usize {
        match override_cols {
            Some(c) if c >= 16 => c as usize,
            _ => self.cols(),
        }
    }
}

/// 过磅码单（热敏小票）。与 A4/针式套打的 `sheets.tsx` 同源同字段，只是版式随纸。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WeighTicket {
    /// 粮站名称（票头）
    pub station_name: String,
    /// 站点编码（票尾留痕）
    pub station_code: String,
    /// 单据号
    pub doc_no: String,
    /// 业务日期 yyyy-MM-dd
    pub biz_date: String,
    /// 打印时刻 yyyy-MM-dd HH:mm:ss
    pub print_time: String,
    /// 磅号，如 `1#`
    pub scale_no: String,

    /// 售粮人姓名
    pub farmer_name: String,
    /// 身份证号（前端已按规则掩码，Rust 不再处理明文）
    pub id_card_masked: String,
    /// 车牌
    pub plate_no: String,
    /// 品种，如"小麦"
    pub grain_name: String,
    /// 等级，如"二等"
    pub grade_name: String,

    /// 毛重 kg
    pub gross_kg: f64,
    /// 皮重 kg
    pub tare_kg: f64,
    /// 净重 kg
    pub net_kg: f64,
    /// 水分 %
    pub moisture: Option<f64>,
    /// 杂质 %
    pub impurity: Option<f64>,
    /// 扣量合计 kg
    pub deduct_kg: f64,
    /// 结算净重 kg
    pub settle_net_kg: f64,
    /// 单价 元/kg
    pub unit_price: f64,
    /// 金额 元
    pub amount: f64,
    /// 人民币大写（前端生成）
    pub amount_upper: String,

    /// 磅员
    pub weigher: String,
    /// 化验员
    pub qc_by: String,
    /// 结算员
    pub cashier: String,
    /// 联次标注，如"第一联 客户联"
    pub copy_note: String,
    /// 是否补打（票面打"补打"字样）
    pub is_reprint: bool,
    /// 二维码内容（扫码查单）
    pub qr_text: String,
    /// 票脚提示语
    pub footer_note: String,

    /// 纸张
    pub paper: Paper,
    /// 份数
    pub copies: u8,
    /// 打印后弹钱箱（结算小票用）
    pub open_drawer: bool,
}

impl WeighTicket {
    /// 份数兜底：0 份是非法输入，按 1 份处理，不能让"点了打印却什么都不出"。
    pub fn copies_or_default(&self) -> u8 {
        if self.copies == 0 {
            1
        } else {
            self.copies.min(6)
        }
    }
}

/// 文本行的水平对齐。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// 通用小票行：**自定义模板的打印出口**。
///
/// 与 [`WeighTicket`] 的分工——那张票的版式写死在本 crate（热敏码单的标准版），
/// 而这里不含任何业务字段：票面由前端按用户当前模板一行行排好交过来，Rust 只把每行
/// 翻成 ESC/POS 指令。于是"改版式不动 Rust"这条承诺才成立——新增一种票据、
/// 勾掉一个字段，变的都只是这个行序列。
///
/// 字段名一律用单词（text / label / value / …），前后端同形。
///
/// **`rename_all_fields` 不能省。** `#[serde(rename_all = "camelCase")]` 用在 enum 上
/// 只重命名 **variant**（`Barcode` → `barcode`），**字段一个都不动**——字段要 `rename_all_fields`
/// 才跟着改。2026-09-15 就是漏了它：前端 `escpos.ts` 发的是 `padLeft`，Rust 认的是
/// `pad_left`，serde 把不认识的字段**静默丢掉**（`#[serde(default)]` 于是补 0），
/// 于是码的落点恒为 0 —— 条码一直贴着纸的左边缘，而改落点算法在机器上毫无变化。
/// 整个 enum 里 `pad_left` 是唯一的多词字段，所以别的字段全都正常，只有它悄悄死了。
/// 加新字段时记住：**多词字段必须能被前端的 camelCase 拼法认出来**。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PrintLine {
    /// 整行文本。样式只作用于这一行——`write_lines` 打完立即复位，不串到下一行去
    Text {
        text: String,
        #[serde(default)]
        align: TextAlign,
        #[serde(default)]
        bold: bool,
        #[serde(default)]
        underline: bool,
        #[serde(default)]
        reverse: bool,
        /// 字宽倍数（1 = 常规，2 = 倍宽）
        #[serde(default = "scale_one")]
        wide: u8,
        /// 字高倍数
        #[serde(default = "scale_one")]
        tall: u8,
    },
    /// 标签 + 右对齐数值（热敏票最常见的"项目 …… 数值"）
    Kv { label: String, value: String },
    /// 一行两组键值，用于"水分 / 杂质"这类并列项
    Pair {
        l1: String,
        v1: String,
        l2: String,
        v2: String,
    },
    /// 铺满一行的分隔线
    Rule,
    /// 走纸 n 行
    Feed { n: u8 },
    /// 二维码；内容为空则整行跳过，不留一个空码
    Qr {
        text: String,
        /// 一个模块占几个点（203dpi，1 点 = 0.125mm）。缺省 4 点，即机器出厂值。
        ///
        /// 从前这条行没有尺寸：`write_lines` 直接发 `qrcode()`，固件恒按默认 4 点排点，
        /// 于是模板里的尺寸档位只对 A4 与预览有效——站长把码调到「超大」，小票上没变化。
        #[serde(default = "qr_size_default")]
        size: u8,
        /// 码左侧的空点，由前端按**纸**算（见 `code-size.ts::codeOffsetDots`）。
        /// 缺省 0 = 贴着纸左端起排。
        ///
        /// 固件的 `ESC a 1` 是按**机身头宽**居中的，与这卷纸无关：80 机装 58 卷时它仍按
        /// 72mm 居中，码就整体偏右、宽的还要出纸。落点只能由知道纸宽的那一侧算。
        #[serde(default)]
        pad_left: u16,
    },
    /// 一维条码（CODE128）。
    ///
    /// 带的是**已算好的条空几何**，不是让机器自己编码的文本：ESC/POS 功能 A 只支持
    /// UPC / EAN / CODE39 / ITF / CODABAR，没有 CODE128；功能 B（`GS ( k`）要赌固件版本，
    /// 而且固件会自动挑选码制压缩，纸上的宽度就不是预览里那个宽度了。
    /// 条空序列由前端 `code128.ts` 一次算出，屏幕与两条出纸路读同一个数组。
    Barcode {
        /// 条 / 空宽度交替序列（单位：模块），第一个元素是条
        runs: Vec<u8>,
        /// 条身的**总点宽**（203dpi，不含静区）
        ///
        /// 带的是总宽而不是"一个模块几点"：纸窄到放不下时前端按**实数**压模块宽度
        /// （见 `code-size.ts::fitModuleDots`），而 `GS v 0` 栅格只能按整数点排——
        /// 小数那一份前端已经折好，这里照总宽把每段分到点上即可（见 `render.rs::barcode`）。
        /// 放不下时前端已经把这个数压小（预览同步压）。
        width: u16,
        /// 条高（点）
        height: u8,
        /// 码左侧的空点，含义与 [`PrintLine::Qr::pad_left`] 完全相同——
        /// 两个码共用同一条轴，`codeStyle: "both"` 时上下才是对齐的
        #[serde(default)]
        pad_left: u16,
    },
}

/// serde 缺省字号：1 倍（常规）。0 会被 escpos 当作非法尺寸，不能让它成为默认值。
fn scale_one() -> u8 {
    1
}

/// 二维码缺省模块尺寸 = 4 点，与 escpos 的 `QRCodeOption::default().size()` 同值：
/// 前端没给尺寸的老调用（自检工装、外部脚本）拿到的就是机器从前一直在打的那一档。
fn qr_size_default() -> u8 {
    4
}
