# 构建 Microsoft Store 用的 MSIX 产物（store-build 变体）。CI 与本地同一入口：
#   1) 先 `npx tauri build --no-bundle --features store-build` 出前端内嵌的 release exe
#      （或直接用 `npm run build:store` 之外的手工路径；本脚本不触发编译，只校验 exe 存在）；
#   2) 在仓库根目录跑 `./scripts/msix/build-msix.ps1` —— 组清单、MakeAppx 打包、解包探针。
#
# 设计（与仓库既有口径一致）：
#   - Tauri CLI 不出 MSIX（bundles 只认 nsis/msi），清单在这里单源组装。身份三值
#     经环境变量注入（Partner Center「Product identity」页原样复制，一个字符不许差）：
#       MSSTORE_PACKAGE_IDENTITY_NAME / MSSTORE_PUBLISHER / MSSTORE_PUBLISHER_DISPLAY_NAME
#     未配置时用本地测试身份打**冒烟包**——只验管线回归，不得上传商店；release.yml
#     按身份是否配置来门控产物上传。
#   - 上传的是不签名裸包：Partner Center 审核后由微软代签，这条路线不买代码签名证书。
#   - 包内布局与 NSIS 的资源映射对齐：exe 与 `sdtapi/` 同级（idcard.rs 的候选路径
#     就含这一种）。清单里 <Properties> 子元素顺序严格 DisplayName → PublisherDisplayName
#     → Logo，错序 MakeAppx 会报 C00CEE3B 且信息是乱码；文件按 UTF-8 **带 BOM** 写出，
#     防 PowerShell 5.1 在中文 Windows 上按 GBK 误读吞掉闭合标签。
#   - 打完包立刻 unpack，并在**包内 exe** 上跑 `banghe.exe --update-channel` 断言回值
#     为 store——MSIX 产物层面的 store-build 生效证明（装内 updater 没接线）。
param(
  [string]$Exe = "",
  [string]$OutDir = "release",
  [string]$MakeAppx = ""
)
$ErrorActionPreference = "Stop"

# 一切路径以仓库根为基准（脚本可以从任何 cwd 调用）
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $Exe) { $Exe = Join-Path $root "src-tauri/target/release/banghe.exe" }
if (-not (Test-Path $Exe)) {
  throw "未找到 $Exe —— 先跑 npx tauri build --no-bundle --features store-build（或 npm run build:store）"
}

# tauri.conf.json 是版本与产品名的单源（含中文，必须显式按 UTF-8 读）
$conf = [System.IO.File]::ReadAllText((Join-Path $root "src-tauri/tauri.conf.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$semver = $conf.version           # x.y.z（schema_contract 已保证三段）
$pkgVer = "$semver.0"             # MSIX 清单吃四段 a.b.c.0
$displayName = $conf.productName

# 商店身份：三个值同时有才算真身份，否则退回测试身份（调用方按 vars 门控上传）
$name = $env:MSSTORE_PACKAGE_IDENTITY_NAME
$publisher = $env:MSSTORE_PUBLISHER
$pubDisplay = $env:MSSTORE_PUBLISHER_DISPLAY_NAME
$identityReal = [bool]($name -and $publisher -and $pubDisplay)
if (-not $identityReal) {
  $name = "BangheMSIXTest"; $publisher = "CN=BangheLocalTest"; $pubDisplay = "BangheLocalTest"
  Write-Warning "MSSTORE_* 身份三值未配齐——以本地测试身份打冒烟包，此包不得上传 Partner Center"
}

# makeappx.exe：GitHub windows runner 自带 Windows SDK；本机没有时从 NuGet 取
# Microsoft.Windows.SDK.BuildTools 解出，用 -MakeAppx 指路径。
if (-not $MakeAppx) {
  $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path $kits) {
    $cand = Get-ChildItem $kits -Recurse -Filter "makeappx.exe" |
      Where-Object { $_.FullName -match "\\x64\\" } |
      Sort-Object FullName -Descending | Select-Object -First 1
    if ($cand) { $MakeAppx = $cand.FullName }
  }
}
if (-not $MakeAppx -or -not (Test-Path $MakeAppx)) {
  throw "没找到 makeappx.exe：CI runner 应自带 Windows SDK；本地无 SDK 时装 Windows 10 SDK，或从 NuGet 下载 Microsoft.Windows.SDK.BuildTools 解压后用 -MakeAppx 传入路径"
}

# ---- 暂存目录：exe + sdtapi 资源 + 商店图标 + 清单 --------------------------------
$stage = Join-Path $root "src-tauri/target/msix-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage "Assets") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage "sdtapi") | Out-Null

Copy-Item $Exe (Join-Path $stage "banghe.exe")
foreach ($f in @("Sdtapi.dll", "Dewlt.dll", "SavePhoto.dll", "routon.ini")) {
  Copy-Item (Join-Path $root "src-tauri/resources/sdtapi/$f") (Join-Path $stage "sdtapi/$f")
}
foreach ($icon in @("Square44x44Logo.png", "Square150x150Logo.png", "StoreLogo.png")) {
  $p = Join-Path $root "src-tauri/icons/$icon"
  if (-not (Test-Path $p)) { throw "缺少商店图标 $p —— 用 `npx tauri icon` 重新生成" }
  Copy-Item $p (Join-Path $stage "Assets/$icon")
}

$manifestTemplate = @'
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">
  <Identity Name="{{NAME}}" Publisher="{{PUBLISHER}}" Version="{{VERSION}}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>{{DISPLAY_NAME}}</DisplayName>
    <PublisherDisplayName>{{PUBLISHER_DISPLAY}}</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="zh-CN" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
  <Applications>
    <Application Id="banghe" Executable="banghe.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="{{DISPLAY_NAME}}" Description="{{DESCRIPTION}}" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png" BackgroundColor="transparent" />
    </Application>
  </Applications>
</Package>
'@
# Description 不吃中文长句以外来字符——清单属性里 XML 转义麻烦，商店文案以 Partner Center 为准，这里给 ASCII 短句
$manifest = $manifestTemplate.Replace("{{NAME}}", $name).Replace("{{PUBLISHER}}", $publisher).
  Replace("{{PUBLISHER_DISPLAY}}", $pubDisplay).Replace("{{VERSION}}", $pkgVer).
  Replace("{{DISPLAY_NAME}}", $displayName).Replace("{{DESCRIPTION}}", "Grain station weighing system")
[System.IO.File]::WriteAllText((Join-Path $stage "AppxManifest.xml"), $manifest, (New-Object System.Text.UTF8Encoding($true)))

# ---- 打包（不签名：商店代签）------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Join-Path $root $OutDir) | Out-Null
$msix = Join-Path $root (Join-Path $OutDir "banghe-$semver-windows-x64-store.msix")
if (Test-Path $msix) { Remove-Item $msix -Force }
& $MakeAppx pack /d $stage /p $msix /l | Out-Host
if ($LASTEXITCODE -ne 0) { throw "makeappx pack 失败（exit $LASTEXITCODE）" }
$sizeMB = [math]::Round((Get-Item $msix).Length / 1MB, 1)
if ($sizeMB -lt 1 -or $sizeMB -gt 60) { throw "MSIX 体积异常（$sizeMB MB）——检查 exe 是否编错特性/夹带" }

# ---- 解包探针：包内 exe 断言 store-build 生效 --------------------------------------
$verify = Join-Path $root "src-tauri/target/msix-verify"
if (Test-Path $verify) { Remove-Item $verify -Recurse -Force }
New-Item -ItemType Directory -Force -Path $verify | Out-Null
& $MakeAppx unpack /p $msix /d $verify /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makeappx unpack 失败（exit $LASTEXITCODE）——打出来的包自己都不吃，商店更不会收" }
# 带 windows_subsystem 的 exe 不会自己挂控制台：Start-Process -Wait + 重定向拿 stdout
$stdout = Join-Path $env:TEMP ("bh-channel-" + [guid]::NewGuid().ToString("N") + ".txt")
Start-Process -FilePath (Join-Path $verify "banghe.exe") -ArgumentList "--update-channel" `
  -Wait -NoNewWindow -RedirectStandardOutput $stdout | Out-Null
$channel = (Get-Content $stdout -Raw).Trim()
Remove-Item $stdout -Force -ErrorAction SilentlyContinue
if ($channel -ne "store") { throw "包内 exe 回值 '$channel'，期望 'store'——store-build 没编进这个二进制" }

Write-Host ""
Write-Host "MSIX 完成: $msix ($sizeMB MB)"
Write-Host "  Identity: $name / $publisher$(if (-not $identityReal) { '  [TEST 身份——冒烟产物，勿上传商店]' })"
Write-Host "  版本: $pkgVer   探针: 包内 banghe.exe --update-channel = store ✔"
