//! 硬件联调测试：证明 **64 位进程** 能加载 x64 `Sdtapi.dll` 并读卡（BangHe 的实际运行架构）。
//!
//! 默认跳过（`#[ignore]`），不进 CI、不影响其它在途测试。插好读卡器并放卡后手动跑：
//! ```text
//! cargo test --test idcard_reader -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::time::Duration;

use routon_idr::{port, KeyType, Sdt};

fn dll_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("sdtapi")
        .join("Sdtapi.dll")
}

#[test]
#[ignore]
fn read_card_in_64bit_process() {
    assert_eq!(
        usize::BITS,
        64,
        "本测试验证 64 位进程加载 x64 DLL，请用 x86_64 目标运行"
    );
    let dll = dll_path();
    assert!(dll.exists(), "缺 x64 Sdtapi.dll: {}", dll.display());

    // 关键断言：64 位进程 LoadLibrary 32 位 DLL 会失败；能 load 即证明位数匹配、封装可用。
    let sdt = Sdt::load(&dll).expect("64 位进程加载 x64 Sdtapi.dll 失败");
    let session = sdt
        .open_driverfree(port::DRIVER_FREE_HID, false)
        .or_else(|_| sdt.open_any(&[port::USB_HID, port::AUTO, 1, 2]))
        .expect("打开读卡器失败（请确认设备已插好）");
    println!("[ok] 设备已打开，SAM = {:?}", session.sam_id().ok());

    // 身份证：免驱版需先 authenticate 触发射频再读，重试若干次。
    let mut got_id = false;
    for _ in 0..6 {
        if session.authenticate().unwrap_or(false) {
            match session.read_id_card() {
                Ok(id) => {
                    println!(
                        "[身份证] {} {} {} {} 有效至 {}",
                        id.name, id.gender, id.nation, id.id_number, id.valid_to
                    );
                    got_id = true;
                    break;
                }
                Err(e) => println!("  读身份证失败: {e}"),
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    if !got_id {
        println!("[身份证] 未检测到卡（把身份证贴紧感应区后重跑）");
    }

    // IC 卡：寻卡 + 卡号 + 读扇区0块0（含厂商 UID）。
    match session.ic_find() {
        Ok(Some(card)) => {
            println!("[IC] {} 卡号={}", card.kind_label(), card.sn);
            let _ = session.ic_request();
            match session.ic_read_block(0, 0, KeyType::KeyA, &[0xFF; 6]) {
                Ok(d) => println!("  扇区0块0 = {:02X?}", d),
                Err(e) => println!("  读块失败(可能密钥非默认): {e}"),
            }
        }
        Ok(None) => println!("[IC] 未找到 Mifare 卡"),
        Err(e) => println!("[IC] 寻卡出错: {e}"),
    }
}
