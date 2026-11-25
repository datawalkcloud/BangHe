/**
 * 「就地建档」弹窗（02 §F1.1 / 05 §4.0）：读到没档案的证件、或本单要的人还没建档，都在这里补。
 *
 * 原来只弹一条 toast「请先建档」，等于把人从制单里赶回档案页重走一遍：农户还站在
 * 读卡器前，磅员却要换页、重读卡、再回到工作台。02 §F1.1 的验收口径写死了
 * 「无档案时不出现两次以上的手工输入」，所以这里就地承接：读卡已经带出姓名 / 证号 / 住址，
 * 框内只补一个电话（可不填），保存即选为本单的人。
 *
 * 两个场合共用这一张，只差说法与放开到哪几种类型，**判据共用同一份**：
 *  - 收购侧 `IdentityPanel`：读卡未命中时**带着那张卡**开框（`subject="售粮人"`，只给自然人三类）；
 *  - 出库侧的领出方（`OutboundFormPanel` / `OutboundFormDialog`）：先开空框，框里点
 *    「刷身份证」现读（`scan`）。领出方常常是合作社或企业，所以类型放开到五类，
 *    那两类拿的是统一社会信用代码——校验分叉与档案页 `PartiesPage` 的 `isOrg` 同一条。
 *  入库侧刻意不给企业/合作社：读进来的是居民身份证，证号校验对不上，那种档案走档案页完整表单。
 *
 * 两张口径与档案页完全一致，不做第二套规则：
 *  - **核验标记**：本轮读卡带进来的证号与保存时的证号逐字相等才写 1（02 §F3.1）。
 *    磅员在现场改了证号，说明卡面与录入对不上，自动回落成「未核验」，去档案页重刷一次卡即可升级。
 *    企业与合作社**一律不盖章**：读卡器读不出营业执照，给单位档案盖一枚"身份证已核验"是假凭据。
 *  - **证号占用**：改证号撞上已有档案时挡住，一人一档，重复建档对账时会出现两个余额。
 *    指路那句按宿主分叉：收购侧有「搜档案」那颗退路就说"改用搜档案"，出库侧的下拉本来就是全量档案，
 *    说的是"去把那张档案编辑一遍"。出库侧还多一条 `onCardHit`：刷到已建档的证号＝那就是领出方本人，
 *    直接选进本单，连这句红字都看不到。
 *
 * 开户行、挂账额度、参考皮重同理——不挡制单，都留给档案页补全。
 */
import { useEffect, useState } from "react";
import { ContactIcon, CreditCardIcon, SearchIcon } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Party } from "@/mock/types";
import type { PartyType } from "@/lib/constants";
import { PARTY_TYPE } from "@/lib/constants";
import { validateIdCard } from "@/lib/format";
import { backfillPartyPhotoFromCard } from "@/lib/party-photo";
import { upgradeVerifiedFromCard } from "@/lib/party-verify";
import { actorId } from "@/store/session";
import type { IdCardResult } from "@/store/device";
import { CardScanDialog } from "@/components/business/CardScanDialog";
import { Choose } from "@/components/business/Choose";
import { IdCardText } from "@/components/business/IdCardText";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { KeypadInput, alnumKeys, digitKeys } from "@/components/ui/keypad";
import { Label } from "@/components/ui/label";

/** 读卡只带得出这三项，其余是表单里的可改字段 */
interface EnrollForm {
  name: string;
  id_card_no: string;
  address: string;
  phone: string;
  party_type: PartyType;
  /** 本轮读卡带进来的证号，核验判定的凭证（同档案页 `read_card_no`） */
  read_card_no: string;
}

/** 读卡能带出证号的都是自然人，收购侧的下拉里不给合作社/企业——选了也过不了证号校验 */
const PERSON_TYPES: PartyType[] = ["farmer", "large_grower", "broker"];
/** 出库的领出方常是合作社或企业，那边把五类全放开（`scan` 刷到的仍是居民身份证，类型由人挑） */
export const ALL_PARTY_TYPES: PartyType[] = ["farmer", "large_grower", "broker", "cooperative", "company"];

export function QuickPartyDialog({
  open,
  onOpenChange,
  card,
  parties,
  onEnrolled,
  onSearchParty,
  subject = "售粮人",
  types = PERSON_TYPES,
  scan = false,
  onCardHit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 刚读到的那张证卡；为 null 时（理论上不会发生）表单给空值，仍然能手工建 */
  card: IdCardResult | null;
  /** 现全量档案，只为挡「改证号撞上已有档案」这一种输入 */
  parties: Party[];
  /** 建档成功：把新档案交回制单草稿，省掉「再搜一次自己」这次按键 */
  onEnrolled: (p: Party) => void;
  /** 退路：卡面上是熟客、但档案里证号录错过 → 去搜档案选人比在这里改证号更稳 */
  onSearchParty?: () => void;
  /** 界面上这个人叫什么：收购侧「售粮人」、出库侧「领出方」，只换文案，不换判据 */
  subject?: string;
  /** 身份类型可选范围；默认只给自然人三类（读卡读不出单位） */
  types?: PartyType[];
  /** 框内自带「刷身份证」：出库侧是先开框、人再把证件放上去，没有这张卡可传 */
  scan?: boolean;
  /** 刷到的证号已在档＝本单要的就是这个人，交回调用方直接选上，不再要人搜一遍 */
  onCardHit?: (p: Party) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<EnrollForm>(seedForm(null));
  /** 开框那一刻的卡片快照：关框时调用方会清掉 store 里的读卡结果，标题文案不该跟着退化成"手工新建" */
  const [snapshot, setSnapshot] = useState<IdCardResult | null>(null);
  /** 开框之后在框里现读到的那张卡（`scan` 那一路）：照片与核验都以它为准 */
  const [scanned, setScanned] = useState<IdCardResult | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const patch = (p: Partial<EnrollForm>) => setForm((f) => ({ ...f, ...p }));

  // 每次开框都按"刚读到的那张卡"重新铺一遍：上一张没建成的半成品不该留给下一个人
  useEffect(() => {
    if (open) {
      setForm(seedForm(card));
      setSnapshot(card);
      setScanned(null);
      setScanOpen(false);
    }
    // 只在开框这一刻取快照，之后 card 被清空不该把已冲掉的内容重铺
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 本轮真正可用的那张卡：调用方带进来的优先，其次是框里现读的 */
  const liveCard = card ?? scanned;
  const titled = snapshot ?? scanned;
  const code = form.id_card_no.trim().toUpperCase();
  /** 单位（合作社/企业）拿的是统一社会信用代码：长度字符集校，不做 GB 11643 校验位（与档案页同一条分叉） */
  const isOrg = form.party_type === "cooperative" || form.party_type === "company";
  const idOk = code !== "" && (isOrg ? /^[0-9A-Z]{18}$/.test(code) : validateIdCard(code));
  /**
   * 核验判定与档案页同一条：读进来的证号与保存的证号逐字相等。
   * 单位档案多一道 `!isOrg`——读卡器只能读出居民身份证，给顶着单位代码的档案盖「已核验」是假凭据。
   */
  const verified =
    !isOrg && form.read_card_no.trim().toUpperCase() !== "" && form.read_card_no.trim().toUpperCase() === code;
  const taken = code ? parties.find((p) => p.id_card_no.trim().toUpperCase() === code) : undefined;
  /**
   * 撞上已有档案时往哪儿指，看这个宿主有没有「搜档案」那颗退路：
   * 收购侧有（就地换人），出库侧的下拉本来就是全量档案，指「搜档案」等于指一扇没有的门——
   * 那句要说的是"去把那张档案改一遍"，不是"再找一次人"。
   */
  const dupHint = onSearchParty ? "请改用「搜档案」选人" : "请到「农户单位」编辑那张档案";
  /** 手机号一人一号（`uk_party_phone`）：比对形状与真库一致，去空白与 `-` */
  const phoneKey = form.phone.replace(/[\s-]/g, "");
  const phoneTaken = phoneKey ? parties.find((p) => p.phone.replace(/[\s-]/g, "") === phoneKey) : undefined;

  // 校验错误按字段归位：红框 + 紧贴控件的红字标在出错字段上，不在弹窗底部聚合清单
  const nameErr = !form.name.trim() ? "姓名必填" : "";
  // 证号与电话至少填一个（02 §F3.1）：没带卡的临时户，留个电话也建得下来
  const pairErr = !code && !phoneKey ? (isOrg ? "统一社会信用代码与手机号至少填一个" : "身份证号与手机号至少填一个") : "";
  const idBad = !!code && !idOk;
  const idTakenErr = code && idOk && taken ? `该证号已建档（${taken.name}），${dupHint}` : "";
  const phoneErr = phoneTaken ? `该手机号已属于档案「${phoneTaken.name}」，一人一号，${dupHint}` : "";
  const hasErr = !!(nameErr || pairErr || idBad || idTakenErr || phoneErr);

  /**
   * 框内现读到一张证：证号已在档＝这个人就是本单要的人，交回调用方选上（顺手把这一刷该做的
   * 两件档案维护做完——升「已核验」、补人像，两条都是既有的 fire-and-forget 口径，失败只自报）；
   * 没档案＝把卡面铺进这张空表，磅员只补一个电话。
   */
  const onScanned = (c: IdCardResult) => {
    const hit = parties.find((p) => p.id_card_no.trim().toUpperCase() === c.id_card_no.trim().toUpperCase());
    if (hit && onCardHit) {
      void upgradeVerifiedFromCard(c, hit, qc).then((r) => {
        if (r.kind === "upgraded") toast.success(`证号与卡面一致，档案「${hit.name}」已转为「已核验」`);
        else if (r.kind === "failed") toast.warning(`「已核验」没写进档案「${hit.name}」：${r.reason}`);
      });
      void backfillPartyPhotoFromCard(c, hit, qc);
      onCardHit(hit);
      onOpenChange(false);
      return;
    }
    setScanned(c);
    patch({ name: c.name, id_card_no: c.id_card_no, address: c.address, read_card_no: c.id_card_no });
  };

  const save = useMutation({
    mutationFn: async () => {
      const p = await api.saveParty({
        name: form.name.trim(),
        party_type: form.party_type,
        id_card_no: code,
        phone: form.phone.trim(),
        address: form.address.trim(),
        status: "active",
        operator_id: actorId(),
        id_card_verified: verified ? 1 : 0,
      });
      /**
       * 卡面照片紧跟档案落库（02 §F3.1：刷证建档即自动使用身份证上那张，不用手传）。
       * 这一步失败**不回头否定建档**——磅员此刻要的是这张单能继续过磅，
       * 照片晚一分钟到档案页补都来得及；读卡器没解码照片的机型本来也会走到这一支。
       */
      const cardPhoto = liveCard?.photo_path ?? null;
      if (!cardPhoto) return { p, photoError: null as string | null };
      try {
        await api.setPartyPhoto({
          party_id: p.id,
          source_path: cardPhoto,
          operator_id: actorId(),
          source_label: "读卡带入",
        });
        void qc.invalidateQueries({ queryKey: ["party-photo", p.id] });
        return { p, photoError: null as string | null };
      } catch (e) {
        return { p, photoError: e instanceof Error ? e.message : String(e) };
      }
    },
    onSuccess: ({ p, photoError }) => {
      toast.success(
        `已建档：${p.name}（${p.code}）${p.id_card_no ? ` · ${p.id_card_verified === 1 ? "已核验" : "未核验"}` : ""}`,
        {
          description: photoError
            ? `人像照片没存上（${photoError}），可到「农户与单位」补。`
            : `已选为本单${subject}；开户行、挂账额度、参考皮重请到「农户与单位」补全。`,
        },
      );
      qc.invalidateQueries({ queryKey: ["parties"] });
      qc.invalidateQueries({ queryKey: ["party", p.id] });
      qc.invalidateQueries({ queryKey: ["audits"] });
      onEnrolled(p);
      onOpenChange(false);
    },
    // 真库回的是人话（"证号 … 已建档，请直接搜索该档案编辑"），原样送到磅员眼前并保持开框
    onError: (e: Error) => toast.error(`建档失败：${e.message || "请检查证号与姓名"}`),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {titled ? "这张证件还没有档案" : `新建${subject}档案`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {titled ? (
              <>
                读到 {titled.name}（<IdCardText value={titled.id_card_no} className="tnum" />），补个电话就能建档，建好直接用于本单。
              </>
            ) : scan ? (
              <>证件放在读卡器上时点下面那颗「刷身份证」，姓名、证号、住址自动填好；人不在跟前就直接手工录入。</>
            ) : (
              "读卡没带出证件信息，可手工录入建一张档案。"
            )}
          </DialogDescription>
        </DialogHeader>

        {/* 出库侧先开框、人再去取证件，所以刷证这一步摆在框里，而不是框外多一颗入口 */}
        {scan && (
          <Button size="sm" variant="outline" className="w-fit" onClick={() => setScanOpen(true)}>
            <CreditCardIcon />
            {titled ? "重新刷身份证" : "刷身份证"}
          </Button>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            姓名 *
            <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} aria-invalid={nameErr ? true : undefined} className="text-sm" />
            {nameErr && <span className="text-destructive">{nameErr}</span>}
          </Label>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            身份类型
            <Choose
              aria-label="身份类型"
              value={form.party_type}
              onChange={(v) => patch({ party_type: v })}
              options={types.map((k) => ({ value: k, label: PARTY_TYPE[k] }))}
            />
          </Label>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>{isOrg ? "统一社会信用代码（与手机号至少填一个）" : "身份证号（与手机号至少填一个）"}</span>
            <KeypadInput
              aria-label={isOrg ? "统一社会信用代码" : "身份证号"}
              aria-invalid={idBad || !!idTakenErr || (!!pairErr && !code) ? true : undefined}
              value={form.id_card_no}
              onChangeValue={(v) => patch({ id_card_no: v.toUpperCase() })}
              keys={isOrg ? alnumKeys() : digitKeys({ extra: ["X"] })}
              columns={isOrg ? 9 : 6}
              maxLength={18}
              toggleLabel={isOrg ? "键盘" : "数字"}
              inputMode={isOrg ? "text" : "numeric"}
              autoComplete="off"
              placeholder={isOrg ? "18 位代码" : "18 位，末位可为 X"}
              inputClassName="tnum text-sm"
            />
            <span className={code === "" ? "hidden" : idOk ? "text-xs text-success" : "text-xs text-destructive"}>
              {idOk ? "格式正确" : isOrg ? "应为 18 位数字/大写字母" : "校验位不通过，请核对"}
            </span>
            {!!idTakenErr && <span className="text-xs text-destructive">{idTakenErr}</span>}
            {!code && !!pairErr && <span className="text-xs text-destructive">{pairErr}</span>}
            {code !== "" && idOk && !idTakenErr && (
              <span className="text-xs text-muted-foreground">
                {isOrg
                  ? "单位档案不计「已核验」，那枚标记只给自然人证件"
                  : verified
                    ? "证号读卡带入 · 保存后标记「已核验」"
                    : "证号与卡面不一致 · 保存后为「未核验」，重刷一次卡即可核验"}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>联系电话</span>
            <KeypadInput
              aria-label="联系电话"
              aria-invalid={!!phoneErr || (!!pairErr && !code) ? true : undefined}
              value={form.phone}
              onChangeValue={(v) => patch({ phone: v.replace(/[^\d\s-]/g, "") })}
              keys={digitKeys()}
              columns={6}
              maxLength={20}
              toggleLabel="数字"
              inputMode="tel"
              autoComplete="off"
              placeholder="选填"
              inputClassName="tnum text-sm"
            />
            {!!phoneErr && <span className="text-xs text-destructive">{phoneErr}</span>}
            {!code && !!pairErr && <span className="text-xs text-destructive">{pairErr}</span>}
          </div>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
            住址（迎检必填）
            <Input value={form.address} onChange={(e) => patch({ address: e.target.value })} className="text-sm" />
          </Label>
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            {onSearchParty && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onOpenChange(false);
                  onSearchParty();
                }}
              >
                <SearchIcon />
                搜档案
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
              先不建
            </Button>
          </div>
          <Button size="sm" onClick={() => save.mutate()} disabled={hasErr || save.isPending}>
            <ContactIcon />
            {save.isPending ? "建档中…" : "建档并用于本单"}
          </Button>
        </DialogFooter>

        {/*
          监听弹窗嵌在本框之内（与 `RegistrationDialog` 里那套同一形状）：读到卡由上面的
          `onScanned` 接手——命中档案交回调用方选人，没档案就把卡面铺进这张表。
          `onManualEntry` 那颗「手工录入」只是关掉监听回到本框，字段本来就能敲。
        */}
        {scan && (
          <CardScanDialog open={scanOpen} onOpenChange={setScanOpen} scene="enroll" onCardRead={onScanned} onManualEntry={() => undefined} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function seedForm(card: IdCardResult | null): EnrollForm {
  return {
    name: card?.name ?? "",
    id_card_no: card?.id_card_no ?? "",
    address: card?.address ?? "",
    phone: "",
    party_type: "farmer",
    read_card_no: card?.id_card_no ?? "",
  };
}
