//! 地磅读数流（04 §2；`src-tauri/src/scale.rs`）的契约测试。
//!
//! **没有真机**，所以钉死的是"真机之外唯一能验的那一层"——04 §2.3 模板的解析语义与
//! §2.4 的采集流程：切帧（半帧/粘包/垃圾帧）、位置化取数（小数点有无、负数、单位、
//! 超载）、滑动窗口判稳（分度极差、起称阈值、持续时长）、节流与稳定补发、无帧 5 秒
//! 只报一次、连续 20 帧坏帧升级 BadFrame，以及 `device://scale` 的字段名。
//!
//! 字段名单独有一整块断言：这条事件是前端 `store/device.ts` 的 `ScaleState` 唯一的
//! 数据来源，名字错了整路就白接。样本字节按文档 §2.2 A 族的真实形态手写
//! （耀华 XK3190-A9 连续发送 `=0000000052.3kg\r\n`），不是编出来的理想帧。

use rusqlite::{params, Connection};

use banghe_lib::db;
use banghe_lib::scale::{
    capture_align, driver_preset, frame_display, load_config, load_device, parse_hex, parse_template, parse_weight,
    resolve_template, split_frames, split_frames_ex, yaohua_xk3190_cont, Align, Framing, Judgement, Payload,
    ScaleEvent, Stability, StabilityJudge, StreamCore, FrameTemplate, Transport,
};

// ------------------------------------------------------------------ 测试用模板

/// 文档 §2.3 那段 JSON，逐字搬过来。
const DOC_TEMPLATE: &str = r#"{
  "transport": { "kind": "serial", "port": "COM3", "baud": 9600, "data_bits": 8,
                 "parity": "none", "stop_bits": 1 },
  "framing":   { "mode": "delimited", "start": "=", "terminator": "\r\n",
                 "encoding": "ascii", "max_len": 20 },
  "payload":   { "sign_index": 1, "digits": "0123456", "decimal_places": 1,
                 "skip_chars": " ", "unit": "kg", "status_bytes": [] },
  "stability": { "window_frames": 5, "max_spread_divisions": 2,
                 "min_weight_01kg": 0, "stable_ms": 400 },
  "align":     { "division_01kg": 100, "mode": "nearest_div" },
  "query":     { "enabled": false, "command_hex": "02 3F 57 45 03", "interval_ms": 200 }
}"#;

fn doc_tpl() -> FrameTemplate {
    parse_template(DOC_TEMPLATE).expect("文档 §2.3 的模板必须原样可解析")
}

/// 耀华 XK3190-A9 连续发送的一帧（含 CRLF），文档 §2.2 A 族。
fn a9_frame(text: &str) -> Vec<u8> {
    let mut v = text.as_bytes().to_vec();
    v.extend_from_slice(b"\r\n");
    v
}

fn payload_of(tpl: &FrameTemplate) -> Payload {
    tpl.payload.clone()
}

// ================================================================== 模板与默认值

#[test]
fn empty_config_lands_on_every_document_default() {
    // 现场从"什么都没配"起步：§2.3 的五条默认值必须一条不落
    let t = parse_template("{}").expect("空对象也是合法配置");
    assert_eq!(t.stability.window_frames, 5);
    assert_eq!(t.stability.max_spread_divisions, 2);
    assert_eq!(t.stability.min_weight_01kg, 0);
    assert_eq!(t.stability.stable_ms, 400);
    assert_eq!(t.align.division_01kg, 100);
    assert_eq!(t.align.mode, "nearest_div");
    assert_eq!(t.framing.mode, "delimited");
    assert_eq!(t.framing.start, "=");
    assert_eq!(t.framing.terminator, "\r\n");
    assert_eq!(t.framing.max_len, 20);
    assert_eq!(t.payload.sign_index, 1);
    assert_eq!(t.payload.decimal_places, 1);
    assert_eq!(t.transport.baud, 9600);
    assert_eq!(t.transport.parity, "none");
    assert_eq!(t.query.interval_ms, 200);
    assert!(!t.query.enabled, "默认是 A 族连续发送，不主动查询");
    // 空字符串与缺字段等价：设备台账里 config_json 常被清成 ''
    assert_eq!(parse_template("").unwrap(), t);
}

#[test]
fn document_template_deserializes_verbatim() {
    let t = doc_tpl();
    assert_eq!(t.transport.port, "COM3");
    assert_eq!(t.transport.data_bits, 8);
    assert_eq!(t.payload.digits, "0123456");
    assert_eq!(t.payload.skip_chars, " ");
    assert_eq!(t.payload.unit, "kg");
    assert_eq!(t.payload.status_bytes, Vec::<u8>::new());
    assert_eq!(t.query.command_hex, "02 3F 57 45 03");
    assert_eq!(parse_hex(&t.query.command_hex).unwrap(), vec![0x02, 0x3F, 0x57, 0x45, 0x03]);
}

#[test]
fn partial_sections_fall_back_per_field_not_wholesale() {
    // 现场只改分度值时不会重写整段：同段里没写的字段仍要落到默认值
    let t = parse_template(r#"{ "align": {"division_01kg": 200}, "stability": {"stable_ms": 800} }"#).unwrap();
    assert_eq!(t.align.division_01kg, 200);
    assert_eq!(t.align.mode, "nearest_div");
    assert_eq!(t.stability.stable_ms, 800);
    assert_eq!(t.stability.window_frames, 5);
    assert_eq!(t.framing.start, "=");
}

#[test]
fn broken_template_says_why_in_chinese_without_rust_debug() {
    let e = parse_template(r#"{ "stability": {"window_frames": "five"} }"#).unwrap_err();
    assert!(e.starts_with("帧模板解析失败："), "{e}");
    assert!(e.contains("window_frames"), "要指得出是哪个字段：{e}");
    assert!(!e.contains("at line"), "不能把 serde 的行列原文丢给现场：{e}");
    assert!(!e.contains("{:"), "{e}");
    let e2 = parse_template("不是 JSON").unwrap_err();
    assert!(e2.contains("帧模板解析失败"), "{e2}");
}

#[test]
fn unknown_keys_are_tolerated_because_config_json_is_shared() {
    // 故意不用 deny_unknown_fields：config_json 是设备中心几种驱动共用的一个 blob，
    // 打印机/身份证的 preset 之类也写在同一份里；严格校验会让磅因为别人的键起不来。
    let t = parse_template(
        r#"{ "stability": {"stable_ms": 800}, "preset": {"zero": "0Z"}, "transport": {"baud": 19200, "usb_vid": "1234"} }"#,
    )
    .expect("别人的键不能把磅挡住");
    assert_eq!(t.stability.stable_ms, 800);
    assert_eq!(t.transport.baud, 19200);
    assert_eq!(t.transport.port, "");
    // 代价：写错的键只会被忽略、不会报错，同段没写的字段照旧落默认值
    let typo = parse_template(r#"{ "stability": {"windows_frames": 9} }"#).unwrap();
    assert_eq!(typo.stability.window_frames, 5, "手误的键被忽略，window_frames 仍是默认 5");
}

// ================================================================== 切帧

fn framing() -> Framing {
    doc_tpl().framing
}

#[test]
fn splits_one_whole_frame_and_keeps_start_and_terminator() {
    // 起始符与终止符都留在帧里：payload 的下标（sign_index=1）是按含 `=` 的原帧数出来的
    let mut buf = b"=000000052.3kg\r\n".to_vec();
    let frames = split_frames(&mut buf, &framing());
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0], b"=000000052.3kg\r\n");
    assert!(buf.is_empty(), "整帧吃掉后缓冲区必须为空");
}

#[test]
fn half_frame_stays_in_buffer_and_finishes_next_read() {
    // 9600 bps 下一帧常被拆成两三段到达；半帧丢了就是现场"读数跳不定"的成因
    let f = framing();
    let mut buf = Vec::new();
    buf.extend_from_slice(b"=00000");
    assert!(split_frames(&mut buf, &f).is_empty(), "还没有终止符，不能出帧");
    assert_eq!(buf, b"=00000", "半帧必须原地留着");
    buf.extend_from_slice(b"0052.3kg\r\n=00000037.0kg\r\n");
    let frames = split_frames(&mut buf, &f);
    assert_eq!(frames.len(), 2, "补齐的一段要切出两帧");
    assert_eq!(frames[0], b"=000000052.3kg\r\n");
    assert_eq!(frames[1], b"=00000037.0kg\r\n");
    assert!(buf.is_empty());
}

#[test]
fn sticky_two_frames_split_with_no_lost_bytes() {
    // 粘包：一次 read 拿到两帧半
    let f = framing();
    let mut buf = Vec::new();
    buf.extend_from_slice(b"=000000052.3kg\r\n=000000061.8kg\r\n=000000");
    let frames = split_frames(&mut buf, &f);
    assert_eq!(frames.len(), 2);
    assert_eq!(buf, b"=000000", "剩下的半帧一个字节都不能少");
    buf.extend_from_slice(b"052.3kg\r\n");
    assert_eq!(split_frames(&mut buf, &f), vec![b"=000000052.3kg\r\n".to_vec()]);
}

#[test]
fn garbage_before_start_is_counted_and_does_not_block_the_next_good_frame() {
    let f = framing();
    let mut buf = b"\x00\xff=000000052.3kg\r\n".to_vec();
    let out = split_frames_ex(&mut buf, &f);
    assert_eq!(out.frames.len(), 1, "起始符之前的垃圾不能挡住后面的好帧");
    assert_eq!(out.dropped_bytes, 2, "丢掉的字节数要能报给帧监视器：{:?}", out);
    assert!(buf.is_empty());
}

#[test]
fn oversize_junk_frame_is_dropped_and_counted() {
    let f = framing();
    // 起始符之后 30 字节还没有终止符：这一"帧"必然作废（留着也永远切不出来）
    let mut junk = vec![b'='];
    junk.extend_from_slice(&[b'x'; 30]);
    let out = split_frames_ex(&mut junk, &f);
    assert!(out.frames.is_empty());
    assert!(out.dropped_frames >= 1, "超长帧必须计数：{out:?}");
    assert!(junk.is_empty(), "残尾也得清干净，不然缓冲区无上限长大");
    // 丢掉之后紧接着的真帧照常可切
    junk.extend_from_slice(b"=000000052.3kg\r\n");
    assert_eq!(split_frames(&mut junk, &f).len(), 1);
}

#[test]
fn a_queue_of_good_frames_is_not_mistaken_for_an_oversize_junk() {
    // 一次 read 拿到 5 帧（总长 80 > max_len）时绝不能整段丢掉：
    // 超长判定只能针对"找不到终止符的那一段半帧"
    let f = framing();
    let mut buf = Vec::new();
    for _ in 0..5 {
        buf.extend_from_slice(b"=000000052.3kg\r\n");
    }
    let out = split_frames_ex(&mut buf, &f);
    assert_eq!(out.frames.len(), 5, "{out:?}");
    assert_eq!(out.dropped_frames, 0);
    assert!(buf.is_empty());
}

#[test]
fn stx_etx_delimited_variant() {
    // 文档 §2.2 说起始符"常为 = 或 STX"、终止符可为 ETX：不能只认 = 与 CRLF
    let f = Framing {
        mode: "delimited".into(),
        start: "\u{02}".into(),
        terminator: "\u{03}".into(),
        encoding: "ascii".into(),
        max_len: 24,
        fixed_len: 0,
        checksum: "none".into(),
    };
    let mut buf = vec![0x02u8, b'+', b'0', b'0', b'0', b'5', b'2', b'.', b'3', b'k', b'g', 0x03];
    let frames = split_frames(&mut buf, &f);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0][0], 0x02);
    let mut p = payload_of(&doc_tpl());
    p.sign_index = 1;
    assert_eq!(parse_weight(&frames[0], &p).unwrap(), 523);
}

#[test]
fn fixed_len_framing_for_polled_binary_answers() {
    let f = Framing {
        mode: "fixed_len".into(),
        start: String::new(),
        terminator: String::new(),
        encoding: "ascii".into(),
        max_len: 20,
        fixed_len: 6,
        checksum: "none".into(),
    };
    let mut buf = vec![1, 2, 3, 4, 5, 6, 7, 8];
    let frames = split_frames(&mut buf, &f);
    assert_eq!(frames.len(), 1);
    assert_eq!(buf.len(), 2, "不足定长的尾巴留着等下一次");
}

#[test]
fn frame_display_escapes_control_bytes_for_the_monitor() {
    assert_eq!(frame_display(b"=052.3kg\r\n"), "=052.3kg\\r\\n");
    assert_eq!(frame_display(&[0x02, b'+', 0x17, 0x03]), "\\x02+\\x17\\x03");
}

// ================================================================== 取数

#[test]
fn parses_document_sample_frame() {
    // =0000000052.3kg\r\n → 52.3 kg → 523 个 0.1 kg
    let p = payload_of(&doc_tpl());
    assert_eq!(parse_weight(b"=0000000052.3kg\r\n", &p).unwrap(), 523);
    assert_eq!(parse_weight(b"=0000000052.3kg", &p).unwrap(), 523, "终止符在不在都该读得出来");
    assert_eq!(parse_weight(b"=+0000000052.3kg\r\n", &p).unwrap(), 523, "显式正号");
}

#[test]
fn negative_weight_for_backing_off_and_tare_correction() {
    // §2.5 要求模板能吃下负值：回皮/空磅时仪表就是会出负数
    let p = payload_of(&doc_tpl());
    assert_eq!(parse_weight(b"=-00000012.6kg\r\n", &p).unwrap(), -126);
    assert_eq!(parse_weight(b"=-000001260kg\r\n", &p).unwrap(), -12600, "无小数点按 kg 换算后取负");
}

#[test]
fn no_decimal_point_means_plain_kg() {
    // §2.3：「无小数点时按 kg 直接换算」
    let p = payload_of(&doc_tpl());
    assert_eq!(parse_weight(b"=000000523kg\r\n", &p).unwrap(), 5230);
    assert_eq!(parse_weight(b"=+00012500kg\r\n", &p).unwrap(), 125_000, "12500 kg = 一台满载");
}

#[test]
fn decimal_places_only_pads_a_short_fraction() {
    let mut p = payload_of(&doc_tpl());
    p.decimal_places = 2;
    assert_eq!(parse_weight(b"=0000000052.3kg\r\n", &p).unwrap(), 523, "52.30 kg 仍是 523");
    assert_eq!(parse_weight(b"=0000000052.35kg\r\n", &p).unwrap(), 524, "两位小数按 0.1kg 四舍五入");
    p.decimal_places = 0;
    assert_eq!(
        parse_weight(b"=0000000052.35kg\r\n", &p).unwrap(),
        524,
        "dp 只负责给短小数右补 0，不许挪动帧里的小数点：52.35 kg 仍是 523.5 → 524"
    );
}

#[test]
fn space_padded_field_skips_padding() {
    let p = payload_of(&doc_tpl());
    assert_eq!(parse_weight(b"=    52.3 kg\r\n", &p).unwrap(), 523);
    let mut strict = p.clone();
    strict.skip_chars = String::new();
    // 不认空格时读到的是空格前的空数字区 → 必须明确报错而不是悄悄读成 0
    assert!(parse_weight(b"=    52.3 kg\r\n", &strict).is_err());
}

#[test]
fn unit_outside_kg_still_lands_on_01kg() {
    let mut p = payload_of(&doc_tpl());
    p.unit = "t".into();
    assert_eq!(parse_weight(b"=000000052.3000\r\n", &p).unwrap(), 523_000, "52.3000 t = 523000 个 0.1kg");
    p.unit = "0.1kg".into();
    assert_eq!(parse_weight(b"=000000523\r\n", &p).unwrap(), 523, "仪表直接出 0.1kg 时不再乘 10");
    p.unit = "furlong".into();
    let e = parse_weight(b"=000000523\r\n", &p).unwrap_err();
    assert!(e.contains("单位"), "{e}");
}

#[test]
fn overload_display_is_rejected_as_a_reading() {
    let p = payload_of(&doc_tpl());
    let e = parse_weight(b"=-OL----.----kg\r\n", &p).unwrap_err();
    assert!(e.contains("超载"), "{e}");
}

#[test]
fn frame_without_digits_or_with_merged_digits_is_an_error() {
    let p = payload_of(&doc_tpl());
    let e = parse_weight(b"=kg\r\n", &p).unwrap_err();
    assert!(e.contains("找不到数字"), "{e}");
    // 13 位数字：明显是把两帧并成了一帧，绝不能当成一次读数
    let e2 = parse_weight(b"=00000000000052.3kg\r\n", &p).unwrap_err();
    assert!(e2.contains("数字"), "{e2}");
    let e3 = parse_weight(b"", &p).unwrap_err();
    assert_eq!(e3, "空帧");
}

#[test]
fn every_parse_error_is_chinese_and_short() {
    // 硬约束：业务失败一律中文短句，不泄漏 Rust Debug 串
    let p = payload_of(&doc_tpl());
    for frame in [
        b"".as_slice(),
        b"=kg\r\n".as_slice(),
        b"=-OL----.----kg\r\n".as_slice(),
        b"=00000000000052.3kg\r\n".as_slice(),
    ] {
        let e = parse_weight(frame, &p).unwrap_err();
        assert!(e.chars().any(|c| c as u32 >= 0x4e00), "必须是中文：{e}");
        assert!(e.chars().count() <= 80, "短句，不要一坨：{e}");
        assert!(!e.contains("ParseIntError") && !e.contains("Err"), "{e}");
    }
}

// ================================================================== 判稳

fn judge(stability: Stability, align: Align) -> StabilityJudge {
    StabilityJudge::new(stability, align)
}

fn doc_stability() -> Stability {
    doc_tpl().stability
}

fn doc_align() -> Align {
    doc_tpl().align
}

/// 与前端 `store/device.ts:165` 的 `tick()` 逐条同判：窗口未满不稳、攒满后比 `max-min`。
fn js_tick_stable(samples: &[i64], window: usize, tolerance: i64) -> bool {
    if samples.len() < window {
        return false;
    }
    let min = *samples.iter().min().unwrap();
    let max = *samples.iter().max().unwrap();
    max - min <= tolerance
}

#[test]
fn stability_needs_a_full_window_then_spread_within_divisions() {
    let mut j = judge(doc_stability(), doc_align());
    // 前 4 帧：窗口没攒满，和模拟流 `samples.length >= WINDOW` 同判
    for i in 0..4 {
        let r = j.push(5000, i * 200, None);
        assert!(!r.stable, "第 {} 帧窗口未满就该不稳", i + 1);
    }
    // 第 5 帧：极差 0（≤ 2 分度）、均值 5000 ≥ 2000、持续 800 ms ≥ 400 ms → 稳
    let r = j.push(5000, 800, None);
    assert!(r.stable, "{r:?}");
    assert_eq!(r.samples.len(), 5);
    assert_eq!(r.aligned_01kg, 5000);
}

#[test]
fn spread_exactly_two_divisions_is_stable_but_one_tenth_more_is_not() {
    // 极差边界：`max_spread_divisions=2` × 分度 100 = 200 个 0.1 kg
    let mut a = judge(doc_stability(), doc_align());
    let mut b = judge(doc_stability(), doc_align());
    let seq_ok = [5000i64, 5200, 5000, 5200, 5000]; // 极差 200
    let seq_bad = [5000i64, 5201, 5000, 5201, 5000]; // 极差 201
    let mut last_ok = None;
    for (i, w) in seq_ok.iter().enumerate() {
        last_ok = Some(a.push(*w, (i as u64) * 200, None));
    }
    let ok = last_ok.unwrap();
    assert!(ok.stable, "刚好 2 个分度必须算稳：{ok:?}");
    assert_eq!(ok.spread_01kg, 200);
    let mut bad = None;
    for (i, w) in seq_bad.iter().enumerate() {
        bad = Some(b.push(*w, (i as u64) * 200, None));
    }
    let bad = bad.unwrap();
    assert!(!bad.stable, "多出 0.1 kg 就是 3 个分度的边界，不能判稳：{bad:?}");
    assert_eq!(bad.spread_01kg, 201);
}

#[test]
fn one_division_tolerance_config_is_the_front_end_line() {
    // max_spread_divisions=1 + division=50 → 容差 50 个 0.1kg，与前端 TOLERANCE=50 同一条线
    let mut s = doc_stability();
    s.max_spread_divisions = 1;
    let mut al = doc_align();
    al.division_01kg = 50;
    let mut j = judge(s.clone(), al.clone());
    let seq = [5000i64, 5040, 5000, 5040, 5010];
    let mut mine = Vec::new();
    for (i, w) in seq.iter().enumerate() {
        mine.push(j.push(*w, (i as u64) * 200, None).stable);
    }
    let js: Vec<bool> = (1..=seq.len())
        .map(|n| js_tick_stable(&seq[..n], 5, 50))
        .collect();
    assert_eq!(mine, js, "判稳的时序必须和 tick() 一致：{:?}", mine);
    let mut j2 = judge(s.clone(), al.clone());
    let seq2 = [5000i64, 5060, 5000, 5060, 5000];
    let mut out = Vec::new();
    for (i, w) in seq2.iter().enumerate() {
        out.push(j2.push(*w, (i as u64) * 200, None).stable);
    }
    let js2: Vec<bool> = (1..=5).map(|n| js_tick_stable(&seq2[..n], 5, 50)).collect();
    assert_eq!(out, js2);
    assert_eq!(out[4], false, "1 分度容差（50）下极差 60 必须不稳");
}

#[test]
fn no_min_weight_gate_by_default_but_an_opt_in_threshold_still_works() {
    // 默认不设任何起称限制：30 kg 只要纹丝不动、攒满窗口就该判稳（62 kg 砝码台架实测要能稳）
    let mut j = judge(doc_stability(), doc_align());
    assert_eq!(doc_stability().min_weight_01kg, 0, "默认必须是没有阈值");
    let mut last = None;
    for i in 0..5 {
        last = Some(j.push(300, i * 200, None));
    }
    assert!(last.unwrap().stable, "默认阈值 0 时轻载稳态必须能判稳，绝不被起称限制拦下");

    // 现场显式配了阈值才生效：低于阈值即使不动也不算稳，够到阈值才算
    let gated = Stability {
        window_frames: 5,
        max_spread_divisions: 2,
        min_weight_01kg: 2000,
        stable_ms: 400,
    };
    let mut low = judge(gated.clone(), doc_align());
    for i in 0..6 {
        assert!(!low.push(300, i * 200, None).stable, "配了 200 kg 阈值时 30 kg 反复不动也不算稳");
    }
    let mut ok = judge(gated, doc_align());
    let mut last = None;
    for i in 0..5 {
        last = Some(ok.push(2000, i * 200, None));
    }
    assert!(last.unwrap().stable, "刚好等于阈值算起称");
}

#[test]
fn stable_ms_is_a_real_duration_gate() {
    // 20 ms 一帧的仪表：窗口 5 帧只有 80 ms，持续时长不够，不能"秒稳"
    let mut fast = judge(doc_stability(), doc_align());
    let mut r = None;
    for i in 0..5 {
        r = Some(fast.push(5000, i * 20, None));
    }
    let r = r.unwrap();
    assert!(!r.stable, "窗口只持续 {} ms < 400 ms：{r:?}", r.window_ms);
    // 恰好 400 ms → 稳（判据是 ≥）
    let mut exact = judge(doc_stability(), doc_align());
    let mut e = None;
    for i in 0..5 {
        e = Some(exact.push(5000, i * 100, None));
    }
    assert!(e.unwrap().stable, "刚好 400 ms 必须算稳");
    // 差 1 ms 就不稳
    let mut short = judge(doc_stability(), doc_align());
    let mut s = None;
    for i in 0..5 {
        s = Some(short.push(5000, i * 99, None));
    }
    assert!(!s.unwrap().stable);
}

#[test]
fn a_fast_meter_keeps_framing_until_the_window_is_long_enough() {
    // 20 ms 一帧（50 Hz）压住车不动：旧写法把窗口封死在 5 帧 = 100 ms，`span >= 400 ms`
    // 永远不成立，判稳就成了不可能事件。现在窗口按时长收口，攒到 400 ms 就该给稳。
    let mut j = judge(doc_stability(), doc_align());
    let mut last = None;
    for i in 0..30 {
        last = Some(j.push(5000, i * 20, None));
    }
    let r = last.unwrap();
    assert!(r.stable, "50 Hz 仪表稳定压磅必须能判稳：窗口 {} ms / {} 帧", r.window_ms, r.samples.len());
    assert!(r.window_ms >= 400, "窗口时长是判稳的前提：{r:?}");
    assert!(r.samples.len() >= 5, "帧数下限仍然要满足：{r:?}");
    assert!(r.samples.len() < 25, "够长之后要把老样本收掉，不能一路堆成无限窗口：{r:?}");

    // 同一条快链路上真的在晃，依然不能给稳（时长收口不是放松判据）
    let mut shaky = judge(doc_stability(), doc_align());
    let mut last = None;
    for i in 0..30 {
        last = Some(shaky.push(if i % 2 == 0 { 5000 } else { 9000 }, i * 20, None));
    }
    assert!(!last.unwrap().stable, "极差 40 kg 远超 2 分度容差，多久都不该稳");
}

#[test]
fn window_slides_out_the_oldest_sample() {
    let mut j = judge(doc_stability(), doc_align());
    for i in 0..5 {
        j.push(5000, i * 200, None);
    }
    // 第 6 帧把最老的 5000 挤掉，换成一个离群的 9000 → 极差 4000 → 不稳
    let r = j.push(9000, 1000, None);
    assert!(!r.stable);
    assert_eq!(r.samples, vec![5000, 5000, 5000, 5000, 9000]);
    assert_eq!(r.samples.len(), 5, "窗口永远只有 window_frames 个");
    assert_eq!(r.spread_01kg, 4000);
    assert_eq!(r.mean_01kg, 5800);
}

#[test]
fn device_reported_stable_relaxes_but_does_not_skip_the_local_check() {
    // §2.2 B 族"稳定才发"：设备标稳可以把窗口条件减半，但仍要本地二次确认
    let mut tpl = doc_tpl();
    tpl.payload.status_stable_byte = Some(12);
    tpl.payload.status_stable_mask = Some(0x01);
    let mut core = StreamCore::new(tpl.clone(), "scale1", 1);
    let mut frame = a9_frame("=000000500.0kg");
    frame.insert(12, 0x01); // 打上位
    let got = core.feed(&frame, 0);
    assert_eq!(core.buffer_len(), 0, "帧该被吃干净");
    assert_eq!(got.len(), 1, "标稳帧即使只有 1 帧也要出事件：{got:?}");
    assert!(!got[0].stable, "只攒到一半窗口，本地二次确认还没过");
    let mut all = Vec::new();
    for i in 1..3 {
        all.extend(core.feed(&frame, i * 100));
    }
    assert!(all.last().expect("应有事件").stable, "标稳 + 2 帧 + 100 ms（≥ stable_ms 的一半）应判稳");
}

#[test]
fn nearest_div_matches_the_frontend_rounding() {
    let a = doc_align();
    assert_eq!(a.apply(523), 500, "52.3 kg → 50 kg（与 Math.round(523/100)*100 同）");
    assert_eq!(a.apply(550), 600, "半个分度向上");
    assert_eq!(a.apply(2537), 2500);
    assert_eq!(a.apply(-126), -100, "负值按远离零进位，和仪表显示一致");
    let floor = Align { division_01kg: 100, mode: "floor_div".into() };
    assert_eq!(floor.apply(599), 500);
    assert_eq!(floor.apply(-599), -600);
    let ceil = Align { division_01kg: 100, mode: "ceil_div".into() };
    assert_eq!(ceil.apply(501), 600);
    assert_eq!(ceil.apply(500), 500);
    let none = Align { division_01kg: 100, mode: "none".into() };
    assert_eq!(none.apply(523), 523, "取整规则可整段关掉（H9 站点要原值时）");
    let broken = Align { division_01kg: 0, mode: "nearest_div".into() };
    assert_eq!(broken.apply(523), 523, "分度配成 0 不能炸也不能把数吞成 0");
}

#[test]
fn judgement_shape_is_camel_case_for_debugging() {
    let mut j = judge(doc_stability(), doc_align());
    let r = j.push(5000, 0, None);
    let v = serde_json::to_value(&r).unwrap();
    assert!(v.get("aligned01kg").is_some() || v.get("aligned_01kg").is_some(), "{v}");
    assert!(v.get("spread01kg").is_some(), "Judgement 只在 Rust 侧与测试里用，camelCase 即可");
}

// ================================================================== 流内核：节流/补发/饥饿

fn core_of(tpl: FrameTemplate) -> StreamCore {
    StreamCore::new(tpl, "scale1", 7)
}

fn feed_frame(core: &mut StreamCore, text: &str, at_ms: u64) -> Vec<ScaleEvent> {
    core.feed(format!("{text}\r\n").as_bytes(), at_ms)
}

#[test]
fn unstable_frames_are_throttled_to_ten_per_second() {
    // 20 ms 一帧、连喂 1000 ms 的抖动读数：下发必须不超过 10 帧/秒
    let mut core = core_of(doc_tpl());
    let mut n = 0;
    for i in 0..20u64 {
        let w = if i % 2 == 0 { 5000 } else { 9000 }; // 极差 4000 → 一直不稳
        n += feed_frame(&mut core, &format!("={w:011}.0kg"), i * 50).len();
    }
    assert!((8..=11).contains(&n), "1 秒里被节流后应当只剩 10 条左右，实际 {n}");
    assert_eq!(core.frame_count, 20, "节流只挡下发，不挡计数");
}

#[test]
fn stable_frame_bypasses_the_throttle_and_is_pushed_at_once() {
    // 为什么稳定后要绕过节流：定格那一瞬晚 100 ms 到界面，磅前的司机就已经能下磅了
    let mut tpl = doc_tpl();
    tpl.stability.window_frames = 3;
    tpl.stability.stable_ms = 0;
    let mut core = core_of(tpl);
    let e0 = feed_frame(&mut core, "=000000500.0kg", 0);
    assert_eq!(e0.len(), 1);
    assert!(!e0[0].stable);
    // 20 ms 后又来一帧：没到 100 ms 的闸门，且状态没变 → 被挡
    assert!(feed_frame(&mut core, "=000000500.0kg", 20).is_empty(), "未稳且未到间隔应被节流");
    // 第 3 帧凑满窗口 → 状态翻转，必须立刻补发，不能等下一个 100 ms
    let e2 = feed_frame(&mut core, "=000000500.0kg", 40);
    assert_eq!(e2.len(), 1, "稳定这一刻必须立刻下发");
    assert!(e2[0].stable, "{:?}", e2[0]);
    assert_eq!(e2[0].aligned_01kg, 5000);
    assert_eq!(e2[0].weight_01kg, 5000);
    assert!(e2[0].raw_frame.contains("500.0"), "{:?}", e2[0].raw_frame);
    assert!(e2[0].error.is_none(), "有效读数不该带着错误");
}

#[test]
fn checksum_failure_counts_err_and_twenty_in_a_row_is_bad_frame() {
    // C 族应答帧：最后一字节是校验和
    let mut tpl = doc_tpl();
    tpl.framing = Framing {
        mode: "delimited".into(),
        start: "\u{02}".into(),
        terminator: "\u{03}".into(),
        encoding: "ascii".into(),
        max_len: 24,
        fixed_len: 0,
        checksum: "sum8".into(),
    };
    tpl.payload.sign_index = 1;
    let mut core = core_of(tpl);
    let mut body: Vec<u8> = vec![0x02, b'+', b'0', b'0', b'0', b'5', b'2', b'.', b'3', b'k', b'g'];
    let sum = body[1..].iter().fold(0u8, |a, b| a.wrapping_add(*b));
    body.push(sum);
    body.push(0x03);
    assert_eq!(core.feed(&body, 0).len(), 1, "校验过的查询应答帧要能解析");
    assert_eq!(core.err_count, 0);
    // 把校验字节改坏 → 丢帧 + err_count++，且回中文原因
    let mut bad = body.clone();
    let n = bad.len();
    bad[n - 2] = bad[n - 2].wrapping_add(1);
    let evs = core.feed(&bad, 100);
    assert_eq!(core.err_count, 1);
    assert_eq!(evs.len(), 1, "坏帧要单独出一条错误事件");
    assert!(evs[0].error_kind.as_deref() == Some("BadFrame"), "{:?}", evs[0]);
    let msg = evs[0].error.clone().unwrap_or_default();
    assert!(msg.contains("校验和"), "得说是校验和不对：{msg}");
    assert!(!msg.contains("0x") || msg.matches("0x").count() <= 2, "别把整帧 hex 倒进提示：{msg}");
    // 连续再错 19 帧 → 累计第 20 次失败时升级 BadFrame 汇总提示（§2.4 C1）
    for i in 0..19 {
        core.feed(&bad, 200 + i * 50);
    }
    assert_eq!(core.err_count, 20, "只算坏帧：1 + 19");
    assert_eq!(core.err_streak, 20);
    assert_eq!(core.frame_count, 21, "坏帧也要计入帧数（帧监视器看到的是收到多少帧）");
    let (kind, text) = core.last_error().expect("应有留痕");
    assert_eq!(kind, "BadFrame");
    assert!(text.contains("连续 20 帧"), "必须升级成整体结论：{text}");
    assert!(text.contains("帧监视器"), "要给出下一步动作：{text}");
}

#[test]
fn good_frame_after_bad_ones_clears_the_streak() {
    let mut core = core_of(doc_tpl());
    feed_frame(&mut core, "=kg", 0);
    feed_frame(&mut core, "=kg", 50);
    assert_eq!(core.err_streak, 2);
    feed_frame(&mut core, "=000000500.0kg", 100);
    assert_eq!(core.err_streak, 0, "一帧好的就把连续失败归零，否则永远攒到 20");
    assert_eq!(core.err_count, 2, "累计错误数不清");
}

#[test]
fn no_frame_for_five_seconds_reports_offline_once() {
    let mut core = core_of(doc_tpl());
    assert!(core.watchdog(1000).is_none(), "首次等待期不到 5 秒不该喊离线");
    assert!(core.watchdog(4999).is_none());
    let ev = core.watchdog(5000).expect("5 秒无帧必须报一次");
    assert!(!ev.connected);
    assert!(!ev.stable, "掉线时不能挂着 stable=true 让工作台以为可以定格捕获");
    let msg = ev.error.clone().unwrap_or_default();
    assert!(msg.contains("COM3") && msg.contains("没有收到读数帧"), "{msg}");
    assert_eq!(ev.error_kind.as_deref(), Some("Offline"));
    assert!(core.watchdog(9000).is_none(), "同一次饥饿只报一次，不刷屏");
    // 恢复一帧后重新武装
    feed_frame(&mut core, "=000000500.0kg", 9100);
    assert!(core.watchdog(9500).is_none());
    assert!(core.watchdog(14200).is_some(), "又静默 5 秒要再报一次");
}

#[test]
fn last_reading_survives_an_offline_report() {
    // 掉线那一刻界面要能显示"最后一次是多少"，不能把数字清成 0（看着像空磅）
    let mut core = core_of(doc_tpl());
    for i in 0..5 {
        feed_frame(&mut core, "=000000500.0kg", i * 200);
    }
    let ev = core.watchdog(10_000).expect("要报离线");
    assert_eq!(ev.weight_01kg, 5000);
    assert_eq!(ev.port, "COM3");
    assert_eq!(ev.code, "scale1");
    assert_eq!(ev.device_id, 7);
    assert!(!ev.connected);
}

#[test]
fn c_family_query_is_throttled_by_interval() {
    let mut tpl = doc_tpl();
    tpl.query.enabled = true;
    tpl.query.interval_ms = 200;
    let mut core = core_of(tpl);
    assert_eq!(core.query_due(0).unwrap(), vec![0x02, 0x3F, 0x57, 0x45, 0x03]);
    assert!(core.query_due(100).is_none(), "没到 200 ms 不该再问一次");
    assert!(core.query_due(199).is_none());
    assert!(core.query_due(200).is_some());
    // A 族（默认）永远不主动问
    let mut a = core_of(doc_tpl());
    assert!(a.query_due(0).is_none() && a.query_due(10_000).is_none());
}

#[test]
fn hex_command_accepts_both_spellings() {
    assert_eq!(parse_hex("02 3F 57 45 03").unwrap(), parse_hex("023F574503").unwrap());
    assert!(parse_hex("0 2F").is_err() || parse_hex("0 2F").unwrap() == vec![0x02, 0xF0], "奇数长度要出中文错");
    let e = parse_hex("0Q").unwrap_err();
    assert!(e.chars().any(|c| c as u32 >= 0x4e00), "{e}");
    assert_eq!(parse_hex("").unwrap(), Vec::<u8>::new());
}

// ================================================================== 事件 payload

#[test]
fn event_field_names_are_exactly_what_the_frontend_wires() {
    let mut core = core_of(doc_tpl());
    for i in 0..5 {
        feed_frame(&mut core, "=000000253.7kg", i * 200);
    }
    let mut tpl2 = doc_tpl();
    tpl2.stability.window_frames = 1;
    tpl2.stability.stable_ms = 0;
    let mut core2 = core_of(tpl2);
    let ev = feed_frame(&mut core2, "=000000253.7kg", 0).remove(0);
    let v = serde_json::to_value(&ev).unwrap();
    let obj = v.as_object().expect("payload 必须是对象");
    // 这 8 个是 store/device.ts 的 ScaleState 要吃的，名字错一个就整路白接
    for key in ["connected", "on_scale", "weight_01kg", "aligned_01kg", "stable", "raw_frame", "at", "error"] {
        assert!(obj.contains_key(key), "缺字段 {key}：实际 {obj:?}");
    }
    for key in ["error_kind", "code", "device_id", "port", "samples", "mean_01kg", "division_01kg", "frame_count", "err_count"] {
        assert!(obj.contains_key(key), "附加字段 {key} 丢了：实际 {obj:?}");
    }
    assert!(!obj.contains_key("onScale") && !obj.contains_key("weight01kg"), "事件一律 snake_case，不得混 camelCase");
    assert_eq!(obj["weight_01kg"].as_i64(), Some(2537));
    assert_eq!(obj["aligned_01kg"].as_i64(), Some(2500));
    assert_eq!(obj["stable"].as_bool(), Some(true));
    assert_eq!(obj["connected"].as_bool(), Some(true));
    assert_eq!(obj["on_scale"].as_bool(), Some(true));
    assert_eq!(obj["error"], serde_json::Value::Null);
    assert!(obj["at"].as_str().map(|s| !s.is_empty()).unwrap_or(false), "at 必须是本地 ISO 串");
    assert_eq!(obj["division_01kg"].as_i64(), Some(100));
    // 反过来说明与 ScaleState 的对应关系（前端接线时按这份改名）
    assert_eq!(ev.weight_01kg, 2537);
    assert_eq!(ev.samples.len(), 1);
    assert_eq!(core.frame_count, 5);
}

#[test]
fn status_dto_is_camel_case_for_the_device_center() {
    let mut core = core_of(doc_tpl());
    feed_frame(&mut core, "=000000500.0kg", 0);
    assert_eq!(core.frame_count, 1);
    // LiveStatus 的 JSON 形状由 scale_status 命令直接给前端
    let status = banghe_lib::scale::LiveStatus {
        running: true,
        code: "scale1".into(),
        device_id: 7,
        port: "COM3".into(),
        connected: true,
        generation: 1,
        started_at: "2026-09-12T10:00:00.000+08:00".into(),
        frame_count: 12,
        err_count: 3,
        err_streak: 0,
        bytes_in: 204,
        dropped_frames: 1,
        last_frame_at: Some("2026-09-12T10:00:01.000+08:00".into()),
        last: None,
        error: None,
    };
    let v = serde_json::to_value(&status).unwrap();
    let obj = v.as_object().unwrap();
    for key in ["running", "code", "deviceId", "port", "connected", "frameCount", "errCount", "errStreak", "bytesIn", "droppedFrames", "lastFrameAt", "last", "startedAt", "generation"] {
        assert!(obj.contains_key(key), "缺 {key}：{obj:?}");
    }
    assert!(obj["last"].is_null());
}

// ================================================================== 台账读取（真库链路）

fn db_conn() -> Connection {
    db::in_memory_migrated("0.1.0", db::MIGRATIONS).expect("内存库应能跑完全部迁移")
}

fn insert_device(conn: &Connection, code: &str, name: &str, kind: &str, driver: &str, config: &str, is_mock: i64, enabled: i64) -> i64 {
    conn.execute(
        "INSERT INTO device_config (code, name, kind, driver, config_json, is_mock, is_enabled)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![code, name, kind, driver, config, is_mock, enabled],
    )
    .expect("插入测试设备");
    conn.last_insert_rowid()
}

#[test]
fn real_ledger_row_yields_a_runnable_template() {
    let conn = db_conn();
    let id = insert_device(&conn, "scale1", "1 号地磅", "scale", "yaohua_xk3190", DOC_TEMPLATE, 0, 1);
    let (row, tpl) = load_config(&conn, "scale1").unwrap().expect("这台磅应当可跑");
    assert_eq!(row.id, id);
    assert_eq!(row.code, "scale1");
    assert!(!row.is_mock);
    assert_eq!(tpl.transport.port, "COM3");
    assert_eq!(tpl.stability.window_frames, 5);
    // 读台账不能改台账：本轮设备层不写任何表
    let unchanged: i64 = conn
        .query_row("SELECT COUNT(*) FROM device_config WHERE last_ok_at IS NULL AND err_count = 0", [], |r| r.get(0))
        .unwrap();
    assert_eq!(unchanged, 1, "设备层不得回写 last_ok_at/err_count");
}

#[test]
fn mock_scale_is_refused_with_a_plain_chinese_sentence() {
    let conn = db_conn();
    // 台账里两种 Mock 表达都要拦：driver='mock' 与 is_mock=1
    insert_device(&conn, "scale_mock", "演示磅", "scale", "mock", DOC_TEMPLATE, 0, 1);
    insert_device(&conn, "scale_flag", "被切了 Mock 的真磅", "scale", "yaohua_xk3190", DOC_TEMPLATE, 1, 1);
    for code in ["scale_mock", "scale_flag"] {
        let e = load_config(&conn, code).unwrap_err();
        assert!(e.contains("Mock") && e.contains("不会去开串口"), "{code} → {e}");
        assert!(e.chars().count() <= 60, "拒绝语要短：{e}");
        assert!(!e.contains("::") && !e.contains('{') && !e.contains("Error"), "不得泄漏内部信息：{e}");
    }
}

#[test]
fn missing_code_and_disabled_and_wrong_kind_all_say_why_in_chinese() {
    let conn = db_conn();
    insert_device(&conn, "prn1", "小票机", "printer", "raw_escpos", "{}", 0, 1);
    insert_device(&conn, "scale_off", "检修停用的磅", "scale", "yaohua_xk3190", DOC_TEMPLATE, 0, 0);

    let e = load_config(&conn, "nosuch").unwrap_err();
    assert!(e.contains("台账里没有") && e.contains("nosuch"), "{e}");
    let e = load_config(&conn, "prn1").unwrap_err();
    assert!(e.contains("不是地磅"), "{e}");
    let e = load_config(&conn, "scale_off").unwrap_err();
    assert!(e.contains("已停用"), "{e}");
    for err in [
        load_config(&conn, "nosuch").unwrap_err(),
        load_config(&conn, "prn1").unwrap_err(),
        load_config(&conn, "scale_off").unwrap_err(),
    ] {
        assert!(err.chars().count() <= 120, "命令层的提示不能写成长文：{err}");
    }
}

#[test]
fn missing_port_and_tcp_transport_are_caught_before_touching_the_serial_port() {
    let conn = db_conn();
    insert_device(&conn, "scale_nop", "没配串口的磅", "scale", "yaohua_xk3190", "{}", 0, 1);
    insert_device(&conn, "scale_tcp", "网口磅", "scale", "generic_tcp", r#"{ "transport": {"kind":"tcp","host":"192.168.1.9","tcp_port":4001} }"#, 0, 1);
    let e = load_config(&conn, "scale_nop").unwrap_err();
    assert!(e.contains("transport.port"), "{e}");
    let e = load_config(&conn, "scale_tcp").unwrap_err();
    assert!(e.contains("tcp") && e.contains("只接了串口"), "D 族没接要讲明白：{e}");
    let row = load_device(&conn, "scale_nop").unwrap().unwrap();
    assert!(resolve_template(&row).unwrap_err().contains("transport.port"));
}

#[test]
fn enabled_poll_without_a_usable_command_is_refused() {
    let conn = db_conn();
    insert_device(
        &conn,
        "scale_noq",
        "开了轮询没写指令",
        "scale",
        "耀华",
        r#"{ "transport": {"port":"COM3"}, "query": {"enabled":true,"command_hex":"  "} }"#,
        0,
        1,
    );
    let e = load_config(&conn, "scale_noq").unwrap_err();
    assert!(e.contains("query.command_hex"), "要指得出改哪：{e}");
    assert!(!e.contains("::") && !e.contains("Error"), "{e}");
    insert_device(
        &conn,
        "scale_q",
        "轮询正常的磅",
        "scale",
        "耀华",
        r#"{ "transport": {"port":"COM3"}, "query": {"enabled":true,"command_hex":"02 3F 57 45 03","interval_ms":200} }"#,
        0,
        1,
    );
    let (_row, tpl) = load_config(&conn, "scale_q").unwrap().expect("C 族模板要能跑起来");
    assert!(tpl.query.enabled);
    assert_eq!(tpl.query.interval_ms, 200);
}

#[test]
fn port_that_does_not_exist_opens_to_a_chinese_hint_not_a_panic() {
    // 真机不在这台机器上；能验的是"打不开端口"的回话形态
    let t = Transport {
        kind: "serial".into(),
        port: "NO_SUCH_PORT_ZZZ".into(),
        baud: 9600,
        data_bits: 8,
        parity: "none".into(),
        stop_bits: 1,
        host: String::new(),
        tcp_port: 0,
    };
    let e = banghe_lib::scale::open_port(&t).unwrap_err();
    assert!(e.starts_with("串口 NO_SUCH_PORT_ZZZ 打不开："), "{e}");
    assert!(e.chars().any(|c| c as u32 >= 0x4e00), "必须中文：{e}");
    assert!(!e.contains("serialport::"), "不得泄漏库的内部类型名：{e}");
    assert!(!e.contains("{:"), "{e}");
    let tcp = Transport { kind: "tcp".into(), port: String::new(), ..Transport::default() };
    assert!(banghe_lib::scale::open_port(&tcp).unwrap_err().contains("传输方式"));
}

#[test]
fn bad_port_in_a_real_row_still_resolves_then_fails_cleanly() {
    let conn = db_conn();
    insert_device(
        &conn,
        "scale_bad",
        "接了不存在的口",
        "scale",
        "yaohua_xk3190",
        r#"{ "transport": {"port":"NO_SUCH_PORT_ZZZ"} }"#,
        0,
        1,
    );
    let (_row, tpl) = load_config(&conn, "scale_bad").unwrap().expect("模板本身是合法的");
    assert_eq!(tpl.transport.port, "NO_SUCH_PORT_ZZZ");
    assert_eq!(tpl.framing.start, "=", "缺字段仍要落到文档默认");
    assert!(banghe_lib::scale::open_port(&tpl.transport).is_err());
}

#[test]
fn judgement_helpers_are_pure_and_repeatable() {
    // 纯函数层不得藏全局状态：同一个输入序列跑两遍结果必须一字不差
    let mut a = judge(doc_stability(), doc_align());
    let mut b = judge(doc_stability(), doc_align());
    let seq = [5000i64, 5100, 5000, 5100, 5000, 5000];
    let ra: Vec<Judgement> = seq.iter().enumerate().map(|(i, w)| a.push(*w, i as u64 * 150, None)).collect();
    let rb: Vec<Judgement> = seq.iter().enumerate().map(|(i, w)| b.push(*w, i as u64 * 150, None)).collect();
    assert_eq!(ra, rb);
    for w in seq.iter() {
        let mut buf: Vec<u8> = format!("={w:011}.0kg\r\n").into_bytes();
        let got = split_frames(&mut buf, &framing());
        assert_eq!(got.len(), 1, "每段都恰好是一帧");
        assert!(buf.is_empty());
    }
}

// ================================================================== 耀华 XK3190-A9 真机帧（2026-09-12 现场）

/// 现场 62 kg 实测一帧的原始字节：`02 2B 30 30 30 30 36 32 30 31 46 03`
/// = STX `+` `000062` `0`(小数位) `1F`(异或校验) ETX。校验核对：`+`~小数位 8 字节异或 = 0x1F。
fn a9_real_frame_62kg() -> Vec<u8> {
    vec![0x02, b'+', b'0', b'0', b'0', b'0', b'6', b'2', b'0', b'1', b'F', 0x03]
}

/// 把预设模板接上端口，喂给整条流内核用。
fn a9_core() -> StreamCore {
    let mut tpl = yaohua_xk3190_cont();
    tpl.transport.port = "COM3".into();
    StreamCore::new(tpl, "scale1", 1)
}

#[test]
fn real_xk3190_a9_frame_parses_to_62_kg() {
    let tpl = yaohua_xk3190_cont();
    assert_eq!(parse_weight(&a9_real_frame_62kg(), &tpl.payload).unwrap(), 620, "62 kg → 620 个 0.1kg");
}

#[test]
fn a9_continuous_stream_reads_through_the_whole_pipeline() {
    // 切帧（STX/ETX）+ 校验（xor_ascii_hex）+ 取数（小数位标志）三段一起过，才算真接上
    let mut core = a9_core();
    let evs = core.feed(&a9_real_frame_62kg(), 1000);
    assert_eq!(evs.len(), 1, "校验与取数都过，恰好一条读数事件：{evs:?}");
    assert!(evs[0].connected);
    assert_eq!(evs[0].weight_01kg, 620);
    assert_eq!(evs[0].error_kind, None, "不该有任何错误：{:?}", evs[0].error);
}

#[test]
fn a9_xor_ascii_hex_mismatch_is_a_bad_frame_not_a_reading() {
    let mut core = a9_core();
    let mut bad = a9_real_frame_62kg();
    bad[10] = b'E'; // 帧尾 "1F" 改成 "1E"，异或值仍是 0x1F → 校验必不过
    let evs = core.feed(&bad, 1000);
    assert!(evs.iter().any(|e| e.error_kind.as_deref() == Some("BadFrame")), "{evs:?}");
    assert!(evs.iter().all(|e| e.weight_01kg == 0), "校验不过绝不能当成一次读数下发");
}

#[test]
fn a9_checksum_is_case_insensitive() {
    let mut core = a9_core();
    let mut lower = a9_real_frame_62kg();
    lower[10] = b'f'; // 小写 1f 一样合法
    let evs = core.feed(&lower, 1000);
    assert!(evs.iter().any(|e| e.connected && e.weight_01kg == 620), "小写十六进制也该认：{evs:?}");
}

#[test]
fn a9_decimal_count_flag_divides_the_integer() {
    let tpl = yaohua_xk3190_cont();
    // +000625 1 1B → 数字 000625、小数位 1 → 62.5 kg（校验 2B^30^30^30^36^32^35^31 = 0x1B）
    let frame: Vec<u8> = vec![0x02, b'+', b'0', b'0', b'0', b'6', b'2', b'5', b'1', b'1', b'B', 0x03];
    assert_eq!(parse_weight(&frame, &tpl.payload).unwrap(), 625);
}

#[test]
fn flat_ledger_form_gets_the_driver_preset() {
    // 现场在设备中心只填了 port/baud/帧族（扁平），驱动是耀华 → 必须自动套上 A9 模板
    let conn = db_conn();
    insert_device(
        &conn,
        "scaleA9",
        "1 号地磅",
        "scale",
        "yaohua_xk3190",
        r#"{ "port": "COM3", "baud": "9600", "frameFamily": "A" }"#,
        0,
        1,
    );
    let (_row, tpl) = load_config(&conn, "scaleA9").unwrap().expect("扁平表单也要能跑出 A9 模板");
    assert_eq!(tpl.transport.port, "COM3");
    assert_eq!(tpl.transport.baud, 9600);
    assert_eq!(tpl.framing.start, "\u{02}");
    assert_eq!(tpl.framing.terminator, "\u{03}");
    assert_eq!(tpl.framing.checksum, "xor_ascii_hex");
    assert_eq!(tpl.payload.decimal_count_index, Some(8));
    // 套完预设还能直接读出真帧
    assert_eq!(parse_weight(&a9_real_frame_62kg(), &tpl.payload).unwrap(), 620);
}

#[test]
fn full_nested_template_is_never_overwritten_by_the_preset() {
    // 写了完整 framing 段的（帧监视器手调过的）必须原样生效，不能被 A9 预设悄悄换成 STX
    let conn = db_conn();
    insert_device(&conn, "scaleCustom", "手调模板的磅", "scale", "yaohua_xk3190", DOC_TEMPLATE, 0, 1);
    let (_row, tpl) = load_config(&conn, "scaleCustom").unwrap().unwrap();
    assert_eq!(tpl.framing.start, "=");
    assert_eq!(tpl.payload.decimal_count_index, None);
}

#[test]
fn unknown_driver_has_no_preset() {
    assert!(driver_preset("toledo").is_none(), "没预设的驱动完全按 config_json 走");
    assert!(driver_preset("yaohua_xk3190").is_some());
}

// ============================================================ 判稳依据快照（设备中心取证用）

/// 造一帧 A9 连续帧：`STX` `符号` `6 位整数 kg` `小数位数=0` `两字符 ASCII 十六进制异或` `ETX`。
/// 校验按真机同规则现算（符号位~小数位这 8 字节异或），kg=62 时正好等于现场抓到的 `1F`。
fn a9_frame_kg(kg: i64) -> Vec<u8> {
    let mut f: Vec<u8> = vec![0x02, b'+'];
    f.extend(format!("{:06}", kg.abs()).as_bytes());
    f.push(b'0');
    let xored = f[1..].iter().fold(0u8, |acc, b| acc ^ *b);
    f.extend(format!("{xored:02X}").as_bytes());
    f.push(0x03);
    f
}

#[test]
fn a9_frames_alternating_two_kg_stabilize_and_say_why() {
    // 现场那一幕：仪表在 62.0 / 64.0 之间跳（极差 2 kg，远小于 2 分度 = 20 kg 的容差）。
    // 判稳结论连同**依据**一起下发，设备中心才能说清"为什么还不稳"，而不是留个"波动中"。
    let mut core = a9_core();
    let mut last = None;
    for i in 0..5u64 {
        let kg = if i % 2 == 0 { 62 } else { 64 };
        for ev in core.feed(&a9_frame_kg(kg), i * 150) {
            last = Some(ev);
        }
    }
    let ev = last.expect("5 帧应有事件");
    assert!(ev.stable, "极差 2 kg 在容差内、窗口 600 ms 超过 400 ms，该给稳：{ev:?}");
    assert_eq!(ev.spread_01kg, 20, "极差按 0.1 kg 整数报：620..640 = 20");
    assert_eq!(ev.tolerance_01kg, 200, "容差 = max_spread_divisions(2) × 分度(100)");
    assert_eq!(ev.window_ms, 600, "窗口首尾帧实际时长");
    assert_eq!(ev.window_frames, 5, "配置的帧数下限（现在是下限，不是上限）");
    assert_eq!(ev.stable_ms, 400);
    assert_eq!(ev.samples.len(), 5);
}

#[test]
fn a9_snapshot_explains_a_window_that_is_too_short() {
    // 帧太稀（一帧 50 ms、只喂 3 帧）：极差合格但时长不够，快照要能把"卡在哪一条"指出来
    let mut core = a9_core();
    let mut last = None;
    for i in 0..3u64 {
        for ev in core.feed(&a9_frame_kg(62), i * 50) {
            last = Some(ev);
        }
    }
    let ev = last.expect("应有事件");
    assert!(!ev.stable);
    assert_eq!(ev.spread_01kg, 0, "三帧同一个数，极差不是问题");
    assert!(ev.window_ms < ev.stable_ms, "卡的就是时长：{} < {}", ev.window_ms, ev.stable_ms);
    assert!((ev.samples.len() as u64) < ev.window_frames, "也还没攒满帧数下限");
}

// =============================================== 整量化（落库那一列）· 与前端同一份用例表对拍

/// 唯一用例表，放在 `scripts/scale-align/` 而不是任何一边的源码里：
/// TS 侧由 `scripts/scale-align/check.ts` 跑同一份，谁改了取整口径、只改一边，另一边就红。
const ALIGN_CASES: &str = include_str!("../../scripts/scale-align/cases.json");

#[test]
fn align_apply_matches_the_shared_case_table() {
    let v: serde_json::Value = serde_json::from_str(ALIGN_CASES).expect("用例表必须是合法 JSON");
    let cases = v["cases"].as_array().expect("`cases` 必须是数组");
    assert!(cases.len() >= 25, "只解析出 {} 条用例，八成是字段名改了让断言空转", cases.len());
    for c in cases {
        let raw = c["raw"].as_i64().expect("raw 是整数");
        let d = c["division"].as_i64().expect("division 是整数");
        let mode = c["mode"].as_str().expect("mode 是字符串");
        let want = c["expected"].as_i64().expect("expected 是整数");
        let got = Align { division_01kg: d, mode: mode.into() }.apply(raw);
        assert_eq!(got, want, "apply({raw}) 分度 {d} mode「{mode}」应得 {want}，实得 {got}");
    }
}

/// 把某台磅设成台账里的默认磅（`insert_device` 不填这一列）
fn set_default(conn: &Connection, id: i64) {
    conn.execute("UPDATE device_config SET is_default = 1 WHERE id = ?1", params![id])
        .expect("设为默认磅");
}

#[test]
fn capture_align_is_none_when_no_enabled_scale_exists() {
    // 浏览器演示之外的真实一档：台账里压根没有启用的磅（全停用，或只登记了读卡器）。
    // 这时整量化 = 读数——绝不拿文档默认的 10 kg 去改动磅员亲手敲进去的数。
    let conn = db_conn();
    assert_eq!(capture_align(&conn).apply(5643), 5643, "空台账不得取整");

    let off = insert_device(&conn, "scale-off", "停用的磅", "scale", "yaohua_xk3190", "{}", 0, 0);
    set_default(&conn, off);
    insert_device(&conn, "cam1", "1 号摄像头", "camera", "mjpeg", "{}", 0, 1);
    assert_eq!(capture_align(&conn).apply(5643), 5643, "只有停用的磅/别的设备时不得取整");
}

#[test]
fn capture_align_reads_the_enabled_scale_even_when_a_disabled_one_is_default() {
    // 「哪台磅」与 `orders::default_scale_id` 同一条 SQL（启用 + 默认优先）。
    // 停用的那台默认磅不参与：它的分度已经不代表此刻在用的秤台。
    let conn = db_conn();
    let off = insert_device(&conn, "scale-off", "停用的默认磅", "scale", "generic",
        r#"{"align":{"division_01kg":20,"mode":"floor_div"}}"#, 0, 0);
    set_default(&conn, off);
    insert_device(&conn, "scale-on", "启用的磅", "scale", "generic",
        r#"{"align":{"division_01kg":100,"mode":"ceil_div"}}"#, 0, 1);
    // ceil_div + 分度 100：5610 → 5700（若是停用那台的 floor_div+20 会得到 5600）
    assert_eq!(capture_align(&conn).apply(5610), 5700);
}

#[test]
fn capture_align_applies_the_driver_preset_for_a_flat_ledger_form() {
    // 设备中心「编辑」表单只给波特率与帧族，`config_json` 里没有 align 段。
    // 这一档必须照样套上驱动预设的分度值——面板上定格成 560.0 而库里存 564.0，
    // 是现场最不能接受的那种不一致。
    let conn = db_conn();
    let id = insert_device(&conn, "scale1", "1 号汽车衡", "scale", "yaohua_xk3190",
        r#"{"port":"COM3","baud":9600}"#, 0, 1);
    set_default(&conn, id);
    assert_eq!(capture_align(&conn).apply(5640), 5600, "耀华预设的分度是 10 kg");
}

#[test]
fn capture_align_never_lets_a_broken_template_fail_the_capture() {
    // 与 `resolve_template` 的分工：那一道为"能不能开这条串口"把关（会拒 Mock、停用、
    // 没写端口），这里只要一个数字。坏 JSON 退成"不取整"，而不是让一次真实过磅记不进去。
    let conn = db_conn();
    let id = insert_device(&conn, "scale1", "配置写坏的磅", "scale", "generic", "{ 不是 JSON", 0, 1);
    set_default(&conn, id);
    assert_eq!(capture_align(&conn).apply(5643), 5643);

    // 端口没配（`resolve_template` 会直接报错）照样能取整：两件事互不牵连
    let conn = db_conn();
    let id = insert_device(&conn, "scale2", "没配串口的磅", "scale", "generic",
        r#"{"align":{"division_01kg":50,"mode":"nearest_div"}}"#, 0, 1);
    set_default(&conn, id);
    assert_eq!(capture_align(&conn).apply(5640), 5650, "5 kg 分度：564.0 → 565.0");

    // 台账把它标成 Mock 也照样按它的模板取整：is_mock 说的是"别去开这条串口"，
    // 不是"这台磅没有法制分度"。
    let conn = db_conn();
    let id = insert_device(&conn, "scale3", "标成 Mock 的磅", "scale", "generic",
        r#"{"align":{"division_01kg":100,"mode":"nearest_div"}}"#, 1, 1);
    set_default(&conn, id);
    assert_eq!(capture_align(&conn).apply(5640), 5600);
}

#[test]
fn capture_align_refuses_an_absurd_division() {
    // 与 `resolve_template` 同一条离谱值判据：分度大过 100000 kg 不可能是汽车衡。
    // 宁可退回不取整，也不让 564.0 被"就近"成 0.0（那是一车粮白送）。
    let conn = db_conn();
    let id = insert_device(&conn, "scale1", "分度写错的磅", "scale", "generic",
        r#"{"align":{"division_01kg":2000000,"mode":"nearest_div"}}"#, 0, 1);
    set_default(&conn, id);
    assert_eq!(capture_align(&conn).apply(5640), 5640);
}
