//! 业务枚举的单一来源（docs/design/03 §3.6）。
//!
//! 同一个枚举在三个地方存在：SQLite 的 `CHECK (col IN (...))`、这里的 Rust 类型、
//! 前端 `src/lib/constants.ts` 的字面量联合。历史上它们分叉过一次（80mm 小票的
//! `thermal80` 只在 `constants.ts` 里补了，文档值域没跟上），所以这里既当代码用，
//! 也当"值域登记表"用：`tests/schema_contract.rs` 会拿 [`ENUM_SPECS`] 去逐一比对
//! 实际建出来的库结构和 `constants.ts`，任一处漏改 CI 直接红。
//!
//! 新增枚举的规矩：
//!   1. 在这里定义，wire 字符串与 §9 表结构里的值逐字一致；
//!   2. 在 [`ENUM_SPECS`] 登记它落在哪张表哪一列、对应前端哪个类型名；
//!   3. 同步 `0001_init.sql`（或新迁移脚本）的 CHECK 与 `constants.ts`。

/// 定义一个与数据库字符串一一对应的枚举，并生成 [`strum`] 双向映射与 `VALUES` 常量。
#[macro_export]
macro_rules! db_enum {
    (
        $(#[$meta:meta])*
        $name:ident { $($variant:ident => $wire:literal),* $(,)? }
    ) => {
        $(#[$meta])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, Hash,
            ::serde::Serialize, ::serde::Deserialize,
            ::strum::EnumIter, ::strum::EnumString, ::strum::Display,
        )]
        pub enum $name {
            $(
                #[strum(serialize = $wire)]
                #[serde(rename = $wire)]
                $variant,
            )*
        }

        impl $name {
            /// 数据库与前端使用的字面量集合，顺序与文档值域一致。
            pub const VALUES: &'static [&'static str] = &[$($wire),*];
        }
    };
}

crate::db_enum! {
    /// 磅单状态（§4.1 全 13 态；终态 archived/voided/reversed/rejected）
    OrderStatus {
        Draft => "draft",
        Registered => "registered",
        QcDone => "qc_done",
        GrossWeighed => "gross_weighed",
        TareWeighed => "tare_weighed",
        Reweigh => "reweigh",
        ToSettle => "to_settle",
        Settled => "settled",
        Paid => "paid",
        Archived => "archived",
        Voided => "voided",
        Reversed => "reversed",
        Rejected => "rejected",
    }
}

crate::db_enum! {
    /// 岗位（§9.4）
    Role {
        StationMaster => "station_master",
        Registrar => "registrar",
        Weigher => "weigher",
        Inspector => "inspector",
        Keeper => "keeper",
        Cashier => "cashier",
        Viewer => "viewer",
    }
}

crate::db_enum! {
    /// 售粮人类型（§9.6）
    PartyType {
        Farmer => "farmer",
        LargeGrower => "large_grower",
        Broker => "broker",
        Cooperative => "cooperative",
        Company => "company",
    }
}

crate::db_enum! {
    /// 档案状态（§9.6：停用只置 status，不删行）
    PartyStatus {
        Active => "active",
        Disabled => "disabled",
    }
}

crate::db_enum! {
    /// 流转卡占用态（§9.26 / 06 篇：在册循环资产，一卡一单）
    CardStatus {
        InPool => "in_pool",
        InUse => "in_use",
        Retired => "retired",
    }
}

crate::db_enum! {
    /// 结算单付款状态（§9.16：比磅单少 `not_required`，结算一定产生应付）
    SettlementPaymentStatus {
        Unpaid => "unpaid",
        Partial => "partial",
        Paid => "paid",
    }
}

crate::db_enum! {
    /// 磅单付款状态（§9.11）
    OrderPaymentStatus {
        Unpaid => "unpaid",
        Partial => "partial",
        Paid => "paid",
        NotRequired => "not_required",
    }
}

crate::db_enum! {
    /// 结算单状态（§9.16：撤销结算标记 revoked）
    SettlementStatus {
        Normal => "normal",
        Revoked => "revoked",
    }
}

crate::db_enum! {
    /// 重量来源（§9.11 `weight_source` / §9.12 `source`；手录是迎检必查项）
    WeightSource {
        Scale => "scale",
        Manual => "manual",
    }
}

crate::db_enum! {
    /// 称重类型（§9.12）
    WeighType {
        Gross => "gross",
        Tare => "tare",
    }
}

crate::db_enum! {
    /// 一条称重轨迹属于哪张单据（§9.12 `doc_kind`，迁移 0029）。
    ///
    /// 值就是**表名**，与 `print_log.doc_type`（[`PrintDocType`]）同一套说法：这一列把
    /// `order_id` 解释成「哪张表的哪个 id」。出库（`outbound_order`）自 02 §M11 波 2 起
    /// 也能过地磅，毛/皮与复称轨迹要和磅单存在同一张表里——「这个重量是怎么来的」查一处
    /// 就够，分两处存迟早对不上。
    ///
    /// 代价是这一列上的外键留不住（两张表的 id 各自递增、数字重叠），引用完整性由服务层判，
    /// 详见迁移 0029 头注。
    WeighDocKind {
        WeighOrder => "weigh_order",
        OutboundOrder => "outbound_order",
    }
}

crate::db_enum! {
    /// 化验判定（§9.13）
    QcDecision {
        Accept => "accept",
        Reject => "reject",
        Conditional => "conditional",
    }
}

crate::db_enum! {
    /// 化验方法（§9.13：近红外/化验室/目测）
    TestMethod {
        Nir => "nir",
        Lab => "lab",
        Visual => "visual",
    }
}

crate::db_enum! {
    /// 化验指标单位（§9.14，与 §3.1 的 0.01% / g/L 一致）
    IndicatorUnit {
        Pct001 => "0.01pct",
        GramPerLitre => "gL",
        Text => "text",
    }
}

crate::db_enum! {
    /// 出库性质（§9.27 `outbound_order.kind`）
    ///
    /// 只有两档，刻意不做多：`sale` 有领出方与单价、产生货款；`record` 是
    /// 领用/自用/损耗这类「粮出了仓但不产生钱」的登记出库。二者的单据结构、
    /// 状态机、库存扣减完全同一条路，差别只在要不要单价与应收。
    /// 转仓（transfer）属 M11 后半段，本期不提供录入入口。
    OutboundKind {
        Sale => "sale",
        Record => "record",
    }
}

crate::db_enum! {
    /// 出库单状态（§9.27）。刻意不复用磅单那 13 态：出库链没有化验、没有二次称重强制序，
    /// 最短路径就是「制单 → 完成出库」，加两个终态兜住冲销。
    /// `reversed` 是已完成单的红冲（补一条对称入库流水，原流水不删），见 §4.3 不变式。
    OutboundStatus {
        Draft => "draft",
        Done => "done",
        Voided => "voided",
        Reversed => "reversed",
    }
}

crate::db_enum! {
    /// 仓房类型（§9.9）
    WarehouseKind {
        House => "house",
        Barn => "barn",
        Shed => "shed",
        Silo => "silo",
    }
}

crate::db_enum! {
    /// 往来单位联系项类型（§9.7）
    ContactKind {
        Contact => "contact",
        Bank => "bank",
        Vehicle => "vehicle",
    }
}

crate::db_enum! {
    /// 附件业务类型（§9.15）
    AttachmentBizType {
        ScaleCapture => "scale_capture",
        IdCardPhoto => "id_card_photo",
        Signature => "signature",
        SamplePhoto => "sample_photo",
        Other => "other",
    }
}

crate::db_enum! {
    /// 付款方式（§9.18）
    PaymentMethod {
        Cash => "cash",
        Bank => "bank",
        Wechat => "wechat",
        Alipay => "alipay",
        Transfer => "transfer",
        CreditWriteoff => "credit_writeoff",
    }
}

crate::db_enum! {
    /// 打印单据类型（§9.19）。
    ///
    /// **这一列写的就是前端那个场景 id**（`silent.ts` 里 `doc_type: scenario`，中间没有
    /// 第二份映射），所以值域必须与 `components/print/receipt/types.ts` 的 `ReceiptScenario`
    /// 逐字对齐。这条对齐 `schema_contract` 够不着（它只解析 `src/lib/constants.ts` 的联合，
    /// 而 `ReceiptScenario` 不在那儿），钉它的是 `scripts/receipt-code/check.ts` 的 N 段（N1/N2/N3）。
    /// 从前就是这里漏了 `payment_receipt`，付款小票在桌面端每打一张留痕都撞 CHECK（迁移 0030 补回）。
    ///
    /// `internal_flow` 是 §9.19 预留的内部流转单，前端还没有对应场景（只有库里有值），
    /// 所以 N1 的判据是「场景 ⊆ 值域」而不是「相等」（N3 另外钉住库里不许再多出没人写的占位值）。
    PrintDocType {
        WeighOrder => "weigh_order",
        QualityReport => "quality_report",
        SettlementVoucher => "settlement_voucher",
        PaymentReceipt => "payment_receipt",
        OutboundOrder => "outbound_order",
        InternalFlow => "internal_flow",
        Ledger => "ledger",
        DailyReport => "daily_report",
    }
}

crate::db_enum! {
    /// 打印通道（§9.19 / 04 文档三通道抽象）
    PrintChannel {
        Preview => "preview",
        PdfSilent => "pdf_silent",
        Raw => "raw",
    }
}

crate::db_enum! {
    /// 打印结果（§9.19）
    PrintResult {
        Success => "success",
        Failed => "failed",
    }
}

crate::db_enum! {
    /// 纸型（§9.3.1 `print_paper`、§9.19 `print_log.paper`）。
    /// thermal80 是现场实机（斯普瑞特 SPRT 80mm，ESC/POS Font A 实测一行 48 列）。
    /// 注意：`print_log.paper` 目前文档未要求 CHECK，见 §3.6 待拍板清单。
    PaperKind {
        A4 => "A4",
        Dot241 => "dot241",
        Thermal58 => "thermal58",
        Thermal80 => "thermal80",
    }
}

crate::db_enum! {
    /// 设备类别（§9.20）
    DeviceKind {
        Scale => "scale",
        IdCard => "idcard",
        Camera => "camera",
        Printer => "printer",
        Scanner => "scanner",
        Led => "led",
        CashBox => "cashbox",
        SignPad => "signpad",
    }
}

crate::db_enum! {
    /// 设备在线态（§9.20 `last_status`）
    DeviceStatus {
        Unknown => "unknown",
        Online => "online",
        Offline => "offline",
        Error => "error",
    }
}

crate::db_enum! {
    /// 审计结果（§9.21：越权尝试同样要记）
    AuditResult {
        Ok => "ok",
        Denied => "denied",
        Error => "error",
    }
}

crate::db_enum! {
    /// 出入库流水类型（§9.23，首版只建表不写入）
    StockMoveKind {
        In => "in",
        Out => "out",
        Transfer => "transfer",
        Loss => "loss",
        Adjust => "adjust",
    }
}

crate::db_enum! {
    /// 系统参数值类型（§9.3）
    SettingValueType {
        String => "string",
        Int => "int",
        Bool => "bool",
        Json => "json",
    }
}

/// 一个枚举在系统中的落点，供契约测试比对。
#[derive(Debug, Clone, Copy)]
pub struct EnumSpec {
    /// Rust 类型名，仅用于报告可读性
    pub rust: &'static str,
    /// 值域（唯一来源：上面 `db_enum!` 生成的 `VALUES`）
    pub values: &'static [&'static str],
    /// 落库的表；`None` 表示该枚举不落库
    pub table: Option<&'static str>,
    /// 落库的列，`CHECK (col IN (...))` 应当与此完全一致
    pub column: &'static str,
    /// 前端 `src/lib/constants.ts` 里的类型名；`None` 表示前端尚未定义
    pub ts: Option<&'static str>,
    /// 前端值域是否必须与后端完全相等。
    /// `false` 表示前端是共用显示字典（超集），只要求后端每个值都有标签。
    pub ts_strict: bool,
}

/// 枚举落点登记表。新增枚举不登记 = 不参与校验，`tests` 里的数量断言会拦住。
pub const ENUM_SPECS: &[EnumSpec] = &[
    EnumSpec { rust: "OrderStatus", values: OrderStatus::VALUES, table: Some("weigh_order"), column: "status", ts: Some("OrderStatus"), ts_strict: true },
    EnumSpec { rust: "Role", values: Role::VALUES, table: Some("user_account"), column: "role", ts: Some("Role"), ts_strict: true },
    EnumSpec { rust: "PartyType", values: PartyType::VALUES, table: Some("party"), column: "party_type", ts: Some("PartyType"), ts_strict: true },
    EnumSpec { rust: "PartyStatus", values: PartyStatus::VALUES, table: Some("party"), column: "status", ts: None, ts_strict: false },
    EnumSpec { rust: "CardStatus", values: CardStatus::VALUES, table: Some("card"), column: "status", ts: Some("CardStatus"), ts_strict: true },
    EnumSpec { rust: "WeightSource", values: WeightSource::VALUES, table: Some("weigh_order"), column: "weight_source", ts: Some("WeightSource"), ts_strict: true },
    EnumSpec { rust: "WeightSource", values: WeightSource::VALUES, table: Some("weigh_record"), column: "source", ts: Some("WeightSource"), ts_strict: true },
    EnumSpec { rust: "WeighType", values: WeighType::VALUES, table: Some("weigh_record"), column: "weigh_type", ts: None, ts_strict: false },
    EnumSpec { rust: "WeighDocKind", values: WeighDocKind::VALUES, table: Some("weigh_record"), column: "doc_kind", ts: None, ts_strict: false },
    EnumSpec { rust: "OrderPaymentStatus", values: OrderPaymentStatus::VALUES, table: Some("weigh_order"), column: "payment_status", ts: Some("PaymentStatus"), ts_strict: true },
    EnumSpec { rust: "SettlementPaymentStatus", values: SettlementPaymentStatus::VALUES, table: Some("settlement"), column: "payment_status", ts: Some("PaymentStatus"), ts_strict: false },
    EnumSpec { rust: "SettlementStatus", values: SettlementStatus::VALUES, table: Some("settlement"), column: "status", ts: None, ts_strict: false },
    EnumSpec { rust: "QcDecision", values: QcDecision::VALUES, table: Some("qc_report"), column: "decision", ts: Some("QcDecision"), ts_strict: true },
    EnumSpec { rust: "TestMethod", values: TestMethod::VALUES, table: Some("qc_report"), column: "test_method", ts: Some("TestMethod"), ts_strict: true },
    EnumSpec { rust: "IndicatorUnit", values: IndicatorUnit::VALUES, table: Some("qc_indicator"), column: "unit", ts: Some("IndicatorUnit"), ts_strict: true },
    EnumSpec { rust: "WarehouseKind", values: WarehouseKind::VALUES, table: Some("warehouse"), column: "kind", ts: None, ts_strict: false },
    EnumSpec { rust: "ContactKind", values: ContactKind::VALUES, table: Some("party_contact"), column: "kind", ts: None, ts_strict: false },
    EnumSpec { rust: "AttachmentBizType", values: AttachmentBizType::VALUES, table: Some("attachment"), column: "biz_type", ts: None, ts_strict: false },
    EnumSpec { rust: "PaymentMethod", values: PaymentMethod::VALUES, table: Some("payment_record"), column: "method", ts: Some("PaymentMethod"), ts_strict: true },
    EnumSpec { rust: "PrintDocType", values: PrintDocType::VALUES, table: Some("print_log"), column: "doc_type", ts: None, ts_strict: false },
    EnumSpec { rust: "PrintChannel", values: PrintChannel::VALUES, table: Some("print_log"), column: "channel", ts: Some("PrintChannel"), ts_strict: true },
    EnumSpec { rust: "PrintResult", values: PrintResult::VALUES, table: Some("print_log"), column: "result", ts: None, ts_strict: false },
    EnumSpec { rust: "PaperKind", values: PaperKind::VALUES, table: Some("print_log"), column: "paper", ts: Some("PaperKind"), ts_strict: true },
    EnumSpec { rust: "DeviceKind", values: DeviceKind::VALUES, table: Some("device_config"), column: "kind", ts: Some("DeviceKind"), ts_strict: true },
    EnumSpec { rust: "DeviceStatus", values: DeviceStatus::VALUES, table: Some("device_config"), column: "last_status", ts: Some("DeviceStatus"), ts_strict: true },
    EnumSpec { rust: "AuditResult", values: AuditResult::VALUES, table: Some("audit_log"), column: "result", ts: None, ts_strict: false },
    EnumSpec { rust: "StockMoveKind", values: StockMoveKind::VALUES, table: Some("stock_movement"), column: "kind", ts: None, ts_strict: false },
    EnumSpec { rust: "OutboundKind", values: OutboundKind::VALUES, table: Some("outbound_order"), column: "kind", ts: Some("OutboundKind"), ts_strict: true },
    EnumSpec { rust: "OutboundStatus", values: OutboundStatus::VALUES, table: Some("outbound_order"), column: "status", ts: Some("OutboundStatus"), ts_strict: true },
    EnumSpec { rust: "WeightSource", values: WeightSource::VALUES, table: Some("outbound_order"), column: "weight_source", ts: Some("WeightSource"), ts_strict: true },
    EnumSpec { rust: "OrderPaymentStatus", values: OrderPaymentStatus::VALUES, table: Some("outbound_order"), column: "payment_status", ts: Some("PaymentStatus"), ts_strict: true },
    EnumSpec { rust: "SettingValueType", values: SettingValueType::VALUES, table: Some("app_setting"), column: "value_type", ts: None, ts_strict: false },
];
