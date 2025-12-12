Param(
    [switch]$Quiet
)

function Ensure-RunningAsAdmin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($current)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host "Requesting elevation..."
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell'
        $args = @('-ExecutionPolicy','Bypass','-NoProfile','-File', $MyInvocation.MyCommand.Path)
        if ($Quiet) { $args += '-Quiet' }
        $psi.Arguments = $args -join ' '
        $psi.Verb = 'runas'
        try {
            [System.Diagnostics.Process]::Start($psi) | Out-Null
            exit
        } catch {
            Write-Error "Elevation requested but was cancelled. Please run this script as Administrator."
            exit 1
        }
    }
}

function Download-File($url, $outPath) {
    Write-Host "Downloading $url to $outPath"
    try {
        Invoke-WebRequest -Uri $url -OutFile $outPath -UseBasicParsing -ErrorAction Stop
        return $true
    } catch {
        Write-Error "Download failed: $_"
        return $false
    }
}

Ensure-RunningAsAdmin

$temp = [IO.Path]::GetTempPath()
$vsInstaller = Join-Path $temp 'vs_BuildTools.exe'
$vsUrl = 'https://aka.ms/vs/17/release/vs_BuildTools.exe'

if (-not (Test-Path $vsInstaller)) {
    if (-not (Download-File $vsUrl $vsInstaller)) {
        Write-Error "Failed to download Visual Studio Build Tools. Please download manually from https://visualstudio.microsoft.com/downloads/"
        exit 1
    }
}

if ($Quiet) {
    Write-Host "Installing Visual Studio Build Tools (quiet). This may take some time..."
    $args = @(
        '--add', 'Microsoft.VisualStudio.Workload.VCTools',
        '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '--add', 'Microsoft.VisualStudio.Component.Windows10SDK.19041',
        '--includeRecommended',
        '--quiet',
        '--wait',
        '--norestart'
    )
    & $vsInstaller $args
} else {
    Write-Host "Launching Visual Studio Build Tools installer GUI. Please select 'Desktop development with C++' and install."
    Start-Process -FilePath $vsInstaller -Wait
}

# Install CMake via winget if available
if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Installing CMake via winget..."
    try {
        winget install --id Kitware.CMake -e --accept-package-agreements --accept-source-agreements
    } catch {
        Write-Warning "winget install failed or was interrupted. Please install CMake from https://cmake.org/download/"
    }
} else {
    Write-Host "winget not found. Please install CMake manually from https://cmake.org/download/ or install winget and re-run this script."
}

Write-Host "Installation steps finished. Please restart your shell (or log out/in) and re-run the build script if necessary."
Exit 0
