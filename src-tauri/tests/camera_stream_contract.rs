//! 实时画面那条 RTSP/H.264 通道（`src-tauri/src/camera_stream.rs`）的契约守卫。
//!
//! 为什么这里要这么细：这条路径**在本机编译不了也跑不了**（要 openh264 的 C 源码、要真摄像机），
//! 而它出的每一个错在磅房都表现为"那一格没有画面"。所以凡是不碰 socket、不碰解码器就能判的
//! 事，全部在这里用合成字节钉死：
//!
//!  1. **请求字节**：RTSP 的 Digest 按 method + **完整 rtsp:// URI** 签，请求行写错一个字
//!     现场就只有一句 401；CSeq / Session / 头的顺序钉下来。
//!  2. **收包分帧**：`$` 交织帧与文本响应混在同一条 TCP 上，且**必然被切碎**——切在哪都要
//!     能续上，一条消息都不许丢（丢一个 RTP 包就是丢半帧）。保活的裸 CRLF 要剥掉。
//!  3. **SDP 选轨**：音频轨也带 `a=control`，抓错就永远等不来画面；只认 H.264，H.265 要回
//!     "去把子码流改成 H.264"这句人话；轨道地址指别人的地址一律拒（台账这台机不能被拿去拉内网）。
//!  4. **RTP → NAL**：单 NAL / STAP-A / FU-A 三种打包、时间戳换帧、marker 收尾、
//!     半截 FU-A 必须整片丢而不是塞给解码器。
//!  5. **关键帧闸门**：没有 IDR 就不出画（花屏比黑屏更坏）。
//!  6. **端点从哪来**：`rtspUrl` 的两种写法、路径大小写（RTSP 区分大小写）、以及
//!     "host 只认台账那台"这一条——地址是这台机唯一能被外人左右的输入面。
//!
//! 真正联网那一半（`Session::call`、握手、解码、推 IPC）**不在这里跑**：没有摄像头，
//! 跑一次就是把测试挂在现场网络与一台不存在的 IP 上。

use banghe_lib::camera::parse_http_head;
use banghe_lib::camera_stream::{
    derive_rtsp_path, has_idr, interleaved_channels, is_auth_failure, join_control, nal_type, next_msg, parse_rtp,
    rtsp_failure, rtsp_path_from_url, rtsp_request, session_id, session_timeout_secs, video_track, H264Stream,
    RtspMsg, NAL_IDR, PHASE_CONNECTING, PHASE_ERROR, PHASE_KEYFRAME, PHASE_STREAMING,
};

/// 一条 `$` 交织帧：`$` + 通道 + u16 大端长度 + RTP 包。
fn interleaved(channel: u8, packet: &[u8]) -> Vec<u8> {
    let n = packet.len() as u16;
    let mut v = vec![0x24, channel, (n >> 8) as u8, n as u8];
    v.extend_from_slice(packet);
    v
}

/// 一个最小 RTP 头（V=2、无 CSRC/扩展/填充）+ 载荷。
fn rtp_packet(pt: u8, seq: u16, ts: u32, marker: bool, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![
        0x80,
        pt | if marker { 0x80 } else { 0 },
        (seq >> 8) as u8,
        seq as u8,
        (ts >> 24) as u8,
        (ts >> 16) as u8,
        (ts >> 8) as u8,
        ts as u8,
        0,
        0,
        0,
        0,
    ];
    v.extend_from_slice(payload);
    v
}

/// 一个 NAL：`type | 0x60`（NRI=3）+ 载荷。真实流里 NRI 不影响本模块的判断，够用了。
fn nal(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut v = vec![(kind & 0x1F) | 0x60];
    v.extend_from_slice(body);
    v
}

/// 把缓冲里能凑出的消息全部取走（真机就是一次 read 收到好几条）。
fn drain(buf: &mut Vec<u8>) -> Vec<RtspMsg> {
    let mut out = Vec::new();
    while let Some(msg) = next_msg(buf).expect("合成字节不该判成协议错误") {
        out.push(msg);
    }
    out
}

/// 喂一个 RTP 包给 H.264 组帧器，回它凑出的访问单元。
fn push_rtp(s: &mut H264Stream, packet: &[u8]) -> Vec<Vec<Vec<u8>>> {
    let r = parse_rtp(packet).expect("合法 RTP 头");
    s.feed(r.payload, r.timestamp, r.marker)
}

// ============================================================ 请求字节

#[test]
fn rtsp_request_line_carries_method_uri_cseq_session_and_terminator() {
    let req = rtsp_request(
        "PLAY",
        "rtsp://192.168.10.199:554/Streaming/Channels/102",
        7,
        Some("12345678;timeout=60"),
        Some("Digest username=\"admin\""),
        &[("Range", "npt=0.000-")],
    );
    let text = String::from_utf8(req.clone()).expect("请求全是 ASCII");
    let lines: Vec<&str> = text.split("\r\n").collect();
    // User-Agent 带打包版本号，逐字钉它等于给每次发版都改测试，所以只把它挑出来
    let ua = lines.iter().position(|l| l.starts_with("User-Agent: ")).expect("有 UA");
    assert_eq!(lines[0], "PLAY rtsp://192.168.10.199:554/Streaming/Channels/102 RTSP/1.0");
    assert_eq!(lines[1], "CSeq: 7");
    assert_eq!(lines[2], "Session: 12345678;timeout=60");
    assert_eq!(lines[3], "Range: npt=0.000-");
    assert_eq!(lines[4], "Authorization: Digest username=\"admin\"");
    assert_eq!(ua, 5, "UA 在所有业务头之后");
    assert_eq!(lines.len(), 8, "六行 + CRLFCRLF 切出来的两个空串");
    assert!(lines[6].is_empty() && lines[7].is_empty(), "末尾是 CRLFCRLF");
    assert!(text.ends_with("\r\n\r\n"));
    assert!(!text.contains("RTSP/1.1"), "固件按 1.0 解析请求行");
}

#[test]
fn rtsp_request_omits_session_and_authorization_when_absent() {
    // DESCRIBE 是第一趟：没有 Session 号也没有认证头，多一行都算结构错
    let req = rtsp_request("DESCRIBE", "rtsp://h/Streaming/Channels/102", 1, None, None, &[("Accept", "application/sdp")]);
    let text = String::from_utf8(req).unwrap();
    assert!(!text.contains("Session:"));
    assert!(!text.contains("Authorization:"));
    assert!(text.contains("Accept: application/sdp"));
}

// ============================================================ 收包分帧

#[test]
fn interleaved_frame_survives_being_cut_in_half() {
    let packet = rtp_packet(96, 1, 1000, true, &nal(5, &[1, 2, 3]));
    let frame = interleaved(0, &packet);
    let mut buf: Vec<u8> = Vec::new();

    buf.extend_from_slice(&frame[..3]);
    assert!(drain(&mut buf).is_empty(), "连 4 字节帧头都没收齐");
    buf.extend_from_slice(&frame[3..frame.len() - 2]);
    assert!(drain(&mut buf).is_empty(), "包体还差 2 字节");
    buf.extend_from_slice(&frame[frame.len() - 2..]);

    let msgs = drain(&mut buf);
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0], RtspMsg::Interleaved { channel: 0, packet });
    assert!(buf.is_empty(), "取完就该是空的，不留半截");
}

#[test]
fn several_frames_in_one_read_come_out_in_order() {
    let a = interleaved(0, &rtp_packet(96, 1, 1000, false, &nal(7, &[0])));
    let b = interleaved(0, &rtp_packet(96, 2, 1000, true, &nal(8, &[0])));
    let c = interleaved(2, b"x"); // 另一路（RTCP 或音频）也照序出来，由 Player 过滤
    let mut buf = Vec::new();
    buf.extend_from_slice(&a);
    buf.extend_from_slice(&b);
    buf.extend_from_slice(&c);
    let msgs = drain(&mut buf);
    assert_eq!(msgs.len(), 3);
    let chans: Vec<u8> = msgs
        .iter()
        .map(|m| match m {
            RtspMsg::Interleaved { channel, .. } => *channel,
            _ => panic!("不该有响应"),
        })
        .collect();
    assert_eq!(chans, vec![0, 0, 2]);
}

#[test]
fn bare_crlf_keepalives_are_stripped_not_misread() {
    // 保活响应就是四个裸字节；不剥掉会被当成"看不出协议"，好流会被判成掉线重连
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(b"\r\n\r\n\r\n");
    assert!(drain(&mut buf).is_empty());
    buf.extend_from_slice(b"RTSP/1.0 200 OK\r\nCSeq: 9\r\n\r\n");
    let msgs = drain(&mut buf);
    assert_eq!(msgs.len(), 1);
    match &msgs[0] {
        RtspMsg::Response(head, body) => {
            assert_eq!(head.status, 200);
            assert_eq!(head.content_length.unwrap_or(0), 0);
            assert!(body.is_empty());
        }
        _ => panic!("该是一条响应"),
    }
}

#[test]
fn response_body_is_returned_whole_even_when_split() {
    let head = "RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Type: application/sdp\r\nContent-Length: 10\r\n\r\n";
    let all = [head.as_bytes(), b"v=0\r\nm=vid"].concat();
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(&all[..all.len() - 4]);
    assert!(drain(&mut buf).is_empty(), "body 没到齐就先别交出去");
    buf.extend_from_slice(&all[all.len() - 4..]);
    let msgs = drain(&mut buf);
    assert_eq!(msgs.len(), 1);
    match &msgs[0] {
        RtspMsg::Response(h, body) => {
            assert_eq!(h.content_length, Some(10));
            assert_eq!(body, b"v=0\r\nm=vid");
            assert_eq!(h.header("content-type"), Some("application/sdp"));
        }
        _ => panic!("该是一条响应"),
    }
}

#[test]
fn absurd_content_length_is_refused_instead_of_buffered() {
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(b"RTSP/1.0 200 OK\r\nContent-Length: 5000000\r\n\r\n");
    assert!(next_msg(&mut buf).is_err(), "声明 5 MB 的响应要当场拒，不许攒着");
}

#[test]
fn non_rtsp_garbage_says_so() {
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    let why = next_msg(&mut buf).err().expect("第一行不是 RTSP/HTTP");
    assert!(!why.is_empty());
}

// ============================================================ 会话头解析

#[test]
fn session_header_splits_id_from_timeout() {
    assert_eq!(session_id("12345678;timeout=60"), Some("12345678"));
    assert_eq!(session_id(" ABCDEF "), Some("ABCDEF"));
    assert_eq!(session_timeout_secs("12345678;timeout=60"), Some(60));
    // 键不叫 timeout 就不能当超时用：拿它设保活钟等于把会话送给摄像机
    assert_eq!(session_timeout_secs("12345678;agent=Hikvision"), None);
    assert_eq!(session_timeout_secs("12345678"), None);
    assert_eq!(session_timeout_secs("12345678;timeout=abc"), None);
}

#[test]
fn transport_interleaved_pairs_are_read_back() {
    // 设备可以回我们没要的那对号，照它回的用
    assert_eq!(
        interleaved_channels("RTP/AVP/TCP;unicast;destination=192.168.10.5;interleaved=2-3"),
        Some((2, 3))
    );
    assert_eq!(interleaved_channels("RTP/AVP;unicast;dest_addr=\"1.2.3.4:8000\""), None);
}

// ============================================================ SDP 选轨

const BASE: &str = "rtsp://192.168.10.199:554/Streaming/Channels/102";

/// 现场那种两份媒体段的 SDP：视频是 H.264 子码流，音频轨也带着 `a=control`。
const HIK_SDP: &str = concat!(
    "v=0\r\n",
    "o=- 1757000000 2 IN IP4 127.0.0.1\r\n",
    "s=Media Session\r\n",
    "c=IN IP4 0.0.0.0\r\n",
    "t=0 0\r\n",
    "a=control:*\r\n",
    "a=range:npt=now-\r\n",
    "m=video 0 RTP/AVP 96\r\n",
    "c=IN IP4 0.0.0.0\r\n",
    "a=rtpmap:96 H264/90000\r\n",
    "a=fmtp:96 packetization-mode=1;profile-level-id=42001F;sprop-parameter-sets=Z01AKJg0JygA,aM48IA==\r\n",
    "a=control:trackID=0\r\n",
    "m=audio 0 RTP/AVP 0\r\n",
    "a=rtpmap:0 PCMU/8000\r\n",
    "a=control:trackID=1\r\n",
);

#[test]
fn video_track_is_picked_by_codec_not_by_being_last() {
    let t = video_track(BASE, HIK_SDP).expect("这条 SDP 有 H.264 视频轨");
    assert_eq!(t.payload_type, 96, "payload type 绝不能写死在代码里，但这里要钉住解析结果");
    assert_eq!(t.uri, format!("{BASE}/trackID=0"), "媒体段里的 control 优先于会话级的 *");
    assert_eq!(t.parameter_sets.len(), 2, "sprop 预带的 SPS/PPS");
    assert_eq!(nal_type(&t.parameter_sets[0]), 7, "第一个是 SPS");
    assert_eq!(nal_type(&t.parameter_sets[1]), 8, "第二个是 PPS");
    assert_eq!(has_idr(&t.parameter_sets), false, "参数集不算关键帧");
}

#[test]
fn audio_only_h265_stream_tells_the_operator_what_to_change() {
    let sdp = concat!(
        "v=0\r\nm=audio 0 RTP/AVP 0\r\na=control:trackID=1\r\n",
        "m=video 0 RTP/AVP 96\r\na=rtpmap:96 H265/90000\r\na=control:trackID=0\r\n",
    );
    let why = video_track(BASE, sdp).err().expect("只有 H.265，预览解不了");
    assert!(why.contains("H.264"), "得指出去子码流改编码：{why}");
    assert!(why.contains("子码流"), "得说清改哪一路：{why}");
}

#[test]
fn an_unusable_track_address_is_reported_as_such_not_as_a_missing_codec() {
    // 这条盯的是"报错骗人"：地址被拒时不许回"没有 H.264 轨"，
    // 那会把人引到视频参数页上去，而真问题是 SDP 指向了另一台机。
    let sdp = concat!(
        "v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n",
        "a=control:rtsp://10.0.0.9:554/Streaming/Channels/101/trackID=0\r\n",
    );
    let why = video_track(BASE, sdp).err().expect("指向别人的 SDP 要拒");
    assert!(why.contains("另一台主机"), "要说是主机不对：{why}");
    assert!(!why.contains("H.264 视频轨"), "不许赖到编码上：{why}");
}

#[test]
fn wildcard_control_setups_the_stream_uri_itself() {
    // RFC 2326 §6.2：`a=control:*` 说的是"整条会话可控"，SETUP 就打这条会话 URI 本身。
    // 当相对路径拼会得到 `<uri>/*`，海康回 404/461——界面只表现为"连上了却没画面"。
    let sdp = concat!(
        "v=0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n",
        "a=control:*\r\n",
    );
    let t = video_track(BASE, sdp).expect("通配符也是合法地址");
    assert_eq!(t.uri, BASE);
    // 只有会话级那一条时同样成立（媒体段没写 control 就退回会话级）
    let only_session = "v=0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n";
    assert_eq!(video_track(BASE, only_session).unwrap().uri, BASE);
    assert_eq!(join_control(BASE, "*").unwrap(), BASE);
    assert_eq!(join_control(BASE, " * ").unwrap(), BASE, "两端空白不算地址的一部分");
}

#[test]
fn track_control_accepts_same_host_absolute_uris() {
    let abs = format!("{BASE}/trackID=0");
    assert_eq!(join_control(BASE, &abs).unwrap(), abs);
    assert_eq!(join_control(BASE, "trackID=0").unwrap(), format!("{BASE}/trackID=0"));
    assert_eq!(join_control(BASE, "/abs/track").unwrap(), "rtsp://192.168.10.199:554/abs/track");
}

#[test]
fn track_control_refuses_other_hosts_credentials_and_header_splitting() {
    // 台账里这台好机器绝不能被拿去访问内网别的地址（SSRF 的入口就在这）
    assert!(join_control(BASE, "rtsp://10.1.2.3:554/a").is_err());
    assert!(join_control(BASE, "rtsp://admin:pw@192.168.10.199:554/a").is_err());
    assert!(join_control(BASE, "rtmp://192.168.10.199/live").is_err());
    assert!(join_control(BASE, "").is_err());
    // 带空格/控制字符的地址能撕开请求行，多带一行就是往对端注入请求
    assert!(join_control(BASE, "trackID=0\r\nSETUP rtsp://evil RTSP/1.0").is_err());
    assert!(join_control(BASE, "track ID").is_err());
    assert!(join_control(BASE, "轨道1").is_err());
}

// ============================================================ RTP → NAL

#[test]
fn rtp_header_fields_are_read_and_malformed_packets_are_dropped() {
    let p = rtp_packet(96, 65534, 0x0102_0304, true, b"x");
    let r = parse_rtp(&p).expect("合法包");
    assert_eq!((r.payload_type, r.seq, r.timestamp, r.marker, r.payload), (96, 65534, 0x0102_0304, true, &b"x"[..]));

    // V!=2、短于固定头、CSRC 越界、扩展越界、填充长度造假 —— 全部回 None，绝不解引用
    assert!(parse_rtp(&[0x40, 96, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]).is_none());
    assert!(parse_rtp(&[0x80, 96, 0, 1]).is_none());
    assert!(parse_rtp(&[0x8F, 96, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]).is_none(), "15 个 CSRC 却只有 12 字节");
    assert!(parse_rtp(&[0x90, 96, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]).is_none(), "有扩展却没扩展头");
    let mut pad = rtp_packet(96, 1, 1, false, &[0; 4]);
    pad[0] |= 0x20; // P 位：不置它就不该去看末字节
    pad[12 + 3] = 200; // 填充长度比包体还长
    assert!(parse_rtp(&pad).is_none());
    assert!(parse_rtp(&[]).is_none());
}

#[test]
fn padding_is_trimmed_off_the_payload() {
    let mut p = rtp_packet(96, 1, 1, false, &[9, 9]);
    p[0] |= 0x20; // P 位
    p.extend_from_slice(&[0xAA, 0x02]); // 2 字节填充，末字节是填充长度
    let r = parse_rtp(&p).expect("合法包");
    assert_eq!(r.payload, &[9, 9]);
}

#[test]
fn single_nal_with_marker_is_one_access_unit() {
    let mut s = H264Stream::default();
    let aus = push_rtp(&mut s, &rtp_packet(96, 1, 500, true, &nal(5, &[1, 2])));
    assert_eq!(aus.len(), 1);
    assert_eq!(aus[0].len(), 1);
    assert_eq!(nal_type(&aus[0][0]), NAL_IDR);
    assert_eq!(s.dropped, 0);
}

#[test]
fn stap_a_is_split_into_its_own_nals_in_order() {
    let inner = [nal(7, &[0xAA, 0xBB]), nal(5, &[0xCC])];
    let mut payload = vec![0x60 | 24];
    for n in &inner {
        payload.extend_from_slice(&(n.len() as u16).to_be_bytes());
        payload.extend_from_slice(n);
    }
    let mut s = H264Stream::default();
    let aus = push_rtp(&mut s, &rtp_packet(96, 2, 600, true, &payload));
    assert_eq!(aus.len(), 1);
    assert_eq!(aus[0].len(), 2, "SPS 与 IDR 在同一个访问单元里");
    assert_eq!(nal_type(&aus[0][0]), 7);
    assert_eq!(nal_type(&aus[0][1]), 5);
    assert!(has_idr(&aus[0]));
}

#[test]
fn stap_a_stopping_at_a_truncated_segment_keeps_the_ones_before_it() {
    let mut payload = vec![0x60 | 24];
    payload.extend_from_slice(&2u16.to_be_bytes());
    payload.extend_from_slice(&nal(7, &[0])); // 这一节声明 2 字节、给满 2 字节
    payload.extend_from_slice(&200u16.to_be_bytes()); // 这一节声明 200 字节却到此为止
    let mut s = H264Stream::default();
    let aus = push_rtp(&mut s, &rtp_packet(96, 3, 700, true, &payload));
    assert_eq!(s.dropped, 1, "坏的那段要计数");
    assert_eq!(aus[0].len(), 1, "前面那段完整的照常交出去");
}

#[test]
fn fu_a_fragments_are_reassembled_with_the_nal_header_put_back() {
    let ind = 0x60 | 28; // FU indicator：NRI 随原 NAL，类型 28
    let mut s = H264Stream::default();
    assert!(push_rtp(&mut s, &rtp_packet(96, 10, 800, false, &[ind, 0x80 | 5, 1, 2])).is_empty());
    assert!(push_rtp(&mut s, &rtp_packet(96, 11, 800, false, &[ind, 5, 3, 4])).is_empty());
    let aus = push_rtp(&mut s, &rtp_packet(96, 12, 800, true, &[ind, 0x40 | 5, 5, 6]));
    assert_eq!(aus.len(), 1);
    assert_eq!(aus[0][0], vec![0x65, 1, 2, 3, 4, 5, 6], "头两字节拼回 0x65，载荷按序接上");
    assert_eq!(s.dropped, 0);
}

#[test]
fn fu_a_missing_its_start_is_thrown_away_wholesale() {
    // 半截 NAL 塞给解码器只会解出一屏马赛克；丢一帧比给错的一帧诚实
    let ind = 0x60 | 28;
    let mut s = H264Stream::default();
    assert!(push_rtp(&mut s, &rtp_packet(96, 1, 900, false, &[ind, 5, 1, 2])).is_empty(), "中间片");
    let aus = push_rtp(&mut s, &rtp_packet(96, 2, 900, true, &[ind, 0x40 | 5, 3, 4]));
    assert!(aus.is_empty(), "没有起点的分片不许成帧");
    assert_eq!(s.dropped, 2);
}

#[test]
fn fu_a_cut_by_a_timestamp_change_is_discarded_not_completed() {
    let ind = 0x60 | 28;
    let mut s = H264Stream::default();
    push_rtp(&mut s, &rtp_packet(96, 1, 1000, false, &[ind, 0x80 | 5, 1]));
    // 下一帧的起始片到了：上一帧那半截 NAL 作废（半截喂解码器就是一屏马赛克），
    // 新帧照自己的起点重来——换帧点不许把两帧的字节接成一条 NAL。
    assert!(
        push_rtp(&mut s, &rtp_packet(96, 2, 1100, false, &[ind, 0x80 | 5, 7])).is_empty(),
        "作废的半截 NAL 不能当一帧交出去"
    );
    assert_eq!(s.dropped, 1, "作废要计数：现场靠它判断是不是网络在丢包");
    let aus = push_rtp(&mut s, &rtp_packet(96, 3, 1100, true, &[ind, 0x40 | 5, 8]));
    assert_eq!(aus.len(), 1);
    assert_eq!(aus[0][0], vec![0x65, 7, 8], "新帧自己从头拼，旧帧那个 1 不在里面");
    assert_eq!(s.dropped, 1, "拼成的那帧不该再算丢");
}

#[test]
fn a_timestamp_change_flushes_even_when_the_marker_is_lost() {
    let mut s = H264Stream::default();
    assert!(push_rtp(&mut s, &rtp_packet(96, 1, 100, false, &nal(1, &[1]))).is_empty());
    let aus = push_rtp(&mut s, &rtp_packet(96, 2, 200, false, &nal(1, &[2])));
    assert_eq!(aus.len(), 1, "时间戳跳了就交上一帧");
    assert_eq!(aus[0][0], vec![0x61, 1]);
    assert!(s.dropped == 0);
}

#[test]
fn unknown_payload_types_are_counted_and_not_forwarded() {
    // 25/26（STAP-B/FU-B）、27、29–31 现网海康不发：认不出来就丢，别当单 NAL 塞下去
    let mut s = H264Stream::default();
    assert!(push_rtp(&mut s, &rtp_packet(96, 1, 1, true, &[0x60 | 27, 0])).is_empty());
    assert!(push_rtp(&mut s, &rtp_packet(96, 2, 2, true, &[0x60 | 29, 0])).is_empty());
    assert_eq!(s.dropped, 2);
}

#[test]
fn empty_payloads_and_oversized_nals_cannot_grow_unbounded() {
    let mut s = H264Stream::default();
    assert!(push_rtp(&mut s, &rtp_packet(96, 1, 1, true, &[])).is_empty());
    let big = nal(5, &vec![0u8; 4 * 1024 * 1024 + 1]);
    assert!(push_rtp(&mut s, &rtp_packet(96, 2, 2, true, &big)).is_empty(), "超限 NAL 不许成帧");
    assert!(s.dropped >= 1, "超限要计数：{}", s.dropped);
}

#[test]
fn frames_reach_the_decoder_through_the_socket_framing() {
    // 端到端（不含网络）：`$` 帧 → next_msg → parse_rtp → H264Stream，一个包都不丢
    let packets = [
        interleaved(0, &rtp_packet(96, 1, 3000, false, &nal(7, &[1]))),
        interleaved(0, &rtp_packet(96, 2, 3000, false, &nal(8, &[2]))),
        interleaved(0, &rtp_packet(96, 3, 3000, true, &nal(5, &[3]))),
    ];
    let mut buf: Vec<u8> = Vec::new();
    let mut msgs: Vec<RtspMsg> = Vec::new();
    for p in &packets {
        // 每次只喂三分之一，并且在每个碎片后都取一次：没收齐那几趟必须什么都取不出来
        for chunk in p.chunks(p.len() / 3 + 1) {
            buf.extend_from_slice(chunk);
            let got = drain(&mut buf);
            assert!(got.len() <= 1, "一次 read 不该凑出两条消息");
            msgs.extend(got);
        }
    }
    assert_eq!(msgs.len(), 3, "三个包一个不丢、也不重");
    let mut s = H264Stream::default();
    let mut aus = Vec::new();
    for msg in msgs {
        match msg {
            RtspMsg::Interleaved { channel, packet } => {
                assert_eq!(channel, 0);
                let r = parse_rtp(&packet).expect("合法包");
                aus.extend(s.feed(r.payload, r.timestamp, r.marker));
            }
            _ => panic!("不该有响应"),
        }
    }
    assert_eq!(aus.len(), 1, "marker 那一包收尾");
    assert_eq!(aus[0].len(), 3, "SPS + PPS + IDR 同一帧");
    assert!(has_idr(&aus[0]));
    assert_eq!(s.dropped, 0);
}

// ============================================================ 关键帧闸门

#[test]
fn keyframe_gate_only_opens_on_an_idr() {
    assert_eq!(has_idr(&[nal(7, &[0]), nal(8, &[0]), nal(1, &[0])]), false, "参数集与 P 帧都不算");
    assert_eq!(has_idr(&[nal(7, &[0]), nal(5, &[0])]), true);
    assert_eq!(has_idr(&[]), false);
    assert_eq!(nal_type(&[]), 0, "空 NAL 不当关键帧看");
}

#[test]
fn phase_names_are_the_four_the_front_end_renders() {
    // 前端 `phaseLabel` 只认这四个值；这里改字符串就是两边分叉的第一步
    assert_eq!(
        (PHASE_CONNECTING, PHASE_KEYFRAME, PHASE_STREAMING, PHASE_ERROR),
        ("connecting", "waiting-keyframe", "streaming", "error")
    );
}

// ============================================================ 端点

#[test]
fn rtsp_url_keeps_the_path_case_because_rtsp_paths_are_case_sensitive() {
    // 台账里整条 URL 与纯路径两种写法都要收，而且 `/Streaming/Channels/102` 一旦变小写，
    // 现场收到的就是一条 404——而界面只表现为"连上了却没画面"。
    assert_eq!(
        rtsp_path_from_url("rtsp://192.168.10.199:554/Streaming/Channels/102", "cam1").unwrap(),
        "/Streaming/Channels/102"
    );
    assert_eq!(rtsp_path_from_url("  RTSP://h:554/Streaming/Channels/102  ", "cam1").unwrap(), "/Streaming/Channels/102");
    assert_eq!(rtsp_path_from_url("/Streaming/Channels/102", "cam1").unwrap(), "/Streaming/Channels/102");
    // 大华那种带查询串的路径原样通过（`subtype=1` 就是子码流）
    assert_eq!(
        rtsp_path_from_url("/cam/realmonitor?channel=1&subtype=1", "cam2").unwrap(),
        "/cam/realmonitor?channel=1&subtype=1"
    );
}

#[test]
fn rtsp_url_never_decides_which_host_we_connect_to() {
    // 地址是这台机唯一能被现场录入左右的入口：写别人的 IP，只能改掉路径，改不掉主机。
    assert_eq!(
        rtsp_path_from_url("rtsp://10.0.0.9:554/Streaming/Channels/101", "cam1").unwrap(),
        "/Streaming/Channels/101"
    );
    // 口令混进 URL = 台账之外多存了一份凭据，且会被拼进请求行：当场拒
    let why = rtsp_path_from_url("rtsp://admin:pw@192.168.10.199:554/a", "cam1").err().expect("带口令要拒");
    assert!(why.contains("口令"), "{why}");
    assert!(!why.contains("pw"), "错误里不许把口令抄回去：{why}");
    assert!(rtsp_path_from_url("rtmp://192.168.10.199/live", "cam1").is_err(), "非 rtsp 协议不猜");
    assert!(rtsp_path_from_url("rtsp://192.168.10.199:554", "cam1").is_err(), "只有主机名没路径 = 拉不了流");
    assert!(rtsp_path_from_url("Streaming/Channels/102", "cam1").is_err(), "少了开头的 /");
    // CRLF 能把一行撕成两条请求（这条不带 "://"，拒它的必须是字符校验而不是协议判断）
    assert!(rtsp_path_from_url("/a\r\nPLAY x RTSP/1.0", "cam1").is_err());
}

#[test]
fn rtsp_path_is_derived_from_the_ledger_http_path_or_asked_for() {
    // 海康零配置就能跑：抓图路径里的通道号就是流轨道号（101 主码流 / 102 子码流）
    assert_eq!(
        derive_rtsp_path("/ISAPI/Streaming/channels/102/picture", "cam1").unwrap(),
        "/Streaming/Channels/102"
    );
    assert_eq!(
        derive_rtsp_path("/ISAPI/Streaming/channels/101/picture", "cam1").unwrap(),
        "/Streaming/Channels/101"
    );
    assert_eq!(
        derive_rtsp_path("/ISAPI/Streaming/channels/102/", "cam1").unwrap(),
        "/Streaming/Channels/102",
        "通道号后面还有什么都不影响推导"
    );
    // 大华那种路径推不出来：宁可回一句人话要人填，也不要照猜一个地址去连
    let why = derive_rtsp_path("/cgi-bin/snapshot.cgi", "cam2").err().expect("认不出来要问人");
    assert!(why.contains("RTSP 地址"), "得说清去哪儿补：{why}");
}

#[test]
fn rtsp_uri_is_absolute_because_digest_signs_it() {
    // 真机实测：同一条请求换个 URI 写法，401 立刻回来
    let t = banghe_lib::camera_stream::RtspTarget {
        code: "cam1".into(),
        host: "192.168.10.199".into(),
        port: 554,
        path: "/Streaming/Channels/102".into(),
        user: Some("admin".into()),
        password: None,
    };
    assert_eq!(t.uri(), "rtsp://192.168.10.199:554/Streaming/Channels/102");
    let alt = banghe_lib::camera_stream::RtspTarget { port: 10554, ..t.clone() };
    assert_eq!(alt.uri(), "rtsp://192.168.10.199:10554/Streaming/Channels/102");
    assert_eq!(t.path, "/Streaming/Channels/102");
}

#[test]
fn shared_head_parser_still_accepts_rtsp_status_lines() {
    // 抓拍与预览共用 `camera::parse_http_head`：这条盯住"RTSP/1.0 也认"这一手没被人改回去
    let h = parse_http_head(b"RTSP/1.0 456 Session Not Found\r\nCSeq: 9\r\nSession: 12345678\r\n\r\n")
        .expect("RTSP 状态行要认");
    assert_eq!((h.status, h.reason.as_str()), (456, "Session Not Found"));
    assert_eq!(h.header("cseq"), Some("9"), "键已归一小写");
    assert_eq!(h.header("session"), Some("12345678"));
    assert_eq!(h.content_length, None, "没有 body 也不许凭空造一个");
    // 反之：非 HTTP/RTSP 的第一行仍然当场拒
    assert!(parse_http_head(b"SIP/2.0 100 trying\r\n\r\n").is_err());
    assert!(parse_http_head(b"\x00\x01\x02\x03\r\n\r\n").is_err());
}

// =========================================== 认证被拒 = 唯一"不再重连"的那类失败
//
// 海康把每次 401 都计进登录失败次数（默认约 7 次锁 30 分钟）。RTSP 连不上会带退避重连，
// 但认证被拒重连也进不去，只会继续把账号往锁定线上推。stream_loop 靠 is_auth_failure
// 认这类失败并当场停重连——判据与 rtsp_failure 的中文措辞耦合，这里把这对耦合钉死：
// 改了话术却忘了改判据，"停止重连"就会静默失效，测试必须红。

fn head_of(status_line: &str) -> banghe_lib::camera::HttpHead {
    let raw = format!("{status_line}\r\nCSeq: 1\r\n\r\n");
    parse_http_head(raw.as_bytes()).expect("合成状态行应能解析")
}

#[test]
fn auth_rejection_is_the_one_failure_we_stop_retrying_on() {
    // 401 / 403：认证被拒 → is_auth_failure 必须为真（据此停止重连）
    for line in ["RTSP/1.0 401 Unauthorized", "RTSP/1.0 403 Forbidden"] {
        let why = rtsp_failure("DESCRIBE", &head_of(line));
        assert!(is_auth_failure(&why), "认证类失败要能被认出来：{why}");
    }
    // 会话失效(454)、传输不支持(461)、内部错误(500)：都是"重连可能就好了"那一类 → 不能误判成认证
    for line in [
        "RTSP/1.0 454 Session Not Found",
        "RTSP/1.0 461 Unsupported Transport",
        "RTSP/1.0 500 Internal Server Error",
    ] {
        let why = rtsp_failure("SETUP", &head_of(line));
        assert!(!is_auth_failure(&why), "非认证失败不该触发停止重连：{why}");
    }
}
