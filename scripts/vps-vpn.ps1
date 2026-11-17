# perimeter: VPN до VPS только для perimeter — раздельный туннель AmneziaWG (клиент AmneziaWG для Windows).
# Зачем: исходящий TCP с VPS режется (ssh тянет 2–60 КБ/с с остановками), а UDP идёт ~1 МБ/с;
# внутри AmneziaWG (UDP) ssh-туннель perimeter до 10.13.13.1 работает на полной скорости.
# Через туннель идут только адреса 10.13.13.x — остальной интернет как был.
#
# Запуск: pwsh -ExecutionPolicy Bypass -File scripts\vps-vpn.ps1
#   первый раз скачает конфиг клиента «pc» с VPS в %USERPROFILE%\.perimeter-client\vps-awg.conf,
#   потом запросит права администратора и поставит туннель службой AmneziaWG (переживает перезагрузку).
#   Выключить: pwsh -File scripts\vps-vpn.ps1 -Off
# Нужен клиент AmneziaWG (github.com/amnezia-vpn/amneziawg-windows-client). WireSock 1.4 не умеет маскировку
# AmneziaWG этого сервера (S1/S2/H1–H4): шлёт обычное рукопожатие WireGuard, сервер его не принимает (проверено 2026-11-11).
param(
  [string]$Server = 'root@198.12.84.32',
  [string]$Peer = 'pc',
  [switch]$Refresh,
  [switch]$Off
)
$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:USERPROFILE '.perimeter-client'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$conf = Join-Path $dir 'vps-awg.conf'

if (-not $Off -and ($Refresh -or -not (Test-Path $conf))) {
  Write-Host "Скачиваю конфиг VPN «$Peer» с $Server…"
  $raw = & ssh -o ConnectTimeout=30 $Server "cat /etc/amnezia/amneziawg/clients/$Peer.conf"
  if ($LASTEXITCODE -ne 0 -or -not $raw) { throw "не удалось скачать /etc/amnezia/amneziawg/clients/$Peer.conf" }
  $text = ($raw -join "`n") + "`n"
  if ($text -notmatch '\[Interface\]' -or $text -notmatch '\[Peer\]') { throw 'скачанный файл не похож на конфиг WireGuard/AmneziaWG' }
  # раздельный туннель: только сеть VPN; DNS компьютера не трогаем
  $text = $text -replace '(?m)^DNS\s*=.*\n', ''
  $text = $text -replace '(?m)^AllowedIPs\s*=.*$', 'AllowedIPs = 10.13.13.0/24'
  $text = "# perimeter: VPN только до VPS (раздельный туннель), сделан scripts/vps-vpn.ps1`n" + $text
  [IO.File]::WriteAllText($conf, $text, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Конфиг: $conf"
}
# ключ VPN — только владельцу файла и службе туннеля (она работает от SYSTEM: без чтения служба не стартует)
if (Test-Path $conf) { icacls $conf /inheritance:r /grant:r "$($env:USERNAME):F" 'SYSTEM:R' | Out-Null }

$awg = 'C:\Program Files\AmneziaWG\amneziawg.exe'
if (-not (Test-Path $awg)) {
  throw "не найден $awg — поставьте клиент AmneziaWG: https://github.com/amnezia-vpn/amneziawg-windows-client/releases (amneziawg-amd64-*.msi)"
}
$name = [IO.Path]::GetFileNameWithoutExtension($conf)
if ($Off) {
  Write-Host 'Удаляю VPN (Windows спросит права администратора)…'
  Start-Process -FilePath $awg -ArgumentList @('/uninstalltunnelservice', $name) -Verb RunAs -Wait
  Start-Sleep -Seconds 2
  if (Get-Service -Name "AmneziaWGTunnel`$$name" -ErrorAction SilentlyContinue) { throw 'служба туннеля осталась — запрос прав администратора отменён?' }
  # конфиг с ключом VPN больше не нужен; снова включить — запуск без -Off скачает его заново
  if (Test-Path $conf) { Remove-Item -Force $conf }
  Write-Host 'VPN удалён: служба туннеля и конфиг с ключом.'
  return
}
Write-Host 'Включаю VPN (Windows спросит права администратора)…'
if (Get-Service -Name "AmneziaWGTunnel`$$name" -ErrorAction SilentlyContinue) {
  # служба уже поставлена (прошлый запуск) — просто запустить
  Start-Process -FilePath 'sc.exe' -ArgumentList @('start', "AmneziaWGTunnel`$$name") -Verb RunAs -Wait
} else {
  Start-Process -FilePath $awg -ArgumentList @('/installtunnelservice', "`"$conf`"") -Verb RunAs -Wait
}
Start-Sleep -Seconds 3
$svc = Get-Service -Name "AmneziaWGTunnel`$$name" -ErrorAction SilentlyContinue
if (-not $svc -or $svc.Status -ne 'Running') { throw "служба туннеля не запустилась (состояние: $($svc.Status)) — смотрите журнал в приложении AmneziaWG" }
Write-Host 'Готово: VPS доступен как 10.13.13.1 (туннель — служба AmneziaWG, переживает перезагрузку).'
