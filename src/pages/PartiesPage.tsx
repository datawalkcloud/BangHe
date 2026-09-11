/**
 * 售粮人档案（05 §3 `/parties`）。
 *
 * 建档是收粮第一道闸门：证号重复即同一人，皮重档案决定下一车能不能快速过磅，
 * 所以这张列表把「上次皮重」和「挂账额度」直接摆在列表里，不用点进详情。
 *
 * 读卡按钮走 useDeviceStore.idcard，与工作台共用同一个读卡结果，
 * 但这里读到的是"卡片身份"，命中已有档案时只提示不覆盖，避免误改档案。
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ContactIcon, PlusIcon, ScanLineIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Party } from "@/mock/types";
import type { PartyType } from "@/lib/constants";
import { PARTY_TYPE } from "@/lib/constants";
import { maskIdCard, money, orDash, validateIdCard, weight } from "@/lib/format";
import { useWarehouses } from "@/hooks/useLookups";
import { useDeviceStore } from "@/store/device";
import { useSession } from "@/store/session";
import { ALL, Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/business/DataTable";
import { ToneBadge } from "@/components/business/badges";
import { WeightField } from "@/components/business/NumField";
import { CallOut, EmptyState, PageHeader } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

/** 表单态用「元 / 十进制」的人话单位，提交时才换算回分值与 0.1 kg */
interface PartyForm {
  id: number | null;
  name: string;
  party_type: PartyType;
  id_card_no: string;
  phone: string;
  address: string;
  bank_name: string;
  bank_account: string;
  /** 元，文本态，避免浮点中间值 */
  creditYuan: string;
  defaultWarehouseId: string;
  defaultVehicleNo: string;
  tare01kg: number | null;
  remark: string;
  active: boolean;
}

function emptyForm(): PartyForm {
  return {
    id: null,
    name: "",
    party_type: "farmer",
    id_card_no: "",
    phone: "",
    address: "",
    bank_name: "",
    bank_account: "",
    creditYuan: "",
    defaultWarehouseId: ALL,
    defaultVehicleNo: "",
    tare01kg: null,
    remark: "",
    active: true,
  };
}

function formOf(p: Party): PartyForm {
  return {
    id: p.id,
    name: p.name,
    party_type: p.party_type,
    id_card_no: p.id_card_no,
    phone: p.phone,
    address: p.address,
    bank_name: p.bank_name ?? "",
    bank_account: p.bank_account ?? "",
    creditYuan: p.credit_limit_fen ? String(p.credit_limit_fen / 100) : "",
    defaultWarehouseId: p.default_warehouse_id == null ? ALL : String(p.default_warehouse_id),
    defaultVehicleNo: p.default_vehicle_no ?? "",
    tare01kg: p.last_tare_01kg,
    remark: p.remark ?? "",
    active: p.status === "active",
  };
}

export function PartiesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const operator = useSession((s) => s.operator);
  const readCard = useDeviceStore((s) => s.idcard.read);
  const reading = useDeviceStore((s) => s.idcard.reading);
  const cardError = useDeviceStore((s) => s.idcard.error);
  const lastCard = useDeviceStore((s) => s.idcard.last);
  const { data: warehouses = [] } = useWarehouses();

  const [kw, setKw] = useState("");
  const [type, setType] = useState<PartyType | "all">("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PartyForm>(emptyForm);

  const { data: rows = [], isPending } = useQuery({
    queryKey: ["parties", kw, type],
    queryFn: () => api.listParties(kw, type === "all" ? undefined : type),
  });
  const { data: all = [] } = useQuery({ queryKey: ["parties", ""], queryFn: () => api.listParties("") });

  const patch = (p: Partial<PartyForm>) => setForm((f) => ({ ...f, ...p }));

  /** 读卡命中已有档案就给"去改"的入口，命中新证号就直接铺进新建表单 */
  useEffect(() => {
    if (!lastCard) return;
    const hit = all.find((p) => p.id_card_no === lastCard.id_card_no);
    if (hit) {
      toast.info(`读卡命中已有档案「${hit.name}」`, {
        description: "已在编辑框里带出该档案，可直接修改。",
      });
      setForm(formOf(hit));
      setOpen(true);
    } else {
      toast.success("读到新证号，已按卡片信息预填建档表单");
      setForm({ ...emptyForm(), name: lastCard.name, id_card_no: lastCard.id_card_no, address: lastCard.address });
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCard]);

  const save = useMutation({
    mutationFn: () => {
      const yuan = Number(form.creditYuan) || 0;
      return api.saveParty({
        id: form.id ?? undefined,
        operator_id: operator?.id ?? 0,
        name: form.name.trim(),
        party_type: form.party_type,
        id_card_no: form.id_card_no.trim().toUpperCase(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        bank_name: form.bank_name.trim() || null,
        bank_account: form.bank_account.trim() || null,
        credit_limit_fen: Math.round(yuan * 100),
        default_warehouse_id: form.defaultWarehouseId === ALL ? null : Number(form.defaultWarehouseId),
        default_vehicle_no: form.defaultVehicleNo.trim() || null,
        last_tare_01kg: form.tare01kg,
        remark: form.remark.trim() || null,
        status: form.active ? "active" : "disabled",
      });
    },
    onSuccess: (p) => {
      toast.success(form.id == null ? `已建档：${p.name}（${p.code}）` : `档案已更新：${p.name}`);
      setOpen(false);
      useDeviceStore.getState().idcard.clear();
      void queryClient.invalidateQueries({ queryKey: ["parties"] });
      void queryClient.invalidateQueries({ queryKey: ["party", p.id] });
      void queryClient.invalidateQueries({ queryKey: ["audits"] });
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`),
  });

  /**
   * 自然人走 GB 11643 校验位；企业与合作社拿的是统一社会信用代码，
   * 校验规则不同（那是另一套模 31 校验），首版只校长度与字符集。
   */
  const isOrg = form.party_type === "cooperative" || form.party_type === "company";
  const code = form.id_card_no.trim().toUpperCase();
  const idOk = code === "" ? false : isOrg ? /^[0-9A-Z]{18}$/.test(code) : validateIdCard(code);
  const errors: string[] = [];
  if (!form.name.trim()) errors.push("姓名必填");
  if (!code) errors.push(isOrg ? "统一社会信用代码必填" : "身份证号必填");
  else if (!idOk) errors.push(isOrg ? "应为 18 位数字/大写字母" : "证号校验位不通过（GB 11643）");
  else if (all.some((p) => p.id_card_no.toUpperCase() === code && p.id !== form.id))
    errors.push("该证号已建档，请检索后修改原档案");
  if (form.creditYuan !== "" && !(Number(form.creditYuan) >= 0)) errors.push("挂账额度不能为负");

  const columns = useMemo<Column<Party>[]>(
    () => [
      { key: "code", header: "档案编码", cell: (p) => <span className="tnum text-muted-foreground">{p.code}</span>, sortValue: (p) => p.code },
      {
        key: "name",
        header: "姓名/单位",
        cell: (p) => (
          <span className="flex items-center gap-1.5">
            <span className="font-medium">{p.name}</span>
            {p.status === "disabled" && <ToneBadge tone="neutral">停用</ToneBadge>}
          </span>
        ),
        sortValue: (p) => p.name,
      },
      { key: "party_type", header: "身份", cell: (p) => PARTY_TYPE[p.party_type] },
      {
        key: "id_card_no",
        header: "证件号",
        cell: (p) => (
          <span className="flex items-center gap-1.5">
            <span className="tnum">{maskIdCard(p.id_card_no)}</span>
            {p.id_card_verified === 1 ? (
              <span className="text-[11px] text-muted-foreground">已核验</span>
            ) : (
              <span className="text-[11px] text-warning">未核验</span>
            )}
          </span>
        ),
      },
      { key: "phone", header: "电话", cell: (p) => <span className="tnum">{orDash(p.phone)}</span> },
      { key: "address", header: "住址", cell: (p) => <span className="block max-w-[16rem] truncate">{orDash(p.address)}</span> },
      {
        key: "tare",
        header: "上次皮重",
        align: "right",
        cell: (p) => <span className="tnum">{p.last_tare_01kg == null ? "—" : weight(p.last_tare_01kg)}</span>,
        sortValue: (p) => p.last_tare_01kg,
      },
      { key: "vehicle", header: "默认车牌", cell: (p) => <span className="tnum">{orDash(p.default_vehicle_no)}</span> },
      {
        key: "credit",
        header: "挂账额度",
        align: "right",
        cell: (p) => <span className="tnum">{p.credit_limit_fen ? money(p.credit_limit_fen) : "—"}</span>,
        sortValue: (p) => p.credit_limit_fen,
      },
      { key: "account", header: "结算账户", cell: (p) => <span className="tnum text-xs">{orDash(p.bank_account)}</span> },
    ],
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="售粮人档案"
        description={`共 ${all.length} 份档案 · 停用后不可再制单，但历史磅单不受影响`}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => void readCard()} disabled={reading}>
              <ScanLineIcon />
              {reading ? "读卡中…" : "读卡建档"}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setForm(emptyForm());
                setOpen(true);
              }}
            >
              <PlusIcon />
              新增档案
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-3">
          {cardError && (
            <CallOut tone="warning" title="身份证阅读器不可用">
              {cardError}。档案仍可手工录入，读卡只影响录入速度，不影响业务连续性。
            </CallOut>
          )}
          <div className="flex flex-wrap items-end gap-2 border bg-muted/20 p-2.5">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              身份类型
              <Choose
                aria-label="身份类型"
                className="w-32"
                value={type}
                onChange={(v) => setType(v as PartyType | "all")}
                options={[
                  { value: "all", label: "全部" },
                  ...(Object.keys(PARTY_TYPE) as PartyType[]).map((k) => ({ value: k, label: PARTY_TYPE[k] })),
                ]}
              />
            </Label>
            <Label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
              关键字
              <Input
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                placeholder="姓名 / 证号 / 电话 / 编码，即时过滤"
                className="h-8 text-sm"
              />
            </Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setKw("");
                setType("all");
              }}
            >
              <SearchIcon />
              清空条件
            </Button>
          </div>

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(p) => p.id}
            loading={isPending}
            rowHref={(p) => `/parties/${p.id}`}
            onRowClick={(p) => void navigate({ to: "/parties/$id", params: { id: String(p.id) } })}
            rowClassName={(p) => (p.status === "disabled" ? "text-muted-foreground" : undefined)}
            empty={
              <EmptyState
                title="没有匹配的售粮人档案"
                description="新农户第一次来售粮时需要先建档，建档后即可读卡带出默认皮重与仓房。"
                action={
                  <Button
                    size="sm"
                    onClick={() => {
                      setForm(emptyForm());
                      setOpen(true);
                    }}
                  >
                    新增档案
                  </Button>
                }
              />
            }
            toolbar={<span className="text-xs text-muted-foreground">点行进档案详情；档案停用不影响历史磅单，只挡住新单。</span>}
          />
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[680px]">
          <DialogHeader>
            <DialogTitle className="text-sm">{form.id == null ? "新增售粮人档案" : `修改档案 ${form.name}`}</DialogTitle>
            <DialogDescription className="text-xs">
              证号是唯一的自然人主键，重复建档会导致对账时同一个人出现两个余额。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              姓名 / 单位名称 *
              <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} className="text-sm" />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              身份类型
              <Choose
                aria-label="身份类型"
                value={form.party_type}
                onChange={(v) => patch({ party_type: v as PartyType })}
                options={(Object.keys(PARTY_TYPE) as PartyType[]).map((k) => ({ value: k, label: PARTY_TYPE[k] }))}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {isOrg ? "统一社会信用代码 *" : "身份证号 *"}
              <Input
                value={form.id_card_no}
                onChange={(e) => patch({ id_card_no: e.target.value })}
                placeholder={isOrg ? "18 位代码" : "18 位，末位 X 不区分大小写"}
                className="tnum text-sm"
              />
              {code !== "" && (
                <span className={idOk ? "text-xs text-success" : "text-xs text-destructive"}>
                  {idOk ? "格式正确" : isOrg ? "应为 18 位数字/大写字母" : "校验位不通过，请核对"}
                </span>
              )}
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              联系电话
              <Input value={form.phone} onChange={(e) => patch({ phone: e.target.value })} className="tnum text-sm" />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
              住址（写入磅单与台账，迎检必填）
              <Input value={form.address} onChange={(e) => patch({ address: e.target.value })} className="text-sm" />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              开户行
              <Input value={form.bank_name} onChange={(e) => patch({ bank_name: e.target.value })} className="text-sm" />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              银行账号
              <Input value={form.bank_account} onChange={(e) => patch({ bank_account: e.target.value })} className="tnum text-sm" />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              挂账额度（元）
              <Input
                value={form.creditYuan}
                onChange={(e) => patch({ creditYuan: e.target.value })}
                inputMode="decimal"
                placeholder="0 表示不允许挂账"
                className="tnum text-sm"
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              默认进仓房
              <Choose
                aria-label="默认仓房"
                value={form.defaultWarehouseId}
                onChange={(v) => patch({ defaultWarehouseId: v })}
                options={[
                  { value: ALL, label: "不预设" },
                  ...warehouses.map((w) => ({ value: String(w.id), label: `${w.name}（${w.code}）` })),
                ]}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              默认车牌
              <Input value={form.defaultVehicleNo} onChange={(e) => patch({ defaultVehicleNo: e.target.value })} className="tnum text-sm" />
            </Label>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">参考皮重</span>
              <WeightField label="" value01kg={form.tare01kg} onChange={(v) => patch({ tare01kg: v })} hint="仅供皮重比对" />
            </div>
            <Label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
              <Switch checked={form.active} onCheckedChange={(v) => patch({ active: v === true })} aria-label="档案启用" />
              档案启用（停用后不能再用此人制单）
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
              备注
              <Textarea rows={2} value={form.remark} onChange={(e) => patch({ remark: e.target.value })} className="text-sm" />
            </Label>
          </div>

          {errors.length > 0 && (
            <CallOut tone="warning" title="还不能保存">
              <ul className="list-disc pl-4">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </CallOut>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => save.mutate()}
              disabled={errors.length > 0 || save.isPending || !operator}
            >
              <ContactIcon />
              {save.isPending ? "保存中…" : form.id == null ? "建档" : "保存修改"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
