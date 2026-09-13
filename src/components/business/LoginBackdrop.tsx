/**
 * 登录页整页背景插画（05 §3 `/login`）。
 *
 * 一座完整粮站的活儿都在里头。左岸是"存"：提升机工作塔 + 四座立筒仓 + 横在仓顶的输送廊 +
 * 烘干塔与烟囱，前景还有两座露天粮囤和一垛编织袋；右岸是"收"：地磅上一辆堆尖粮的运粮车、
 * 抬起的道闸、亮着灯的磅房、高杆灯，过完磅的农用三轮正从场院驶离；
 * 底下一道防护林与远野把站区托住。配色取自 logo——深绿→亮绿打底，麦金只留给日头、粮堆、
 * 磅台与麦穗这几处高光，视线先落在"过磅"这条主线上。
 *
 * 四条实现约定：
 *  1. 画面自带颜色，不跟主题走。深浅两档下都是同一张封面；卡片那层的对比度由登录页的压暗遮罩补。
 *  2. `slice` 铺满：窗口再窄也只裁切、不拉伸变形。
 *  3. 构图焦点刻意摆在左右两岸，中央留给登录卡（卡是实心的，正压在画面中段）；
 *     中段只留天空与场院下沿，往来的元素都躲开 x 520-920 这条带子。
 *  4. 纯装饰，读屏软件隐藏；站名、说明这些真信息由登录卡承担，画面上不写一个字。
 */
import { cn } from "cn";

/** 沿地平线排一排防护林：位置与高度按下标错开，避免像列队 */
function treeLine(count: number, step: number) {
  return Array.from({ length: count }, (_, i) => {
    const x = 12 + i * step;
    const half = 9 + (i % 3) * 3;
    const h = 22 + ((i * 13) % 16);
    return `M${x} 600l${half} -${h} ${half} ${h}z`;
  });
}

export function LoginBackdrop({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("block", className)}
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 1440 900"
      role="presentation"
    >
      <defs>
        <linearGradient id="bk-sky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#052a1c" />
          <stop offset="0.5" stopColor="#0a4531" />
          <stop offset="0.82" stopColor="#12674a" />
          <stop offset="1" stopColor="#1c7f5b" />
        </linearGradient>
        <linearGradient id="bk-ground" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#136a4b" />
          <stop offset="1" stopColor="#0a3d2b" />
        </linearGradient>
        <linearGradient id="bk-field" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#0b4530" />
          <stop offset="1" stopColor="#04201a" />
        </linearGradient>
        <linearGradient id="bk-silo" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#54d69b" />
          <stop offset="0.45" stopColor="#1f9163" />
          <stop offset="1" stopColor="#0a4531" />
        </linearGradient>
        <linearGradient id="bk-gold" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffe3a0" />
          <stop offset="0.5" stopColor="#f2be57" />
          <stop offset="1" stopColor="#dd941c" />
        </linearGradient>
        <linearGradient id="bk-pile" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#f2be57" />
          <stop offset="0.62" stopColor="#c9871d" />
          <stop offset="1" stopColor="#8a5a12" />
        </linearGradient>
        <radialGradient id="bk-sun">
          <stop offset="0" stopColor="#fff0c2" />
          <stop offset="0.6" stopColor="#f7c95e" />
          <stop offset="1" stopColor="#e0951d" />
        </radialGradient>
        <radialGradient id="bk-halo">
          <stop offset="0" stopColor="#fbd77a" stopOpacity="0.5" />
          <stop offset="0.45" stopColor="#fbd77a" stopOpacity="0.16" />
          <stop offset="1" stopColor="#fbd77a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="bk-band" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#f2be57" stopOpacity="0" />
          <stop offset="0.5" stopColor="#f2be57" stopOpacity="0.22" />
          <stop offset="1" stopColor="#f2be57" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="bk-vignette" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#03150f" stopOpacity="0" />
          <stop offset="1" stopColor="#03150f" stopOpacity="0.75" />
        </linearGradient>

        {/* 一支麦穗：原点取穗尖，向下 36 是茎。用 <use> 反复摆，前景才够密 */}
        <g id="bk-wheat">
          <path d="M0 4V36" fill="none" stroke="url(#bk-gold)" strokeLinecap="round" strokeWidth="2.2" />
          <ellipse cx="0" cy="1" rx="2.1" ry="4.8" fill="url(#bk-gold)" />
          {[-2, 4, 10, 16, 22].map((dy) => (
            <g key={dy} fill="url(#bk-gold)">
              <ellipse cx="-3.5" cy={8 + dy * 0.75} rx="2.2" ry="3.9" transform={`rotate(-30 -3.5 ${8 + dy * 0.75})`} />
              <ellipse cx="3.5" cy={8 + dy * 0.75} rx="2.2" ry="3.9" transform={`rotate(30 3.5 ${8 + dy * 0.75})`} />
            </g>
          ))}
        </g>
        {/* 一个码好的粮袋：横向的圆头长条 */}
        <rect id="bk-sack" width="62" height="22" rx="9" />
      </defs>

      <rect width="1440" height="900" fill="url(#bk-sky)" />

      {/* 云带与飞鸟：把空掉的天压住，别和登录卡抢中心区 */}
      <g fill="#ffffff">
        <rect x="90" y="132" width="470" height="9" rx="4.5" opacity="0.05" />
        <rect x="230" y="186" width="360" height="7" rx="3.5" opacity="0.045" />
        <rect x="820" y="150" width="420" height="8" rx="4" opacity="0.05" />
        <rect x="960" y="206" width="300" height="6" rx="3" opacity="0.04" />
      </g>
      <g fill="none" stroke="#d8efe2" strokeWidth="3" opacity="0.32" strokeLinecap="round">
        <path d="M470 214q16-15 32 0q16-15 32 0" />
        <path d="M556 262q12-11 24 0q12-11 24 0" />
        <path d="M420 288q10-9 20 0q10-9 20 0" />
        <path d="M1236 176q12-11 24 0q12-11 24 0" />
      </g>

      {/* 日头与光晕，压在右岸 */}
      <circle cx="1120" cy="430" r="300" fill="url(#bk-halo)" />
      <circle cx="1120" cy="430" r="104" fill="url(#bk-sun)" opacity="0.95" />

      {/* 远野两道层次 + 一排防护林，把站区"垫"在田野里 */}
      <path d="M0 546c190-18 330 10 520-4 170-12 320 8 470-2 150-10 280 8 450 0v60H0z" fill="#0d4a33" opacity="0.5" />
      <path d="M0 572c210-14 360 16 560 2 180-12 320 10 500 0 160-8 260 8 380 2v46H0z" fill="#0a3d2b" opacity="0.62" />
      <g fill="#083526" opacity="0.8">
        {treeLine(26, 56).map((d) => (
          <path key={d} d={d} />
        ))}
      </g>

      {/* 电线杆与弧垂的线路：画在仓群之后，杆脚自然被建筑挡住 */}
      <g stroke="#0a3d2b" strokeWidth="5" fill="none" opacity="0.85">
        <path d="M452 600V262M424 274h56M432 292h40" />
      </g>
      <g stroke="#d8efe2" strokeWidth="2.4" fill="none" opacity="0.22">
        <path d="M0 232q226 62 448 34M0 254q226 66 448 50M456 266q400 112 984 46" />
      </g>

      {/* 地平线上一条暖光带，远处两栋平房仓剪影 */}
      <rect x="0" y="540" width="1440" height="120" fill="url(#bk-band)" />
      <g fill="#0a3d2b" opacity="0.9">
        <rect x="470" y="556" width="150" height="44" />
        <path d="M462 556l83-26 83 26z" />
        <rect x="650" y="568" width="96" height="32" />
      </g>

      <rect x="0" y="600" width="1440" height="300" fill="url(#bk-ground)" />

      {/* 左岸·存：提升机工作塔 → 四座立筒仓 → 仓顶输送廊 → 烘干塔 */}
      <g>
        {/* 工作塔 */}
        <path d="M26 300l53-36 53 36z" fill="#54d69b" />
        <rect x="36" y="300" width="86" height="300" fill="url(#bk-silo)" />
        <g fill="#0a3323" opacity="0.5">
          <rect x="52" y="326" width="24" height="20" />
          <rect x="52" y="368" width="24" height="20" />
          <rect x="52" y="410" width="24" height="20" />
          <rect x="52" y="452" width="24" height="20" />
        </g>
        <path d="M110 300v300" stroke="#04241a" strokeWidth="3" opacity="0.3" />
        {/* 筒仓：后矮前高 */}
        <path d="M122 380l42-42 42 42z" fill="#3ab77f" />
        <rect x="130" y="380" width="68" height="220" fill="url(#bk-silo)" />
        <path d="M196 330l50-50 50 50z" fill="#54d69b" />
        <rect x="204" y="330" width="84" height="270" fill="url(#bk-silo)" />
        <path d="M286 404l37-38 37 38z" fill="#3ab77f" />
        <rect x="294" y="404" width="58" height="196" fill="url(#bk-silo)" />
        <path d="M350 352l47-46 47 46z" fill="#54d69b" />
        <rect x="358" y="352" width="78" height="248" fill="url(#bk-silo)" />
        {/* 仓箍 */}
        <g stroke="#04241a" strokeWidth="3" opacity="0.32">
          <path d="M130 436h68M130 492h68M130 548h68M204 396h84M204 462h84M204 528h84M294 460h58M294 520h58M294 578h58M358 414h78M358 476h78M358 538h78" />
        </g>
        {/* 爬梯 */}
        <g stroke="#ffffff" strokeWidth="2.4" opacity="0.26">
          <path d="M268 336v264M280 336v264M268 354h12M268 386h12M268 418h12M268 450h12M268 482h12M268 514h12M268 546h12M268 578h12" />
          <path d="M414 358v242M426 358v242M414 376h12M414 408h12M414 440h12M414 472h12M414 504h12M414 536h12M414 568h12" />
        </g>
        {/* 输送廊：从工作塔腰上拉到末座仓顶，斜着掠过仓身 */}
        <path d="M122 392l314-54 0 24-314 54z" fill="#1f9163" opacity="0.92" />
        <path d="M122 392l314-54" stroke="#54d69b" strokeWidth="3" opacity="0.5" fill="none" />
        {/* 烘干塔：塔身、风道、 hopsper 锥形出料口与烟囱 */}
        <rect x="492" y="236" width="14" height="88" fill="#3ab77f" opacity="0.85" />
        <rect x="444" y="318" width="64" height="238" fill="url(#bk-silo)" />
        <path d="M444 556h64l-20 48h-24z" fill="#12684a" />
        <g stroke="#04241a" strokeWidth="3" opacity="0.3">
          <path d="M444 356h64M444 398h64M444 440h64M444 482h64" />
        </g>
        <g fill="#0a3323" opacity="0.5">
          <rect x="456" y="332" width="16" height="14" />
          <rect x="480" y="332" width="16" height="14" />
        </g>
      </g>

      {/* 右岸·收：磅台、抬起的道闸、一辆堆尖粮的运粮车 */}
      <g>
        <ellipse cx="1100" cy="672" rx="250" ry="20" fill="#04201a" opacity="0.35" />
        <rect x="880" y="655" width="440" height="22" rx="3" fill="url(#bk-gold)" opacity="0.85" />
        <rect x="940" y="677" width="34" height="30" fill="#05241a" />
        <rect x="1236" y="677" width="34" height="30" fill="#05241a" />
        {/* 道闸：抬起在磅台进口 */}
        <rect x="856" y="600" width="20" height="56" rx="2" fill="#12684a" />
        <path d="M866 604l6-84 14 1-6 83z" fill="#d8efe2" opacity="0.9" />
        <g fill="#0a4531" opacity="0.75">
          <rect x="872" y="540" width="14" height="9" transform="rotate(4 872 540)" />
          <rect x="870" y="566" width="14" height="9" transform="rotate(4 870 566)" />
          <rect x="868" y="592" width="14" height="9" transform="rotate(4 868 592)" />
        </g>
        {/* 车：粮堆 → 车厢 → 底盘 → 驾驶室 → 轮 */}
        <path d="M952 546q138-152 268 0z" fill="url(#bk-gold)" opacity="0.95" />
        <rect x="946" y="546" width="284" height="58" rx="6" fill="#1f9163" />
        <g stroke="#0a4531" strokeWidth="3" opacity="0.4">
          <path d="M1016 546v58M1088 546v58M1160 546v58" />
        </g>
        <rect x="946" y="600" width="330" height="12" fill="#0a3323" />
        <path d="M1226 560h44l26 40v12h-70z" fill="#54d69b" />
        <rect x="1236" y="572" width="34" height="18" rx="2" fill="#0a3323" opacity="0.55" />
        <g fill="#05241a">
          <circle cx="1000" cy="629" r="26" />
          <circle cx="1058" cy="629" r="26" />
          <circle cx="1160" cy="629" r="26" />
          <circle cx="1244" cy="629" r="26" />
        </g>
        <g fill="#54d69b">
          <circle cx="1000" cy="629" r="9" />
          <circle cx="1058" cy="629" r="9" />
          <circle cx="1160" cy="629" r="9" />
          <circle cx="1244" cy="629" r="9" />
        </g>
      </g>

      {/* 磅房：紧挨磅台右端头，窗里亮着灯 */}
      <g>
        <path d="M1318 560l58-38 58 38z" fill="#54d69b" opacity="0.9" />
        <rect x="1330" y="560" width="92" height="95" fill="#12684a" />
        <rect x="1348" y="586" width="34" height="30" fill="url(#bk-gold)" opacity="0.92" />
        <rect x="1392" y="606" width="22" height="49" fill="#0a3323" opacity="0.6" />
      </g>

      {/* 高杆灯：立在磅台出口一侧，灯头三盏 */}
      <g>
        <path d="M1300 706V404" stroke="#0a4531" strokeWidth="9" />
        <path d="M1300 470v-66" stroke="#12684a" strokeWidth="14" />
        <rect x="1262" y="386" width="76" height="18" rx="4" fill="#12684a" />
        <g fill="url(#bk-gold)">
          <rect x="1268" y="404" width="16" height="9" rx="2" />
          <rect x="1292" y="404" width="16" height="9" rx="2" />
          <rect x="1316" y="404" width="16" height="9" rx="2" />
        </g>
      </g>

      {/* 前景田：压暗的下沿，把整幅画"托"住 */}
      <path d="M0 700c240-42 520 22 760-2 240-24 480 22 680-10v212H0z" fill="url(#bk-field)" />
      <g fill="none" stroke="#54d69b" strokeWidth="2" opacity="0.1">
        <path d="M0 742c260-34 560 20 820-6 220-22 420 12 620-14M0 790c300-30 620 24 900-4 200-22 380 8 540-10" />
      </g>
      {/* 场院上的行车标线，从卡片底下穿向磅台 */}
      <path d="M470 880l280-140" stroke="#d8efe2" strokeWidth="6" strokeDasharray="46 34" opacity="0.1" fill="none" />

      {/* 近景压暗：先把底部垫深，后面的粮囤、袋垛、人才是"亮着立在前景上"，而不是被糊住 */}
      <rect x="0" y="740" width="1440" height="160" fill="url(#bk-vignette)" />

      {/* 露天粮囤：两堆苫着的圆囤，粮站最典型的场院景观 */}
      <g>
        <path d="M158 706q62-96 124 0z" fill="url(#bk-pile)" />
        <path d="M170 690q50-58 100 0" fill="none" stroke="#ffe3a0" strokeWidth="4" opacity="0.35" />
        <path d="M282 716q52-80 104 0z" fill="url(#bk-pile)" opacity="0.9" />
        <path d="M292 702q42-48 84 0" fill="none" stroke="#ffe3a0" strokeWidth="4" opacity="0.3" />
      </g>

      {/* 编织袋垛：码好的成品粮，靠右下角 */}
      <g fill="url(#bk-pile)">
        <use href="#bk-sack" x="1298" y="782" />
        <use href="#bk-sack" x="1366" y="782" />
        <use href="#bk-sack" x="1330" y="758" />
        <use href="#bk-sack" x="1398" y="758" />
        <use href="#bk-sack" x="1364" y="734" />
      </g>
      <g stroke="#04201a" strokeWidth="2" opacity="0.35" fill="none">
        <path d="M1298 793h130M1330 769h130M1364 745h62" />
      </g>

      {/* 人：磅员在磅房门口迎车，司机在磅台边等着看数 */}
      <g fill="#05241a">
        <circle cx="1244" cy="712" r="11" />
        <path d="M1233 726h22l6 46h-10l-4-24-4 24h-10z" />
        <circle cx="1420" cy="654" r="10" />
        <path d="M1410 666h20l5 42h-9l-3-22-4 22h-9z" />
      </g>
      <g fill="#f2be57" opacity="0.9">
        <rect x="1234" y="730" width="20" height="14" rx="2" />
        <rect x="1411" y="670" width="18" height="13" rx="2" />
      </g>

      {/* 刚过完磅的农用三轮：一斗粮、一个开车人，正从场院驶离 */}
      <g>
        <path d="M1006 728q58-46 116 0z" fill="url(#bk-gold)" opacity="0.95" />
        <rect x="1000" y="728" width="130" height="30" rx="4" fill="#1f9163" />
        <path d="M1130 714h26l16 26v18h-42z" fill="#54d69b" />
        <rect x="1136" y="722" width="18" height="12" rx="2" fill="#0a3323" opacity="0.55" />
        <circle cx="1146" cy="706" r="10" fill="#05241a" />
        <path d="M1136 718h20l4 22h-9l-3-12-4 12h-8z" fill="#05241a" />
        <g fill="#05241a">
          <circle cx="1030" cy="770" r="20" />
          <circle cx="1104" cy="770" r="20" />
          <circle cx="1160" cy="774" r="14" />
        </g>
        <g fill="#54d69b">
          <circle cx="1030" cy="770" r="7" />
          <circle cx="1104" cy="770" r="7" />
          <circle cx="1160" cy="774" r="5" />
        </g>
      </g>

      {/* 麦穗：左密右疏，压在画面最前一层的下沿两角（右岸两支刻意落到袋垛之前，避免从垛缝里长出来） */}
      <use href="#bk-wheat" transform="translate(30 726) rotate(-18) scale(6.2)" />
      <use href="#bk-wheat" transform="translate(96 636) rotate(-8) scale(5.4)" />
      <use href="#bk-wheat" transform="translate(410 786) rotate(9) scale(3.6)" />
      <use href="#bk-wheat" transform="translate(1276 796) rotate(-9) scale(5.4)" />
      <use href="#bk-wheat" transform="translate(1408 828) rotate(7) scale(4.6)" />
    </svg>
  );
}
