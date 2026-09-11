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
