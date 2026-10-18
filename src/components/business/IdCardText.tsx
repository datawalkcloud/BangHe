/**
 * 身份证号那一格：默认掩码，点一下看全号（04 §3.3）。
 *
 * 交互语言抄 `CapturePhotoThumb`：一格文本就地变按钮，未展开是 `410101********1234`，
 * 点开是全号，再点收回；title 里如实说清"这次点击会不会留下痕迹"。
 * 号后面钉一只**眼睛**（掩码时睁开、展开时闭眼）：虚下划线那种"这串字其实能点"的暗示
 * 磅员看不出来，得给一个一眼认得出的把手。眼睛不是第二个控件，只是这一格的把手——
 * 点它和点号本身是同一次 toggle，所以**不能**在按钮里再套按钮（嵌套 button 是非法 HTML）。
 *
 * **两条来源走两条路**（`partyId` 的有无就是判据，不另造枚举）：
 *  - 给了 `partyId`＝这一格是**库里某个人的档案**：点开走 `party_id_card` 受控读通道，
 *    Rust 每次读都落一条 `pii.read`。谁在什么时候翻了谁的证号，站长在审计页查得到。
 *  - 没给＝号是**读卡器刚带出、或草稿还没落库**的（设备页读卡面板、快速建档弹窗）：
 *    库里没有这一行，"看了谁的"无从挂，就地本地揭示、不发请求、**也不伪造一条留痕**——
 *    与 `orders_contract.rs` 给照片立的那条"读不到就不许记看过"同规。这一支的 title
 *    里就不提审计，做不到的事不在屏幕上说（05 §5）。
 *
 * 三条容易做错的：
 *  ① **不用 useQuery**。照片那两处 `staleTime: 5 * 60_000` 命中缓存时不发请求也就不留痕，
 *     同一个坑不栽第二遍：这里点一次必发一次（契约测试把"同一人连看两次 = 2 条"钉住了）。
 *  ② 收回不靠倒计时。磅房念号给人听、往纸质登记表上抄，中途号没了比不掩码还误事；
 *     但**锁屏那一瞬必须强制收回**——空闲锁屏的浮层盖不住已经渲染在 DOM 里的那串全号。
 *  ③ 读失败就把后端那句人话原样回出来，不悄悄退回掩码装作没发生。
 */
import { useEffect, useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { maskIdCard } from "@/lib/format";
import { useSession } from "@/store/session";
import { cn } from "cn";

export function IdCardText({
  value,
  partyId = null,
  className,
}: {
  /** DTO 里的那串证号（真库现在就回明文，见 04 §3.3 末尾那条边界说明）；空＝未采集 */
  value: string | null | undefined;
  /** 库里档案的 id。不给＝这一格是本机内存里的号，点开不走通道也不留痕 */
  partyId?: number | null;
  className?: string;
}) {
  const [plain, setPlain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useSession((s) => s.locked);
  const has = value != null && value.trim() !== "";

  // 换人（这一格现在挂的是另一个人的号）→ 收回。锁屏同理，见文件头 ②
  useEffect(() => setPlain(null), [partyId, value]);
  useEffect(() => {
    if (locked) setPlain(null);
  }, [locked]);

  async function toggle() {
    if (plain !== null) return setPlain(null);
    if (!has || busy) return;
    if (partyId == null) {
      // B 类：号本来就在内存里，揭示它不需要问后端，也就没有"读到了谁的"可记
      setPlain(value!.trim());
      return;
    }
    setBusy(true);
    try {
      const got = await api.partyIdCard(partyId);
      if (got == null) {
        // 档案已被删（软删）或这格是随旧单据缓存下来的：不展开，也不假装看过
        toast.error("证号读不出来", { description: "这张档案已经不在库里，或没有采集证号" });
        return;
      }
      setPlain(got);
    } catch (e) {
      toast.error("证号读不出来", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      // 这一格几乎总是长在**可点击的东西**里面：磅单列表一行进详情、档案搜索下拉一行直接选用、
      // 工作台身份卡整块有快捷键。不掐掉冒泡，"点开看证号"就顺手把人家的单打开或把这张档案定了。
      onClick={(e) => {
        e.stopPropagation();
        void toggle();
      }}
      // 键盘同理：档案搜索下拉里回车就是"选定这个人"，焦点在证号这一格时不该顺手把单派出去
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
      disabled={!has}
      title={!has ? undefined : plain !== null ? "点击收回" : partyId == null ? "点击查看证号全号" : "点击查看证号全号（会记一次访问）"}
      className={cn(
        // inline-flex 而不是块级：这一格多数时候是**长在句子里**的（"证号 341…"、
        // "读到 张三（341…）"），得跟着文字走、跟着基线站。
        "inline-flex items-center gap-1 appearance-none border-0 bg-transparent p-0 text-left text-inherit",
        has && "cursor-pointer",
        className,
      )}
    >
      <span className={cn(has && "underline decoration-dotted decoration-muted-foreground/50 underline-offset-2")}>
        {busy ? "读取中…" : plain ?? maskIdCard(value)}
      </span>
      {/* 有号才摆眼睛：没采集证号的那一格压根没有可揭示的东西（`party_id_card` 回 None），
          整格也已由 `disabled` 掐掉——不摆一个点不出东西的把手，与「档案已软删就不摆整行」同一条纪律 */}
      {has &&
        (plain !== null ? (
          <EyeOffIcon className="size-3.5 shrink-0 opacity-60" aria-hidden />
        ) : (
          <EyeIcon className="size-3.5 shrink-0 opacity-60" aria-hidden />
        ))}
    </button>
  );
}
