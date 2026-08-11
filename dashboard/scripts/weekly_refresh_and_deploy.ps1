# Runs from the Windows Scheduled Task "AmoremallDashboardWeeklyRefresh", every
# Friday 17:00. Re-pulls the sheet into the local data.json (scripts/export_agg.py),
# then deploys it to production - `vercel --prod` uploads the CURRENT LOCAL DISK
# contents directly (data.json is gitignored, so this is the only path that ever
# ships a refreshed data.json; a plain `git push` would not include it).
# Code changes are never touched here - this only ever redeploys whatever the repo's
# last human-reviewed commit already has, with a freshly pulled data.json on top.
#
# Uses Start-Process with explicit -RedirectStandardOutput/-Error (not `&` / pipes) -
# under Task Scheduler, a console subprocess launched via `&` has no console to
# attach to and can take the whole parent PowerShell process down with it; routing
# through .NET's Process class via Start-Process sidesteps that entirely.

$dashDir = "c:\Users\wisebirds\Desktop\claude\dashboard"
$logDir = Join-Path $dashDir "scripts"
$logFile = Join-Path $logDir "weekly_refresh.log"
$pythonExe = "C:\Users\wisebirds\AppData\Local\Programs\Python\Python313\python.exe"
$npxCmd = "C:\Program Files\nodejs\npx.cmd"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -Append -FilePath $logFile -Encoding utf8
}

function Run-Step($exe, $argList, $stepName) {
    $outFile = Join-Path $logDir "$stepName.stdout.log"
    $errFile = Join-Path $logDir "$stepName.stderr.log"
    $p = Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $dashDir `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    if (Test-Path $outFile) { Get-Content $outFile -Raw -ErrorAction SilentlyContinue | Out-File -Append -FilePath $logFile -Encoding utf8; Remove-Item $outFile -ErrorAction SilentlyContinue }
    if (Test-Path $errFile) { Get-Content $errFile -Raw -ErrorAction SilentlyContinue | Out-File -Append -FilePath $logFile -Encoding utf8; Remove-Item $errFile -ErrorAction SilentlyContinue }
    return $p.ExitCode
}

Log "===== Weekly refresh+deploy starting ====="

Log "Running export_agg.py..."
$exportExit = Run-Step $pythonExe @("scripts\export_agg.py") "export"
Log "export_agg.py exit code: $exportExit"

if ($exportExit -ne 0) {
    Log "Aborting - NOT deploying stale/missing data.json"
    exit 1
}

Log "Deploying to Vercel production..."
$deployExit = Run-Step $npxCmd @("vercel", "--prod", "--yes") "deploy"
Log "vercel --prod exit code: $deployExit"

if ($deployExit -ne 0) {
    Log "Deploy FAILED"
    exit 1
}

Log "===== Weekly refresh+deploy finished successfully ====="
