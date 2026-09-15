# topics/business.md — 业务规则（细则原文，从 MEMORY.md 搬来）

## 业务定级：两条线（别混）
| 字段 | 含义 | 谁能改 | 姿势 |
| --- | --- | --- | --- |
| `qc_report.grade` | 化验员按国标的判定 | **永不改写** | 复检另立新单，旧单 `is_effective=0` |
| `weigh_order.grade` | 结算用的业务定级 | 化验员/出纳/站长 | `order_set_grade`（`write_tx`+`GRADE_ROLES`），**改判事由可选**（留空时审计记「未填写」） |

闸门沿 `VOIDABLE`；settled/paid/archived/reversed → `Err("已结算的单改等级请先由站长红冲")`。前端两入口：
① `SettleForm` 结算时改判（价来自价目表 `matchesList` 时自动跟价并 toast，手填/已偏离不动）；②
`OrderDetailPage` 基本信息卡「调整等级/定级」Dialog。事后追溯靠 `audit_log`，
**不要往 settlement_order 加 grade 列**。

## 结算与化验的数据流
- `settle` 把 袋重/扣水/扣杂/其他扣 **UPDATE 进 `weigh_order`**、`grade = COALESCE(?20, grade)`，
  **不回写化验单**；`qc_report.*_deduct_01kg` 只是"化验给出的**建议**"，结算框以 `order.x || qc.x` 铺初值
  → 两者可以不等且没提示，界面文案必须自己说清出处。
- 命名：化验那份叫「**化验定级**」「扣水（**建议**）」，磅单那份叫「**结算等级**」「扣水（化验 X kg）→
  结算确认后即真值」。`SettleForm` 两值不同时补 hint「已改动：化验单是 X，结算与票面一律按本单算」；
  `OrderDetailPage` 重量卡标「（磅单值）」、化验卡标「（建议）」，不等时补 warning。
- 品种闸门在服务端 `settle` 另有一道；`QcPanel` 的品种下拉只在 `variety_id == null` 时露（存量单兜底）。
- 付款三档：不勾当场=`unpaid`；勾了没付够=`partial`；付够=`paid`。`partial` 时 `paid_at` 仍 NULL。
- 现无 `order_set_deduct` 之类命令，**扣重只能从 `settle` 落库**。

## 收购品种：制单必填（2026-09-14，反转了迁移 0017 的一半）
`weigh_order.variety_id` 取号那一刻必填。四处是一个整体，别只改一半：`orders.rs::create_order` 取号前
`ok_or_else` 并查在册+启用；mock `createOrder` 用 `variety_id: number`（类型上断掉漏传）+ `throw`（文案与
Rust 逐字一致）；`IdentityPanel.tsx` 下拉去掉「未定」、标 `*`+`invalid`、`needVariety()` 统一出提示（toast
id `ws-variety-required` + 喇叭 + 光标送 `#ws-variety`），submit 先判品种→卡→人，`autoCreate` 加
`varietyIdRef`，`CardBindDialog.onPicked` 同理；`orders_contract.rs` 的契约测试同名一条。
**两条不能踩**：① 库里那列仍可空，不加 NOT NULL、不把 `v_open_order` 的 LEFT JOIN 改回 INNER JOIN
（否则在途单从看板消失）；空值兜底一律「未定品种」（`format.ts::varietyLabel`）。② `settle`/`save_qc`
两道"没定品种"硬闸不许撤。

## 净重刚定那一步（2026-09-14 新增）
净重刚定的那一捕（**毛重补齐或皮重补齐都算**，判据是捕获前后 net 由 null 变非 null）之后走
`postWeighAction`（`src/lib/settle-defaults.ts`，**唯一一份判定**）——单价已有 + 有权 + 站点允许挂账
→ **自动按未付款挂账结算**（`api.settle`，`pay_now=false`，默认值走 `settleDefaults()`）；单价为空 /
岗位无权 / 站点关挂账 → 弹结算框（`SettleForm defaultUnpaid`）；已结算 / 已作废拒收红冲 → 什么都不做。
`WeighPanel.onNetDetermined` 与 `useIcWorkflow.onNetDetermined` **只上报"净重刚定"**，判定与话术归页面；
同一张单用 `advancedFor` ref 只推进一次。默认值只有 `settleDefaults()` 一份——自动结算与结算框必须算出
同一笔钱。**权限**：`settle.create`（出纳/站长，含当场付款）与 `settle.credit`（磅员/出纳/站长，**只挂账
不碰现金**）是两把钥匙，`order_settle` 按 `pay_now` 选角色集、**不取并集**；`settle-gate.ts` 那条"兑付
窗口要出纳/站长"没放开。

**出票与落账的先后（2026-09-14 修订）**：`auto` 支**先结算再出票**（顺序反了票面就只能是结算前的
「预估」金额，而同一瞬间库里已经有确数）。"出票前把这一单拉成最新"已收进 `triggerPrint` 自己
（见 `print.md` 的「打印」节），调用点**不要**再各写一遍 `refetchQueries`——两处都留会等两遍。
`dialog` 支**先出票再开框**（票是客户手里的凭据，不能等人填完价才给）。`none` 支**不出票**
（那属于补打，得走 F9 / 磅单详情留 `print_log`）。
`autoSettle` 回 `null`（扣重吃光净重）时也要**照出票**再把结算框打开。
**注意**：`weigh_order.price_fen_per_ton` 现已由 `create_order` / `order_set_price` / `settle` 三处写，
所以 `postWeighAction` 的 `auto` 支真正可达。

## 定价：价是成交的前提，不是结算的产物（2026-09-14 新增）
**制单即带挂牌价**：`create_order` 按"品种 + 当日"查价目表现行价写进 `price_fen_per_ton` /
`price_list_id`（`lookup_price`，与 `settle-defaults.ts::lookupPrice` 逐条同构：命中等价优先、命不中
退回同品种最近生效）。票面因此**先有价**再出纸——农户到站先问价，谈成才卸货。

四个入口/写入点，判定必须同套（改的都是 `weigh_order.price_fen_per_ton` 这一列）：
| 位置 | 说明 |
| --- | --- |
| `create_order` | 挂牌价（唯一一次"自动"写） |
| `order_set_price`（`PRICE_OVERRIDE_ROLES = station_master + weigher`，audit `price.override`） | `PriceDialog`：磅房称重区（净重行下方，排在「去结算」之前）+ 磅单详情基本信息卡 |
| `settle` | 结算框那一格（`SettleForm`，**刻意不共用 PriceDialog**：那边语义是"结算这一刻确认价"，与付款意向绑在一起） |
| mock `createOrder` / `setOrderPrice` / `settle` | 逐字对齐 Rust |

**改价事由：选填**（2026-09-14 晚改口径，原为硬闸必填 ≥4 字）。四处是一个整体，别只改一半：
`orders.rs::settle`、`orders.rs::set_price`、mock `api.settle` / `api.setOrderPrice`、前端
`SettleForm`（`missingReason` 硬闸已撤，字段改叫 `showReason`、只在偏离价目时露出）与 `PriceDialog`
（`reasonShort` 已撤）。偏离价目时**写了才落 `price_override_reason`**，不写照常落价、那列 NULL。
照价目执行的一律 `price_override_reason = NULL` 且保住/记回 `price_list_id`（`0001_init.sql:217`
「改价后置 NULL 并填 reason」）；**只有 `deviates` 才落事由**，否则前端把事由带上来也会被丢掉。
审计那句：写了就写那一句，没写记「未填写改价事由」（与 `set_grade` 的「未填写」同一口径）。
闸门沿 `VOIDABLE`：settled/paid/archived/reversed → `Err("…改价请先由站长红冲")`。
`price.override` 与 `price.edit`（价目表维护，`masters.rs`）是**两个动作**：一个改这一单的价、一个改表上的价。

**票面**：`scenarios.tsx::settledOrPreview()` 以 `payable_amount_fen == null`（＝未结算）为判据，把
扣项/结算重量/货款/应付等 7 个字段换成 `settlePreview()` 的预估值并加 `（预估）`；`price_per_kg` 始终
印 `order.price_fen_per_ton`。**单价不标预估**（它是谈定的确定值），估的是扣重。`settlePreview` 只用于
展示，唯一算钱公式仍是 `calc.ts::previewSettlement`。

**价闸：捕毛重之前本单必须有价**（2026-09-14）。判定与文案**只有一份** `lib/weigh-gate.ts::priceGateOf`
（手点 / 手录 / 刷卡三条入口共用），服务端 `orders.rs::capture` 与 mock `api.capture` 才是硬的那道
（三处文案逐字一致）。
- **只拦毛重**：毛重是"这车粮上磅"的那一刻，没价＝还没谈成。皮重不拦（空车多重与价无关）；
  一次/二次顺序自由，先捕皮重的车在毛重那一捕照样撞得到。
- **不拦制单**：价后头补得上，号取不出来才是真卡住现场（没配好价目表的站点会整站开不了张）。
  制单带出挂牌价之后，撞上这道闸的只有"该品种无现行价目"或"现场议的价还没落库"两种。
- 被拦时：toast（固定 id 去重）+ 喇叭，**有 `price.override` 就把 `PriceDialog` 直接开在他面前**
  （这一捕是明确的操作意图，回空档不如回一个填价的地方；无定价权的岗位只提示，别开存不进去的框）。
  刷 IC 那条路被拦则**什么都不写**，让磅员填完价再刷一次。

## 称重区：手录与刷卡同权（2026-09-14）
仪表离线 / 读卡器故障的站点里手录就是主路，不是降级。三处必须与刷卡对齐：
① **入口**：`WeighPanel` 的 `manualMode = manual || !scale.connected`；离线时两个主按钮直接变
「录入毛重/录入皮重」、录入框自动打开、开关置灰且 `checked={manualMode}`；空格/P/回车都走
`captureLive`，手录态下**提交录入框里的值**（空值提示 + 光标送进框），不再要求"先开开关再点另一个
按钮"。落库成功即清空该框、换单即清空整组（否则空格提交 `next` 那一项会把上一车的数记进这一车）。
② **判据**：判"净重刚定"只能用**捕获前自取的快照**（`WeighPanel.priorNet`，在 `mutationFn` 里与
`grabCaptureFrames` 并发 `api.getOrder`）。**不许拿 `order` 这个 prop 现读**——后台重取 / 窗口聚焦
重取 / 上一捕失效重取都能在"请求→回执"之间把它换成"已含净重"的新值，判据静默变 false → 票不出、
结算不走、且不报错。`useIcWorkflow.advance` 本来就是这个口径。
③ **下一步**：`WeighPanel.onRequestSettle` → 页面 `requestSettle`（第③刷 / 扫票 / 称重区三处共一条：
`goOrder` + `setSettleUnpaid(false)` + `setSettleNo`）。闸门与话术复用 `settle-gate.ts`，按钮**不置灰**
（触摸屏无 hover，点了会说话才留得住人）。这是 `card_flow_mode=off` 站点走到钱的唯一入口。
**另一处易踩**：`triggerPrint` 的直打触发量是自增 `printSeq` 而**不是 boolean**——`setState(同值)` 不
重渲染，目标单号没变时整次 `triggerPrint` 会退化成空操作，票静默不出；去重仍由 `printedFor` 管。

## 结算单结清的三处呈现（2026-09-14）
都在 `SettlementDetailPage`（结算单详情；整页与 `quickDetail` 抽屉共用同一个 body，改一处两边都变）：
- **每次「登记付款」成功即自动出一张结算凭证**（`printVoucherAfterPayment`，走静默直打、失败回退预览框；
  `can("print")` 才出纸，`station` 未载入时 toast 交代一句）。**票面数据用 `recordPayment` 的返回值**——
  `settlements.rs::record_payment` 末尾 `load_settlement_by_id(conn, id)` 回的是写库后重读的那一行
  （含 `orders` 明细，凭证里那张「结算磅单明细」表才有行）；若读页面缓存，印出的「已付」是登记前那个数。
  `isReprint: false`（这是首次出票，不是补打）。
- 未付余额清零（`fullyPaid = unpaidFen === 0`）后**收起「登记付款」整块**——那时它唯一能做的事就是显示
  "本单已结清，无需再登记"。块内原来那几处 `unpaidFen === 0` 分支已不可达，一并删掉，别留"守着不可能
  发生的判断"。
- 同时用 `PaidStamp` 在「结算信息」卡片右下角盖一枚「全额付清」（绝对定位 + `-rotate-6` + `text-success`；
  父卡片加 `relative`、内容容器加 `pb-20` 给印子腾位；`aria-hidden`，语义由页头状态徽章与金额汇总两行承载）。
  **撤销的单不盖**（判据 `fullyPaid && status === "normal"`），否则印子会把"已撤销"这个事实盖住。
