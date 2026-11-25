# Connects QA Report for Jira to the claude / codex CLI on this Windows computer, for "Fill with AI".
# Usage in PowerShell (the extension shows this line with your extension id filled in):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/stokrattt/qa-report-for-jira/main/native-host/install.ps1))) <extension-id>
param([Parameter(Mandatory = $true)][string]$ExtensionId)
$ErrorActionPreference = 'Stop'

$Name = 'com.stokrattt.qa_report_for_jira'
$HostUrl = 'https://raw.githubusercontent.com/stokrattt/qa-report-for-jira/main/native-host/host.mjs'
$AppDir = Join-Path $env:LOCALAPPDATA 'qa-report-for-jira'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Host 'Node.js is not installed. Install it from https://nodejs.org, then run this command again.' -ForegroundColor Red
    return
}
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

# Run from a checkout: use the local host.mjs. Piped from irm: download it.
$local = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'host.mjs' } else { '' }
if ($local -and (Test-Path $local)) {
    Copy-Item $local (Join-Path $AppDir 'host.mjs') -Force
} else {
    Invoke-WebRequest $HostUrl -OutFile (Join-Path $AppDir 'host.mjs') -UseBasicParsing
}

# Chrome needs a .bat or .exe as the host; the wrapper carries this shell's PATH, where claude / codex are found.
$bat = "@echo off`r`nset `"PATH=$env:PATH`"`r`n`"$node`" `"%~dp0host.mjs`"`r`n"
[IO.File]::WriteAllText((Join-Path $AppDir 'host.bat'), $bat)

# Written without a BOM: Chrome rejects a manifest that starts with one.
$manifestPath = Join-Path $AppDir "$Name.json"
$manifest = [ordered]@{
    name            = $Name
    description     = 'QA Report for Jira: local claude / codex CLI bridge'
    path            = (Join-Path $AppDir 'host.bat')
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $manifest)

# On Windows Chrome finds the manifest through this registry key's default value.
New-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$Name" -Value $manifestPath -Force | Out-Null

Write-Host "Connected. Files: $AppDir"
foreach ($bin in 'claude', 'codex') {
    $found = (Get-Command $bin -ErrorAction SilentlyContinue).Source
    if ($found) { Write-Host "  found ${bin}: $found" } else { Write-Host "  ${bin}: not found" }
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and -not (Get-Command codex -ErrorAction SilentlyContinue)) {
    Write-Host 'Neither claude nor codex is installed. Install one, log in once, then run this command again:' -ForegroundColor Yellow
    Write-Host '  Claude Code: npm i -g @anthropic-ai/claude-code; claude'
    Write-Host '  Codex:       npm i -g @openai/codex; codex login'
}
Write-Host 'Go back to the report and click Fill with AI again.'
