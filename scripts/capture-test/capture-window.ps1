<#
.SYNOPSIS
  用 Win32 那几种"走 DWM 合成管线"的方法抓 Offer Hunter 的窗口，给出每种的判定。
  改前跑一次、改后再跑一次，对比判定即可。

.DESCRIPTION
  三种方法：
    M1 screen-bitblt   对桌面 DC 做 BitBlt（SRCCOPY|CAPTUREBLT），按窗口矩形裁剪。
    M2 printwindow-0   PrintWindow(hwnd, dc, 0)
    M3 printwindow-2   PrintWindow(hwnd, dc, 2) —— PW_RENDERFULLCONTENT，历史上最爱漏的那个。

  同时打印 GetWindowDisplayAffinity(hwnd)，直接读出应用实际用的 WDA 标志：
    0x00000000 WDA_NONE  什么都没设
    0x00000001 WDA_MONITOR            捕获时窗口是"黑块"（Electron 文档口径）
    0x00000011 WDA_EXCLUDEFROMCAPTURE 捕获时窗口"根本不出现"

  判定怎么读（改前 / 改后对照）：
    M1 的结果 + affinity 读数 才是承重信号。
      affinity=1 且 M1 近全黑            -> 旧行为（黑块）
      affinity=0x11 且 M1 显示的是桌面    -> 新行为（窗口从捕获里消失）
    M2/M3 只作参考：Chromium 是 GPU 合成，PrintWindow 即使没有 WDA 也常返回全黑，
    所以"它黑"不能证明 WDA 起了作用。反过来，实测发现 PrintWindow(...,2)（PW_RENDERFULLCONTENT）
    对 GPU 合成的 Electron 窗口是能抓到内容的——所以 M3 若为 CONTENT 就是真漏点，值得盯。

  另一个坑：目标窗口是 transparent+无边框。WDA_EXCLUDEFROMCAPTURE 下窗口"消失"后，
  M1 抓到的会是窗口后面的桌面，同样"非黑"，跟"抓到了内容"看起来一样。要区分：
  以 DisplayAffinity 读数（0x11 = 已排除）为准，再肉眼比对 PNG 里是不是桌面壁纸。

  跑之前先把窗口显示出来（别处于 toggleVisibility 隐藏状态）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\capture-test\capture-window.ps1
  # 打包版（进程名不是 electron.exe）：
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\capture-test\capture-window.ps1 -ProcessName 'offer hunter'
#>
param(
    [string]$ProcessName = 'electron',
    [string]$TitleMatch = '',
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type -AssemblyName System.Drawing

$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Cap {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $cs

$SRCCOPY = 0x00CC0020
$CAPTUREBLT = 0x40000000

function Get-WindowTitle([IntPtr]$h) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][Cap]::GetWindowText($h, $sb, 512)
    return $sb.ToString()
}

function Get-WindowClass([IntPtr]$h) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][Cap]::GetClassName($h, $sb, 256)
    return $sb.ToString()
}

# ---- 找窗口：按进程名（+可选标题子串）匹配，多个时取面积最大的那个 ----
$script:candidates = New-Object System.Collections.ArrayList
$cb = [Cap+EnumWindowsProc] {
    param([IntPtr]$h, [IntPtr]$l)
    if (-not [Cap]::IsWindowVisible($h)) { return $true }
    $r = New-Object 'Cap+RECT'
    if (-not [Cap]::GetWindowRect($h, [ref]$r)) { return $true }
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -le 0 -or $hh -le 0) { return $true }
    [uint32]$procId = 0
    [void][Cap]::GetWindowThreadProcessId($h, [ref]$procId)
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $true }
    [void]$script:candidates.Add([pscustomobject]@{
        Hwnd = $h; Pid = $procId; Proc = $p.ProcessName; Title = (Get-WindowTitle $h);
        Class = (Get-WindowClass $h); Rect = $r; Area = $w * $hh
    })
    return $true
}
[void][Cap]::EnumWindows($cb, [IntPtr]::Zero)

$matches = @($script:candidates | Where-Object { $_.Proc -ieq $ProcessName })
if ($TitleMatch) { $matches = @($matches | Where-Object { $_.Title -like "*$TitleMatch*" }) }

if (-not $matches) {
    Write-Host "没找到窗口。当前可见顶层窗口里的进程名有：" -ForegroundColor Yellow
    $script:candidates | Sort-Object -Property Area -Descending |
        Select-Object -First 15 | ForEach-Object { Write-Host ("  {0,-28} {1}" -f $_.Proc, $_.Title) }
    Write-Host "用 -ProcessName 指定正确的进程名（打包版通常是 'offer hunter'）。" -ForegroundColor Yellow
    exit 2
}

$win = $matches | Sort-Object -Property Area -Descending | Select-Object -First 1
$r = $win.Rect
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top

$aff = [uint32]0
[void][Cap]::GetWindowDisplayAffinity($win.Hwnd, [ref]$aff)
$affName = switch ($aff) {
    0x0 { 'WDA_NONE' }
    0x1 { 'WDA_MONITOR' }
    0x11 { 'WDA_EXCLUDEFROMCAPTURE' }
    default { 'unknown' }
}

Write-Host ''
Write-Host "窗口: pid=$($win.Pid) proc=$($win.Proc) class=$($win.Class)" -ForegroundColor Cyan
Write-Host "标题: $($win.Title)"
Write-Host "矩形: L=$($r.Left) T=$($r.Top) W=$w H=$h"
Write-Host ("DisplayAffinity: 0x{0:X}  {1}" -f $aff, $affName) -ForegroundColor Green

# GWL_EXSTYLE (-20)。WS_EX_TOOLWINDOW 置位 = 不进 Alt-Tab；WS_EX_APPWINDOW 置位 = 强制进任务栏。
$ex = [uint32][Cap]::GetWindowLong($win.Hwnd, -20)
$exFlags = @()
if ($ex -band 0x00000080) { $exFlags += 'WS_EX_TOOLWINDOW' }
if ($ex -band 0x00040000) { $exFlags += 'WS_EX_APPWINDOW' }
if ($ex -band 0x00000008) { $exFlags += 'WS_EX_TOPMOST' }
if ($ex -band 0x00080000) { $exFlags += 'WS_EX_LAYERED' }
if (-not $exFlags) { $exFlags += '(none of the usual)' }
Write-Host ("ExStyle: 0x{0:X8}  {1}" -f $ex, ($exFlags -join ' ')) -ForegroundColor Green
Write-Host ''

function Measure-Blank([System.Drawing.Bitmap]$img) {
    $iw = $img.Width; $ih = $img.Height
    $sx = [Math]::Max(1, [int]($iw / 64)); $sy = [Math]::Max(1, [int]($ih / 64))
    $tot = 0; $dark = 0
    for ($y = 0; $y -lt $ih; $y += $sy) {
        for ($x = 0; $x -lt $iw; $x += $sx) {
            $c = $img.GetPixel($x, $y)
            $tot++
            if ($c.R -lt 16 -and $c.G -lt 16 -and $c.B -lt 16) { $dark++ }
        }
    }
    $mid = $img.GetPixel([int]($iw / 2), [int]($ih / 2))
    $pct = [Math]::Round(100 * $dark / $tot, 1)
    $verdict = if ($pct -ge 99) { 'BLACK (blocked)' } elseif ($pct -ge 90) { 'mostly black' } else { 'NON-BLACK' }
    return [pscustomobject]@{ Total = $tot; DarkPct = $pct; Verdict = $verdict; Center = ('{0},{1},{2}' -f $mid.R, $mid.G, $mid.B) }
}

function Save-And-Measure([IntPtr]$memDc, [IntPtr]$bmp, [string]$name, [string]$file) {
    $img = [System.Drawing.Image]::FromHbitmap($bmp)
    try {
        $bmpManaged = [System.Drawing.Bitmap]$img
        $m = Measure-Blank $bmpManaged
        $path = Join-Path $OutDir $file
        $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $img.Dispose()
    }
    $color = if ($m.Verdict -eq 'BLACK (blocked)') { 'Red' } else { 'Yellow' }
    Write-Host ("{0,-16} {1,-14} dark={2,5}%  center=({3})  -> {4}" -f $name, $file, $m.DarkPct, $m.Center, $m.Verdict) -ForegroundColor $color
    return $m
}

function New-CaptureSurface([int]$cw, [int]$ch) {
    $screenDc = [Cap]::GetDC([IntPtr]::Zero)
    $memDc = [Cap]::CreateCompatibleDC($screenDc)
    $bmp = [Cap]::CreateCompatibleBitmap($screenDc, $cw, $ch)
    $old = [Cap]::SelectObject($memDc, $bmp)
    return @{ ScreenDc = $screenDc; MemDc = $memDc; Bmp = $bmp; Old = $old }
}

function Free-CaptureSurface($s) {
    [void][Cap]::SelectObject($s.MemDc, $s.Old)
    [void][Cap]::DeleteObject($s.Bmp)
    [void][Cap]::DeleteDC($s.MemDc)
    [void][Cap]::ReleaseDC([IntPtr]::Zero, $s.ScreenDc)
}

$results = @()

# ---- M1: 桌面 BitBlt，按窗口矩形裁剪 ----
$s = New-CaptureSurface $w $h
[void][Cap]::BitBlt($s.MemDc, 0, 0, $w, $h, $s.ScreenDc, $r.Left, $r.Top, ($SRCCOPY -bor $CAPTUREBLT))
$results += Save-And-Measure $s.MemDc $s.Bmp 'M1 bitblt' 'm1-screen-bitblt.png'
Free-CaptureSurface $s

# ---- M2: PrintWindow flag 0 ----
$s = New-CaptureSurface $w $h
$ok = [Cap]::PrintWindow($win.Hwnd, $s.MemDc, 0)
$results += Save-And-Measure $s.MemDc $s.Bmp 'M2 pw-0' 'm2-printwindow-0.png'
Free-CaptureSurface $s
Write-Host "  (PrintWindow flag 0 returned $ok)"

# ---- M3: PrintWindow flag 2 (PW_RENDERFULLCONTENT) ----
$s = New-CaptureSurface $w $h
$ok = [Cap]::PrintWindow($win.Hwnd, $s.MemDc, 2)
$results += Save-And-Measure $s.MemDc $s.Bmp 'M3 pw-2' 'm3-printwindow-2.png'
Free-CaptureSurface $s
Write-Host "  (PrintWindow flag 2 returned $ok)"

Write-Host ''
Write-Host "PNG 已写入: $OutDir" -ForegroundColor Cyan

$m1 = $results[0]
Write-Host ''
Write-Host '判读：' -ForegroundColor Cyan
switch ($aff) {
    0x11 {
        Write-Host "  affinity=0x11 WDA_EXCLUDEFROMCAPTURE —— 窗口在捕获里'不出现'。"
        if ($m1.Verdict -ne 'BLACK (blocked)') {
            Write-Host "  M1 非黑不代表穿透：本应用是透明无边框，窗口被排除后 M1 抓到的是它后面的桌面。" -ForegroundColor Yellow
            Write-Host "  自检：真穿透会抓到应用那套近黑 UI（dark% 会很高），而这里是 dark=$($m1.DarkPct)%、中心像素=($($m1.Center))。" -ForegroundColor Yellow
        }
        Write-Host "  开 out/m1-screen-bitblt.png 目视一眼：是桌面壁纸=已排除，是应用界面=真漏。"
    }
    0x1 {
        Write-Host "  affinity=0x1 WDA_MONITOR —— 窗口在捕获里是'黑块'；M1 应为全黑。" -ForegroundColor Yellow
    }
    0x0 {
        Write-Host "  affinity=0x0 WDA_NONE —— 没有任何保护，M1/M3 抓到内容才是真实穿透。" -ForegroundColor Red
    }
}
