/**
 * 读卡未命中档案时的「无档案 · 快捷登记」弹窗（02 §F1.1 / 05 §4.0）。
 *
 * 原来只弹一条 toast「请先建档」，等于把人从制单里赶回档案页重走一遍：农户还站在
 * 读卡器前，磅员却要换页、重读卡、再回到工作台。02 §F1.1 的验收口径写死了
 * 「无档案时不出现两次以上的手工输入」，所以这里就地承接：读卡已经带出姓名 / 证号 / 住址，
 * 框内只补一个电话（可不填），保存即选为本单售粮人。
 *
 * 两张口径与档案页完全一致，不做第二套规则：
 *  - **核验标记**：本轮读卡带进来的证号与保存时的证号逐字相等才写 1（02 §F3.1）。
 *    磅员在现场改了证号，说明卡面与录入对不上，自动回落成「未核验」，去档案页重刷一次卡即可升级。
 *  - **证号占用**：改证号撞上已有档案时挡住并指向「搜档案」，一人一档，重复建档对账时会出现两个余额。
 *
 * 只收自然人三类（农户 / 种粮大户 / 经纪人）：读进来的是居民身份证，合作社与企业拿的是
 * 统一社会信用代码，那是另一套校验，要走档案页完整表单，不在这里塞进快捷框。
 * 开户行、挂账额度、参考皮重同理——不挡制单，都留给档案页补全。
 */
import { useEffect, useMemo, useState } from "react";
import { ContactIcon, SearchIcon } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Party } from "@/mock/types";
import type { PartyType } from "@/lib/constants";
import { PARTY_TYPE } from "@/lib/constants";
import { maskIdCard, validateIdCard } from "@/lib/format";
import { actorId } from "@/store/session";
import type { IdCardResult } from "@/store/device";
import { Choose } from "@/components/business/Choose";
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
import { KeypadInput, digitKeys } from "@/components/ui/keypad";
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

/** 读卡能带出证号的都是自然人，下拉里不给合作社/企业——选了也过不了证号校验 */
const PERSON_TYPES: PartyType[] = ["farmer", "large_grower", "broker"];

export function QuickPartyDialog({
  open,
  onOpenChange,
  card,
  parties,
  onEnrolled,
  onSearchParty,
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
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<EnrollForm>(seedForm(null));
  /** 开框那一刻的卡片快照：关框时调用方会清掉 store 里的读卡结果，标题文案不该跟着退化成"手工新建" */
  const [snapshot, setSnapshot] = useState<IdCardResult | null>(null);
  const patch = (p: Partial<EnrollForm>) => setForm((f) => ({ ...f, ...p }));

  // 每次开框都按"刚读到的那张卡"重新铺一遍：上一张没建成的半成品不该留给下一个人
  useEffect(() => {
    if (open) {
      setForm(seedForm(card));
      setSnapshot(card);
    }
    // 只在开框这一刻取快照，之后 card 被清空不该把已填的内容冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const code = form.id_card_no.trim().toUpperCase();
  const idOk = code !== "" && validateIdCard(code);
  /** 核验判定与档案页同一条：读进来的证号与保存的证号逐字相等 */
  const verified = form.read_card_no.trim().toUpperCase() !== "" && form.read_card_no.trim().toUpperCase() === code;
  const taken = code ? parties.find((p) => p.id_card_no.trim().toUpperCase() === code) : undefined;
  /** 手机号一人一号（`uk_party_phone`）：比对形状与真库一致，去空白与 `-` */
  const phoneKey = form.phone.replace(/[\s-]/g, "");
  const phoneTaken = phoneKey ? parties.find((p) => p.phone.replace(/[\s-]/g, "") === phoneKey) : undefined;

  const errors = useMemo(() => {
    const out: string[] = [];
    if (!form.name.trim()) out.push("姓名必填");
    // 证号与电话至少填一个（02 §F3.1）：没带卡的临时户，留个电话也建得下来
    if (!code && !phoneKey) out.push("身份证号与手机号至少填一个（证号读卡带入，或手工录入 18 位）");
    else if (code && !idOk) out.push("证号校验位不通过（GB 11643），请核对卡面");
    else if (taken) out.push(`该证号已建档（${taken.name}），请改用「搜档案」选人`);
    if (phoneTaken) out.push(`该手机号已属于档案「${phoneTaken.name}」，一人一号，请改用「搜档案」选人`);
    return out;
  }, [form.name, code, idOk, taken, phoneTaken]);

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
      const cardPhoto = card?.photo_path ?? null;
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
            ? `档案已建好并选为本单售粮人；人像照片没存上（${photoError}），可到「农户与单位」补。`
            : "已选为本单售粮人；开户行、挂账额度、参考皮重请到「农户与单位」补全。",
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
            {snapshot ? "这张证件还没有档案" : "新建售粮人档案"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {snapshot
              ? `读到 ${snapshot.name}（${maskIdCard(snapshot.id_card_no)}），系统内没有对应档案。补个电话就能建档，建好直接用于本单制单。`
              : "读卡没带出证件信息，可手工录入建一张档案。"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            姓名 *
            <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} className="text-sm" />
          </Label>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            身份类型
            <Choose
              aria-label="身份类型"
              value={form.party_type}
              onChange={(v) => patch({ party_type: v })}
              options={PERSON_TYPES.map((k) => ({ value: k, label: PARTY_TYPE[k] }))}
            />
          </Label>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>身份证号（与手机号至少填一个）</span>
            <KeypadInput
              aria-label="身份证号"
              value={form.id_card_no}
              onChangeValue={(v) => patch({ id_card_no: v.toUpperCase() })}
              keys={digitKeys({ extra: ["X"] })}
              columns={6}
              maxLength={18}
              toggleLabel="数字"
              inputMode="numeric"
              autoComplete="off"
              placeholder="18 位，末位 X 不区分大小写"
              inputClassName="tnum text-sm"
            />
            <span className={code === "" ? "hidden" : idOk ? "text-xs text-success" : "text-xs text-destructive"}>
              {idOk ? "格式正确" : "校验位不通过，请核对"}
            </span>
            {code !== "" && idOk && (
              <span className="text-xs text-muted-foreground">
                {verified
                  ? "证号读卡带入 · 保存后标记「已核验」"
                  : "证号与卡面不一致 · 保存后为「未核验」，重刷一次卡即可核验"}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>联系电话</span>
            <KeypadInput
              aria-label="联系电话"
              value={form.phone}
              onChangeValue={(v) => patch({ phone: v.replace(/[^\d\s-]/g, "") })}
              keys={digitKeys()}
              columns={6}
              maxLength={20}
              toggleLabel="数字"
              inputMode="tel"
              autoComplete="off"
              placeholder="读卡读不出来，可不填"
              inputClassName="tnum text-sm"
            />
          </div>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
            住址（写入磅单与台账，迎检必填）
            <Input value={form.address} onChange={(e) => patch({ address: e.target.value })} className="text-sm" />
          </Label>
        </div>

        {errors.length > 0 && (
          <ul className="list-disc pl-4 text-xs text-warning">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

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
          <Button size="sm" onClick={() => save.mutate()} disabled={errors.length > 0 || save.isPending}>
            <ContactIcon />
            {save.isPending ? "建档中…" : "建档并用于本单"}
          </Button>
        </DialogFooter>
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
