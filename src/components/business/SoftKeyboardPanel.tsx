/**
 * 「屏幕软键盘」显隐开关（系统 → 窗口）。
 *
 * 放这一页是因为它和上面的「关闭窗口时」是同一类东西：**按登录账号各存一份的界面偏好**
 * （`user_preference`，见 `src/lib/soft-keyboard.ts`），不是站点参数——会打字的人想把
 * 按钮收掉，不该顺手把旁边那位不会打字的操作员的键盘一起关了。
 *
 * 只影响点选键阵（数字盘、字母盘、车牌盘）上的展开按钮。事由快捷选项是整句填空，
 * 不是键盘，不受这里控制；关掉后输入框与逐字键入完全照旧。
 */
import { useSoftKeyboardSetting } from "@/hooks/useSoftKeyboard";
import { SectionTitle } from "@/components/business/layout";
import { ChoiceCard } from "@/components/business/ChoiceCard";

export function SoftKeyboardPanel() {
  const { enabled, loading, saving, set } = useSoftKeyboardSetting();
  const busy = loading || saving;

  return (
    <section className="flex flex-col gap-2 border bg-card p-3">
      <SectionTitle extra={<span className="text-xs text-muted-foreground">按登录账号各存一份，关掉不影响手工打字</span>}>
        屏幕软键盘
      </SectionTitle>
      <div className="grid gap-2 sm:grid-cols-2">
        <ChoiceCard
          name="soft-keyboard"
          value="on"
          label="显示点选键盘"
          hint="数字、证号、金额、车牌这些框右边带一个键盘按钮，点开键阵逐字符点选"
          active={enabled}
          disabled={busy}
          onSelect={() => set(true)}
        />
        <ChoiceCard
          name="soft-keyboard"
          value="off"
          label="只用真键盘"
          hint="收掉所有键阵与展开按钮，屏幕更清爽；框里照常逐字敲"
          active={!enabled}
          disabled={busy}
          onSelect={() => set(false)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        这里管的是"点一下出一个字符"的键阵。作废原因、拒收原因、备注那些"点一句人话"的
        快捷选项不算软键盘，仍然留着；读卡、选人、选仓房等点选入口同样不受影响。
      </p>
    </section>
  );
}
