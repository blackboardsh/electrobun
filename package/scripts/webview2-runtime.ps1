param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Download', 'Signature')]
    [string]$Operation,
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($Operation -eq 'Download') {
    # Microsoft's Evergreen bootstrapper selects the machine architecture.
    # https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $InstallerPath -TimeoutSec 55
} else {
    $signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
    @{ status = [string]$signature.Status; subject = $signature.SignerCertificate.Subject } | ConvertTo-Json -Compress
}
