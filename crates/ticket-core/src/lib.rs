//! 过磅小票（ESC/POS）排版与设备访问的**单一实现**。
//!
//! 为什么单独成 crate：主程序（`src-tauri`）和现场排障工装（`tools/escpos-probe`）
//! 必须打出一模一样的票面。排版规则（栅格宽度、汉字占两列、金额右对齐）一旦在两处
//! 各写一份，现场就会出现"工装能打对、软件打出来折行"这类无法归因的差异。

pub mod device;
pub mod model;
pub mod render;

pub use model::{Paper, PrintLine, TextAlign, WeighTicket};
pub use render::{new_printer, write_lines, write_self_test, write_weigh_ticket};
