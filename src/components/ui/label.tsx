"use client"

import * as React from "react"
import { cn } from "cn"

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        // 横排标签需要垂直居中；但调用方普遍的 `flex flex-col` 竖排写法下，align-items 会变成水平轴，
        // 会把标题文字推到中间，所以竖排一律靠左。
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 [&.flex-col]:items-start",
        className
      )}
      {...props}
    />
  )
}

export { Label }
