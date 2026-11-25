/**
 * 出库单表单里「领出方就地建档」那颗入口（02 §M11 F11.1）：按钮和弹窗一起给，
 * 两个宿主（工作台就地编辑格 `OutboundFormPanel`、出库中心弹窗 `OutboundFormDialog`）共用一份，
 * 免得两处各写一遍刷证 / 命中 / 建档的分支。
 *
 * 弹窗就是收购侧那张 `QuickPartyDialog`，只换三样说法与范围：这个人叫「领出方」、
 * 身份类型放开到五类（领出方常是合作社或企业）、框内自带「刷身份证」。
 * 判据一条没改：唯一写入口仍是 `party_save`，一人一档、证号占用、电话占用照旧由服务端拦。
 *
 * 只留一颗按钮而不是「刷证建档」+「手工建档」两颗：开框的人不一定手边就有证件，
 * 分两颗等于逼磅员先判断一次"这人带卡了没有"。框里两种入口都在，先刷后填都来得及。
 *
 * 刷到的证号已在档＝那个人就是本单的领出方，直接选上并关框，不再要人去搜一遍同名档案。
 */
import { useState } from "react";
import { UserPlusIcon } from "lucide-react";
import { ALL_PARTY_TYPES, QuickPartyDialog } from "@/components/business/QuickPartyDialog";
import { Button } from "@/components/ui/button";
import type { Party } from "@/mock/types";

export function NewPartyButton({
  parties,
  onPicked,
  disabled,
}: {
  /** 现有档案：弹窗里要拿它挡「证号已被别人占着」，也要靠它把刷到的熟客直接选上 */
  parties: Party[];
  /** 建完的新档案，或刷证命中的老档案——两条路都落到"选为本单领出方" */
  onPicked: (p: Party) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        className="shrink-0 text-[11px] text-muted-foreground"
        disabled={disabled}
        title="就地新建领出方档案：证件放在读卡器上刷一下自动带出姓名与证号，也可以手工录入；建完直接选为本单领出方"
        onClick={() => setOpen(true)}
      >
        <UserPlusIcon />
        建档
      </Button>
      <QuickPartyDialog
        open={open}
        onOpenChange={setOpen}
        card={null}
        scan
        subject="领出方"
        types={ALL_PARTY_TYPES}
        parties={parties}
        onEnrolled={onPicked}
        onCardHit={onPicked}
      />
    </>
  );
}
