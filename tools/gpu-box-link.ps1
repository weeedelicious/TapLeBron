# 给 4090 worker 机（172.26.166.238）装上本机的 SSH 公钥，之后就用密钥登录、不再需要密码。
#
# 密码只走参数传入，不写进这个文件、也不写进任何配置。用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\gpu-box-link.ps1 -Password '<密码>'
#
# 为什么要装公钥：这台机是 Windows，本机 Git Bash 没有 sshpass，非交互 shell 下没法喂密码。
# 装一行公钥之后 ssh/scp 都能非交互跑，也就能同步 worker 代码并重启它。
# 撤销办法：删掉 .238 上 authorized_keys / administrators_authorized_keys 里那一行即可。

param(
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$Target = '172.26.166.238',
  [string]$User = 'User'
)

$ErrorActionPreference = 'Continue'

$pubKeyPath = Join-Path $env:USERPROFILE '.ssh\id_ed25519.pub'
if (-not (Test-Path $pubKeyPath)) { throw "找不到本机公钥: $pubKeyPath" }
$pubKey = (Get-Content $pubKeyPath -Raw).Trim()

$cShare = '\\' + $Target + '\C$'

# 先试直接访问：这台机上通常已经有一个到 sd_output 的活动 SMB 会话，Windows 对同一主机
# 会复用那份凭据。能直接读就别再建新连接 —— 用不同用户对同一服务器建第二个连接会拿
# 系统错误 1219，而唯一的解法是断掉已有那个，那可能正是用户在用的挂载。
Write-Output "--- 先试复用已有会话: $cShare"
$connected = $null
$reused = $false
if (Test-Path $cShare) {
  Write-Output '可直接读取，复用已有会话'
  $connected = $cShare
  $reused = $true
} else {
  Write-Output '不可直接读取，尝试用给定凭据建连接'
  $out = & net use $cShare /user:"$Target\$User" $Password 2>&1 | Out-String
  Write-Output ($out.Trim())
  if ($LASTEXITCODE -eq 0) { $connected = $cShare }
}

if (-not $connected) {
  Write-Output '=== SMB 全部失败。下面只报端口与共享列表，供判断走哪条路 ==='
  & net view "\\$Target" 2>&1 | Out-String | Write-Output
  exit 2
}

Write-Output "=== 已连上 $connected"

$cRoot = "\\$Target\C`$"
if (-not (Test-Path $cRoot)) {
  Write-Output 'C$ 不可读（可能只连上了 IPC$）。无法写入公钥。'
  exit 3
}

Write-Output '--- C:\Users'
Get-ChildItem "$cRoot\Users" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name | Write-Output
Write-Output '--- C:\Shotflow'
Get-ChildItem "$cRoot\Shotflow" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name | Write-Output

# 两个位置都写：Windows OpenSSH 对 Administrators 组成员用的是
# ProgramData\ssh\administrators_authorized_keys，会忽略用户目录下那份。
# 不确定 User 是不是管理员，所以两处都放，多的那份无害。
$targets = @(
  @{ Dir = "$cRoot\Users\$User\.ssh"; File = 'authorized_keys' },
  @{ Dir = "$cRoot\ProgramData\ssh"; File = 'administrators_authorized_keys' }
)

foreach ($t in $targets) {
  try {
    if (-not (Test-Path $t.Dir)) { New-Item -ItemType Directory -Force -Path $t.Dir | Out-Null }
    $path = Join-Path $t.Dir $t.File
    $existing = ''
    if (Test-Path $path) { $existing = Get-Content $path -Raw }
    if ($existing -like "*$pubKey*") {
      Write-Output "已存在，跳过: $path"
    } else {
      # ASCII 且不带 BOM —— sshd 对 authorized_keys 里的 BOM 不容忍
      $lines = @()
      if ($existing.Trim()) { $lines += $existing.TrimEnd() }
      $lines += $pubKey
      [System.IO.File]::WriteAllText($path, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.ASCIIEncoding))
      Write-Output "已写入: $path"
    }
  } catch {
    Write-Output ("写入失败 {0}: {1}" -f $t.Dir, $_.Exception.Message)
  }
}

if (-not $reused) { & net use $connected /delete /y 2>&1 | Out-Null }
Write-Output '=== 已断开 SMB 连接'
